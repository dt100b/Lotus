"""Thread-safe Deribit option ticker WebSocket cache.

The cache deliberately uses only public JSON-RPC methods.  It bootstraps the
active option set with ``public/get_instruments``, subscribes by default to the
bandwidth-conscious public ``incremental_ticker.<instrument>`` channels, and
follows subsequent listings and terminations through
``instrument.state.option.<currency>``.  Full public
``ticker.<instrument>.100ms``/``agg2`` subscriptions remain configurable.
Consumers in sync FastAPI code can read immutable snapshots without touching
the network or the worker thread.

The production transport uses the maintained ``websockets`` client declared by
the project.  Tests inject a deterministic connection factory.
"""

from __future__ import annotations

from base64 import b64encode
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
import hashlib
import json
import math
import re
import secrets
import socket
import ssl
from threading import Condition, Event, Lock, RLock, Thread, current_thread
import time
from typing import Any, Callable, Mapping, Protocol, Sequence
from urllib.parse import urlsplit

import httpx
from websockets.sync.client import connect as websocket_connect


DERIBIT_WEBSOCKET_URL = "wss://www.deribit.com/ws/api/v2"
DERIBIT_INSTRUMENTS_URL = (
    "https://www.deribit.com/api/v2/public/get_instruments"
)
SOURCE_NAME = "deribit_ticker_ws"
DEFAULT_CHANNEL_INTERVAL = "100ms"
PUBLIC_CHANNEL_INTERVALS = frozenset({"100ms", "agg2"})
DEFAULT_CHANNEL_MODE = "incremental"
PUBLIC_CHANNEL_MODES = frozenset({"incremental", "ticker"})
MAX_CHANNELS_PER_REQUEST = 500
# Live BTC options routinely exceed 800 names.  A full-universe subscribe
# floods the socket, so production keeps a near-dated budget and pins any
# expiry the scanner actually requested.
DEFAULT_MAX_TICKER_SUBSCRIPTIONS = 400
DEFAULT_HEARTBEAT_SECONDS = 30
DEFAULT_STALE_AFTER_SECONDS = 10.0

_INSTRUMENT_RE = re.compile(
    r"^(?P<currency>[A-Z0-9]+)-(?P<expiry>\d{1,2}[A-Z]{3}\d{2})-"
    r"(?P<strike>\d+(?:\.\d+)?)-(?P<side>[CP])$",
    re.IGNORECASE,
)
_TERMINAL_INSTRUMENT_STATES = frozenset(
    {"closed", "settlement", "delivered", "inactive", "archivized", "terminated"}
)


class TickerStreamError(RuntimeError):
    """Raised for invalid configuration or a failed Deribit stream operation."""


class ConnectionState(str, Enum):
    STOPPED = "STOPPED"
    CONNECTING = "CONNECTING"
    CONNECTED = "CONNECTED"
    RECONNECTING = "RECONNECTING"
    CLOSING = "CLOSING"


class WebSocketConnection(Protocol):
    """Synchronous transport contract accepted by the worker."""

    def send(self, message: str) -> None: ...

    def recv(self, timeout_seconds: float) -> str | bytes | None: ...

    def close(self) -> None: ...


class InstrumentSource(Protocol):
    """Injected bootstrap source used by offline tests and alternate clients."""

    def __call__(self, *, currency: str) -> Sequence[Mapping[str, Any] | str]: ...


class WebSocketFactory(Protocol):
    def __call__(
        self, url: str, timeout_seconds: float
    ) -> WebSocketConnection: ...


@dataclass(frozen=True, slots=True)
class DeribitTickerQuote:
    """One normalized option ticker notification.

    ``quote_as_of`` comes exclusively from Deribit's ticker ``timestamp``.  It
    is never replaced with local receive time.
    """

    instrument_name: str
    quote_as_of: datetime
    state: str
    is_open: bool
    best_bid_price: float | None
    best_bid_amount: float | None
    best_ask_price: float | None
    best_ask_amount: float | None
    bid_iv: float | None
    ask_iv: float | None
    mark_iv: float | None
    mark_price: float | None
    index_price: float | None
    underlying_price: float | None
    estimated_delivery_price: float | None
    open_interest: float | None
    delta: float | None

    def as_scanner_row(self) -> dict[str, Any]:
        """Return the row shape consumed by the IV scanner normalizer."""

        parsed = _parse_option_instrument(self.instrument_name)
        expiry, strike, option_type = (
            (parsed[0], parsed[1], parsed[2])
            if parsed is not None
            else (None, None, None)
        )
        return {
            "expiry": expiry,
            "strike": strike,
            "option_type": option_type,
            "instrument_name": self.instrument_name,
            "quote_as_of": self.quote_as_of,
            "state": self.state,
            "is_open": self.is_open,
            "bid_price": self.best_bid_price,
            "bid_amount": self.best_bid_amount,
            "bid_size": self.best_bid_amount,
            "ask_price": self.best_ask_price,
            "ask_amount": self.best_ask_amount,
            "ask_size": self.best_ask_amount,
            "bid_iv": self.bid_iv,
            "ask_iv": self.ask_iv,
            "mark_iv": self.mark_iv,
            "mark_price": self.mark_price,
            "index_price": self.index_price,
            "underlying_price": self.underlying_price,
            "estimated_delivery_price": self.estimated_delivery_price,
            "open_interest": self.open_interest,
            "delta": self.delta,
        }


@dataclass(frozen=True, slots=True)
class TickerStreamStatus:
    connection_state: ConnectionState
    running: bool
    connected: bool
    healthy: bool
    warmup_complete: bool
    connection_generation: int
    universe_current: bool
    currency: str
    channel_mode: str
    channel_interval: str
    active_instrument_count: int
    subscribed_instrument_count: int
    quote_count: int
    initialized_quote_count: int
    retained_quote_count: int
    fresh_quote_count: int
    stale_quote_count: int
    oldest_quote_age_seconds: float | None
    last_message_at: datetime | None
    last_connected_at: datetime | None
    last_instrument_refresh_at: datetime | None
    reconnect_count: int
    last_error: str | None


@dataclass(frozen=True, slots=True)
class TickerStreamSnapshot:
    """Immutable cache view suitable for a synchronous repository call."""

    as_of: datetime | None
    quotes: tuple[DeribitTickerQuote, ...]
    source: str
    connection_state: ConnectionState
    connected: bool
    healthy: bool
    warmup_complete: bool
    connection_generation: int
    universe_current: bool
    active_instrument_names: tuple[str, ...]
    active_instrument_count: int
    requested_instrument_count: int
    subscribed_instrument_count: int
    initialized_quote_count: int
    retained_quote_count: int
    fresh_quote_count: int
    stale_quote_count: int
    missing_quote_count: int
    oldest_quote_age_seconds: float | None
    last_message_at: datetime | None
    reconnect_count: int
    last_error: str | None

    @property
    def rows(self) -> tuple[dict[str, Any], ...]:
        """Normalized scanner rows; check ``healthy`` before trading on them."""

        return tuple(quote.as_scanner_row() for quote in self.quotes)


class DeribitTickerStreamCache:
    """Maintain public BTC option ticker subscriptions in a daemon thread.

    Lifecycle is explicit by default: call :meth:`start`, use
    :meth:`wait_until_ready` when a synchronous caller needs initial data, and
    call :meth:`stop` during application shutdown.  ``wait_until_ready`` can
    also lazy-start the worker.
    """

    def __init__(
        self,
        *,
        currency: str = "BTC",
        channel_mode: str = DEFAULT_CHANNEL_MODE,
        channel_interval: str = DEFAULT_CHANNEL_INTERVAL,
        websocket_url: str = DERIBIT_WEBSOCKET_URL,
        heartbeat_seconds: int = DEFAULT_HEARTBEAT_SECONDS,
        stale_after_seconds: float = DEFAULT_STALE_AFTER_SECONDS,
        connect_timeout_seconds: float = 10.0,
        receive_timeout_seconds: float = 1.0,
        instrument_timeout_seconds: float = 15.0,
        reconnect_initial_seconds: float = 0.5,
        reconnect_max_seconds: float = 30.0,
        subscription_batch_size: int = MAX_CHANNELS_PER_REQUEST,
        max_ticker_subscriptions: int = DEFAULT_MAX_TICKER_SUBSCRIPTIONS,
        instrument_source: InstrumentSource | None = None,
        websocket_factory: WebSocketFactory | None = None,
        clock: Callable[[], datetime] | None = None,
        sleeper: Callable[[float], Any] | None = None,
        autostart: bool = False,
    ) -> None:
        normalized_currency = str(currency).strip().upper()
        if not normalized_currency or not re.fullmatch(r"[A-Z0-9]+", normalized_currency):
            raise ValueError("currency must be a non-empty alphanumeric code.")
        normalized_mode = str(channel_mode).strip().lower()
        if normalized_mode not in PUBLIC_CHANNEL_MODES:
            raise ValueError("channel_mode must be 'incremental' or 'ticker'.")
        if channel_interval not in PUBLIC_CHANNEL_INTERVALS:
            raise ValueError(
                "channel_interval must be public '100ms' or 'agg2'; raw requires auth."
            )
        if int(heartbeat_seconds) < 10:
            raise ValueError("heartbeat_seconds must be at least 10.")
        if not 1 <= int(subscription_batch_size) <= MAX_CHANNELS_PER_REQUEST:
            raise ValueError("subscription_batch_size must be between 1 and 500.")
        if int(max_ticker_subscriptions) < 1:
            raise ValueError("max_ticker_subscriptions must be at least 1.")
        for label, value, allow_zero in (
            ("stale_after_seconds", stale_after_seconds, False),
            ("connect_timeout_seconds", connect_timeout_seconds, False),
            ("receive_timeout_seconds", receive_timeout_seconds, False),
            ("instrument_timeout_seconds", instrument_timeout_seconds, False),
            ("reconnect_initial_seconds", reconnect_initial_seconds, True),
            ("reconnect_max_seconds", reconnect_max_seconds, True),
        ):
            parsed = float(value)
            if not math.isfinite(parsed) or parsed < 0 or (not allow_zero and parsed == 0):
                raise ValueError(f"{label} must be finite and {'non-negative' if allow_zero else 'positive'}.")
        if reconnect_max_seconds < reconnect_initial_seconds:
            raise ValueError(
                "reconnect_max_seconds must be greater than or equal to the initial delay."
            )

        self.currency = normalized_currency
        self.channel_mode = normalized_mode
        self.channel_interval = channel_interval
        self.websocket_url = websocket_url
        self.heartbeat_seconds = int(heartbeat_seconds)
        self.stale_after_seconds = float(stale_after_seconds)
        self.connect_timeout_seconds = float(connect_timeout_seconds)
        self.receive_timeout_seconds = float(receive_timeout_seconds)
        self.instrument_timeout_seconds = float(instrument_timeout_seconds)
        self.reconnect_initial_seconds = float(reconnect_initial_seconds)
        self.reconnect_max_seconds = float(reconnect_max_seconds)
        self.subscription_batch_size = int(subscription_batch_size)
        self.max_ticker_subscriptions = int(max_ticker_subscriptions)
        self._instrument_source = instrument_source or self._default_instrument_source
        self._websocket_factory = websocket_factory or _websockets_factory
        self._clock = clock or (lambda: datetime.now(UTC))
        self._sleeper = sleeper

        self._condition = Condition(RLock())
        self._stop_event = Event()
        self._thread: Thread | None = None
        self._connection: WebSocketConnection | None = None
        self._state = ConnectionState.STOPPED
        self._connected = False
        self._active_instruments: set[str] = set()
        self._subscribed_instruments: set[str] = set()
        self._requested_tickers: set[str] = set()
        self._quotes: dict[str, DeribitTickerQuote] = {}
        self._quote_generations: dict[str, int] = {}
        self._last_message_at: datetime | None = None
        self._last_connected_at: datetime | None = None
        self._last_instrument_refresh_at: datetime | None = None
        self._last_error: str | None = None
        self._reconnect_count = 0
        self._warmup_complete = False
        self._request_id = 0
        self._connection_generation = 0
        self._universe_generation: int | None = None
        self._incremental_payloads: dict[str, tuple[int, dict[str, Any]]] = {}

        if autostart:
            self.start()

    @property
    def instrument_state_channel(self) -> str:
        return f"instrument.state.option.{self.currency}"

    def ticker_channel(self, instrument_name: str) -> str:
        if self.channel_mode == "incremental":
            return f"incremental_ticker.{instrument_name}"
        return f"ticker.{instrument_name}.{self.channel_interval}"

    def start(self) -> bool:
        """Start the daemon worker; return ``False`` when already running."""

        with self._condition:
            if self._thread is not None and self._thread.is_alive():
                return False
            self._stop_event.clear()
            self._state = ConnectionState.CONNECTING
            self._connected = False
            self._warmup_complete = False
            thread = Thread(
                target=self._run,
                name=f"deribit-{self.currency.lower()}-ticker-stream",
                daemon=True,
            )
            self._thread = thread
            thread.start()
            self._condition.notify_all()
            return True

    def stop(self, timeout_seconds: float = 5.0) -> bool:
        """Request shutdown, close the socket, and join the worker.

        Returns ``True`` when shutdown completed before the timeout.  The
        method is idempotent and never holds the cache lock while closing a
        transport.
        """

        if not math.isfinite(float(timeout_seconds)) or timeout_seconds < 0:
            raise ValueError("timeout_seconds must be finite and non-negative.")
        with self._condition:
            thread = self._thread
            if thread is None or not thread.is_alive():
                self._connected = False
                self._state = ConnectionState.STOPPED
                self._subscribed_instruments.clear()
                self._warmup_complete = False
                self._condition.notify_all()
                return True
            self._state = ConnectionState.CLOSING
            self._connected = False
            self._warmup_complete = False
            self._stop_event.set()
            connection = self._connection
            self._condition.notify_all()

        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        if thread is not current_thread():
            thread.join(float(timeout_seconds))

        stopped = not thread.is_alive()
        with self._condition:
            if stopped:
                self._thread = None
                self._connection = None
                self._connected = False
                self._state = ConnectionState.STOPPED
                self._subscribed_instruments.clear()
                self._warmup_complete = False
            self._condition.notify_all()
        return stopped

    close = stop

    def __enter__(self) -> "DeribitTickerStreamCache":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.stop()

    def wait_until_ready(
        self,
        timeout_seconds: float,
        minimum_quotes: int = 1,
        *,
        instrument_names: Sequence[str] | None = None,
        start_if_needed: bool = True,
    ) -> bool:
        """Wait on a condition for fresh, open quotes without polling."""

        if not math.isfinite(float(timeout_seconds)) or timeout_seconds < 0:
            raise ValueError("timeout_seconds must be finite and non-negative.")
        if int(minimum_quotes) < 1:
            raise ValueError("minimum_quotes must be at least 1.")
        if start_if_needed:
            self.start()
        requested = (
            None
            if instrument_names is None
            else {
                str(name).strip().upper()
                for name in instrument_names
                if str(name).strip()
            }
        )
        if requested is not None and not requested:
            raise ValueError("instrument_names must contain at least one name.")

        deadline = time.monotonic() + float(timeout_seconds)
        with self._condition:
            while True:
                now = _as_utc(self._clock())
                if self._is_ready_unlocked(
                    now,
                    minimum_quotes=int(minimum_quotes),
                    instrument_names=requested,
                ):
                    return True
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                if self._state is ConnectionState.STOPPED and not start_if_needed:
                    return False
                self._condition.wait(remaining)

    def wait_for_snapshot(
        self,
        instrument_names: Sequence[str],
        timeout_seconds: float,
        *,
        start_if_needed: bool = True,
    ) -> TickerStreamSnapshot:
        """Await expiry-specific completeness, then return diagnostics either way."""

        self.wait_until_ready(
            timeout_seconds,
            instrument_names=instrument_names,
            start_if_needed=start_if_needed,
        )
        return self.snapshot(instrument_names)

    def request_tickers(self, instrument_names: Sequence[str]) -> None:
        """Pin these instruments so fetch() can subscribe them on demand.

        The worker applies the change on its next receive-loop pass.  Near-dated
        names stay within the connection budget; pinned names evict farther
        unpinned subscriptions when the cap is exceeded.
        """

        requested = {
            str(name).strip().upper()
            for name in instrument_names
            if str(name).strip()
        }
        if not requested:
            return
        with self._condition:
            missing = requested - self._requested_tickers
            if not missing:
                return
            self._requested_tickers.update(missing)
            self._condition.notify_all()

    def active_instrument_names(self) -> tuple[str, ...]:
        """Return the current bootstrap/lifecycle universe in stable order."""

        with self._condition:
            return tuple(sorted(self._active_instruments))

    def get(self, instrument_name: str) -> DeribitTickerQuote | None:
        """Return the last immutable quote, including while reconnecting."""

        with self._condition:
            return self._quotes.get(str(instrument_name).upper())

    def status(self) -> TickerStreamStatus:
        with self._condition:
            now = _as_utc(self._clock())
            universe_current = self._universe_is_current_unlocked()
            current_quotes = (
                self._quotes_for_active_unlocked(current_only=True)
                if universe_current
                else ()
            )
            ages = [
                _quote_age_seconds(quote, now) for quote in current_quotes
            ]
            fresh_count = sum(age <= self.stale_after_seconds for age in ages)
            stale_count = len(ages) - fresh_count
            open_complete = bool(self._active_instruments) and all(
                name in self._quotes
                and self._quote_generations.get(name) == self._connection_generation
                and self._quotes[name].is_open
                for name in self._active_instruments
            )
            warmup = (
                self._connected
                and universe_current
                and open_complete
                and len(current_quotes) == len(self._active_instruments)
            )
            healthy = warmup and stale_count == 0
            thread = self._thread
            return TickerStreamStatus(
                connection_state=self._state,
                running=bool(thread is not None and thread.is_alive()),
                connected=self._connected,
                healthy=healthy,
                warmup_complete=warmup,
                connection_generation=self._connection_generation,
                universe_current=universe_current,
                currency=self.currency,
                channel_mode=self.channel_mode,
                channel_interval=self.channel_interval,
                active_instrument_count=len(self._active_instruments),
                subscribed_instrument_count=len(self._subscribed_instruments),
                quote_count=len(current_quotes),
                initialized_quote_count=len(current_quotes),
                retained_quote_count=(
                    len(self._quotes_for_active_unlocked()) - len(current_quotes)
                ),
                fresh_quote_count=fresh_count,
                stale_quote_count=stale_count,
                oldest_quote_age_seconds=max(ages, default=None),
                last_message_at=self._last_message_at,
                last_connected_at=self._last_connected_at,
                last_instrument_refresh_at=self._last_instrument_refresh_at,
                reconnect_count=self._reconnect_count,
                last_error=self._last_error,
            )

    def snapshot(
        self, instrument_names: Sequence[str] | None = None
    ) -> TickerStreamSnapshot:
        """Copy a coherent cache view under one lock.

        Quotes deliberately remain readable during a reconnect, but
        ``healthy`` is always false unless the socket is connected and every
        requested active instrument has a fresh, open ticker.
        """

        with self._condition:
            now = _as_utc(self._clock())
            if instrument_names is None:
                requested = set(self._active_instruments)
            else:
                requested = {
                    str(name).strip().upper()
                    for name in instrument_names
                    if str(name).strip()
                }
            universe_current = self._universe_is_current_unlocked()
            quotes = tuple(
                self._quotes[name]
                for name in sorted(requested)
                if name in self._quotes
                and name in self._active_instruments
                and self._connected
                and universe_current
                and self._quote_generations.get(name) == self._connection_generation
            )
            ages = [_quote_age_seconds(quote, now) for quote in quotes]
            fresh_count = sum(age <= self.stale_after_seconds for age in ages)
            stale_count = len(ages) - fresh_count
            missing_count = len(requested) - len(quotes)
            open_complete = bool(requested) and all(quote.is_open for quote in quotes)
            warmup = (
                self._connected
                and universe_current
                and missing_count == 0
                and open_complete
            )
            healthy = warmup and stale_count == 0
            return TickerStreamSnapshot(
                as_of=max((quote.quote_as_of for quote in quotes), default=None),
                quotes=quotes,
                source=SOURCE_NAME,
                connection_state=self._state,
                connected=self._connected,
                healthy=healthy,
                warmup_complete=warmup,
                connection_generation=self._connection_generation,
                universe_current=universe_current,
                active_instrument_names=tuple(sorted(self._active_instruments)),
                active_instrument_count=len(self._active_instruments),
                requested_instrument_count=len(requested),
                subscribed_instrument_count=len(
                    requested & self._subscribed_instruments
                ),
                initialized_quote_count=len(quotes),
                retained_quote_count=sum(
                    1
                    for name in requested
                    if name in self._quotes
                    and (
                        not universe_current
                        or self._quote_generations.get(name)
                        != self._connection_generation
                    )
                ),
                fresh_quote_count=fresh_count,
                stale_quote_count=stale_count,
                missing_quote_count=missing_count,
                oldest_quote_age_seconds=max(ages, default=None),
                last_message_at=self._last_message_at,
                reconnect_count=self._reconnect_count,
                last_error=self._last_error,
            )

    def _run(self) -> None:
        delay = self.reconnect_initial_seconds
        first_attempt = True
        try:
            while not self._stop_event.is_set():
                with self._condition:
                    self._connection_generation += 1
                    attempt_generation = self._connection_generation
                    self._universe_generation = None
                    self._incremental_payloads.clear()
                    self._state = (
                        ConnectionState.CONNECTING
                        if first_attempt
                        else ConnectionState.RECONNECTING
                    )
                    self._connected = False
                    self._warmup_complete = False
                    self._condition.notify_all()

                connection: WebSocketConnection | None = None
                try:
                    active = self._load_active_instruments()
                    with self._condition:
                        self._replace_active_instruments_unlocked(active)
                        self._universe_generation = attempt_generation
                        self._last_instrument_refresh_at = _as_utc(self._clock())
                        self._condition.notify_all()

                    connection = self._websocket_factory(
                        self.websocket_url, self.connect_timeout_seconds
                    )
                    with self._condition:
                        self._connection = connection
                        self._subscribed_instruments.clear()
                        # An incremental patch is meaningful only after this
                        # connection's full snapshot.  Keep published quotes
                        # readable while reconnecting, but never use their
                        # fields as the next generation's merge base.
                        self._incremental_payloads.clear()

                    self._send_request(
                        connection,
                        "public/set_heartbeat",
                        {"interval": self.heartbeat_seconds},
                    )
                    self._subscribe_channels(connection, [self.instrument_state_channel])
                    with self._condition:
                        pinned = set(self._requested_tickers)
                    initial = _select_ticker_universe(
                        active,
                        pinned=pinned,
                        budget=self.max_ticker_subscriptions,
                    )
                    self._subscribe_tickers(connection, initial)

                    with self._condition:
                        self._subscribed_instruments = set(initial)
                        self._connected = True
                        self._state = ConnectionState.CONNECTED
                        self._last_connected_at = _as_utc(self._clock())
                        self._warmup_complete = self._calculate_warmup_unlocked()
                        self._condition.notify_all()

                    first_attempt = False
                    delay = self.reconnect_initial_seconds
                    self._receive_loop(connection)
                    if not self._stop_event.is_set():
                        raise ConnectionError("Deribit WebSocket closed without a close request.")
                except Exception as exc:
                    if self._stop_event.is_set():
                        break
                    with self._condition:
                        self._connected = False
                        self._subscribed_instruments.clear()
                        self._warmup_complete = False
                        self._state = ConnectionState.RECONNECTING
                        self._universe_generation = None
                        self._reconnect_count += 1
                        self._last_error = f"{type(exc).__name__}: {exc}"
                        self._condition.notify_all()
                    first_attempt = False
                finally:
                    if connection is not None:
                        try:
                            connection.close()
                        except Exception:
                            pass
                    with self._condition:
                        if self._connection is connection:
                            self._connection = None

                if self._stop_event.is_set():
                    break
                self._wait_before_reconnect(delay)
                delay = min(
                    self.reconnect_max_seconds,
                    max(self.reconnect_initial_seconds, delay * 2),
                )
        finally:
            with self._condition:
                self._connection = None
                self._connected = False
                self._subscribed_instruments.clear()
                self._warmup_complete = False
                self._state = ConnectionState.STOPPED
                self._condition.notify_all()

    def _wait_before_reconnect(self, delay: float) -> None:
        if self._sleeper is None:
            self._stop_event.wait(delay)
        else:
            self._sleeper(delay)

    def _receive_loop(self, connection: WebSocketConnection) -> None:
        while not self._stop_event.is_set():
            self._flush_requested_tickers(connection)
            try:
                raw = connection.recv(self.receive_timeout_seconds)
            except (TimeoutError, socket.timeout):
                continue
            if raw is None:
                return
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            received_at = _as_utc(self._clock())
            with self._condition:
                self._last_message_at = received_at
                self._condition.notify_all()
            try:
                message = json.loads(raw)
            except (TypeError, ValueError) as exc:
                raise TickerStreamError("Deribit sent invalid JSON.") from exc
            if not isinstance(message, dict):
                continue
            error = message.get("error")
            if error is not None:
                raise TickerStreamError(f"Deribit JSON-RPC error: {error}")
            self._handle_message(connection, message)

    def _handle_message(
        self, connection: WebSocketConnection, message: Mapping[str, Any]
    ) -> None:
        method = str(message.get("method") or "")
        params = message.get("params")
        if method == "heartbeat" and isinstance(params, Mapping):
            if str(params.get("type") or "").lower() == "test_request":
                self._send_request(connection, "public/test", {})
            return
        if method != "subscription" or not isinstance(params, Mapping):
            return
        channel = str(params.get("channel") or "")
        data = params.get("data")
        if not isinstance(data, Mapping):
            return
        if channel == self.instrument_state_channel:
            self._handle_instrument_state(connection, data)
            return
        if channel.startswith("incremental_ticker."):
            self._handle_ticker(
                data,
                incremental=True,
                channel_instrument=_instrument_name_from_channel(channel),
            )
            return
        if channel.startswith("ticker."):
            self._handle_ticker(
                data,
                incremental=False,
                channel_instrument=_instrument_name_from_channel(channel),
            )

    def _handle_instrument_state(
        self, connection: WebSocketConnection, data: Mapping[str, Any]
    ) -> None:
        instrument_name = str(data.get("instrument_name") or "").strip().upper()
        parsed = _parse_option_instrument(instrument_name)
        if parsed is None or not instrument_name.startswith(f"{self.currency}-"):
            return
        state = str(data.get("state") or "").strip().lower()
        if state == "open":
            with self._condition:
                if instrument_name in self._active_instruments:
                    return
                self._active_instruments.add(instrument_name)
                self._warmup_complete = False
                self._condition.notify_all()
            with self._condition:
                pinned = instrument_name in self._requested_tickers
                under_budget = (
                    len(self._subscribed_instruments) < self.max_ticker_subscriptions
                )
            if pinned or under_budget:
                self._subscribe_tickers(connection, [instrument_name])
                with self._condition:
                    self._subscribed_instruments.add(instrument_name)
                    self._condition.notify_all()
            return
        if state not in _TERMINAL_INSTRUMENT_STATES:
            return
        with self._condition:
            existed = instrument_name in self._active_instruments
            self._active_instruments.discard(instrument_name)
            self._quotes.pop(instrument_name, None)
            self._quote_generations.pop(instrument_name, None)
            self._incremental_payloads.pop(instrument_name, None)
            self._requested_tickers.discard(instrument_name)
            self._warmup_complete = self._calculate_warmup_unlocked()
            self._condition.notify_all()
        if existed:
            self._unsubscribe_tickers(connection, [instrument_name])
            with self._condition:
                self._subscribed_instruments.discard(instrument_name)
                self._condition.notify_all()

    def _handle_ticker(
        self,
        data: Mapping[str, Any],
        *,
        incremental: bool,
        channel_instrument: str = "",
    ) -> None:
        instrument_name = str(
            data.get("instrument_name") or channel_instrument or ""
        ).strip().upper()
        with self._condition:
            if instrument_name not in self._active_instruments:
                return
            merged: Mapping[str, Any] = data
            if incremental:
                message_type = str(data.get("type") or "").strip().lower()
                existing_payload = self._incremental_payloads.get(instrument_name)
                if message_type == "snapshot":
                    # A snapshot starts a clean merge base even if the venue
                    # sends more than one during the same socket generation.
                    merged_dict = dict(data)
                else:
                    if (
                        existing_payload is None
                        or existing_payload[0] != self._connection_generation
                    ):
                        # Never merge a patch onto a retained quote from an old
                        # connection; wait for the documented full snapshot.
                        return
                    previous_payload = existing_payload[1]
                    incoming_time = _optional_float(data.get("timestamp"))
                    previous_time = _optional_float(previous_payload.get("timestamp"))
                    if (
                        incoming_time is None
                        or previous_time is None
                        or incoming_time < previous_time
                    ):
                        return
                    merged_dict = dict(previous_payload)
                    # Incremental changes omit unchanged fields.  An explicit
                    # JSON null is the same as "not present" and must not wipe
                    # a previously validated bid/ask/IV.
                    for key, value in data.items():
                        if value is None:
                            continue
                        merged_dict[key] = value
                    if instrument_name and not merged_dict.get("instrument_name"):
                        merged_dict["instrument_name"] = instrument_name
                self._incremental_payloads[instrument_name] = (
                    self._connection_generation,
                    merged_dict,
                )
                merged = merged_dict

            quote = _quote_from_ticker(merged)
            if quote is None:
                return
            previous = self._quotes.get(quote.instrument_name)
            if previous is not None and quote.quote_as_of < previous.quote_as_of:
                return
            self._quotes[quote.instrument_name] = quote
            self._quote_generations[quote.instrument_name] = (
                self._connection_generation
            )
            self._warmup_complete = self._calculate_warmup_unlocked()
            self._condition.notify_all()

    def _load_active_instruments(self) -> tuple[str, ...]:
        try:
            raw_rows = self._instrument_source(currency=self.currency)
        except Exception as exc:
            raise TickerStreamError(
                f"active {self.currency} option bootstrap failed: {exc}"
            ) from exc
        if not isinstance(raw_rows, Sequence) or isinstance(raw_rows, (str, bytes)):
            raise TickerStreamError("instrument source did not return a sequence.")
        now_ms = int(_as_utc(self._clock()).timestamp() * 1_000)
        active: set[str] = set()
        for raw in raw_rows:
            if isinstance(raw, str):
                name = raw.strip().upper()
                row: Mapping[str, Any] = {}
            elif isinstance(raw, Mapping):
                name = str(raw.get("instrument_name") or "").strip().upper()
                row = raw
            else:
                continue
            parsed = _parse_option_instrument(name)
            if parsed is None or not name.startswith(f"{self.currency}-"):
                continue
            kind = str(row.get("kind") or "option").lower()
            if kind != "option" or row.get("is_active") is False:
                continue
            state = str(row.get("state") or "open").lower()
            if state in _TERMINAL_INSTRUMENT_STATES:
                continue
            expiry_ms = _optional_float(row.get("expiration_timestamp"))
            if expiry_ms is not None and expiry_ms <= now_ms:
                continue
            active.add(name)
        if not active:
            raise TickerStreamError(
                f"instrument source returned no active {self.currency} options."
            )
        return tuple(sorted(active))

    def _default_instrument_source(
        self, *, currency: str
    ) -> Sequence[Mapping[str, Any] | str]:
        response = httpx.get(
            DERIBIT_INSTRUMENTS_URL,
            params={"currency": currency, "kind": "option", "expired": "false"},
            timeout=self.instrument_timeout_seconds,
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("result"), list):
            raise TickerStreamError("Deribit get_instruments response has no result list.")
        return payload["result"]

    def _replace_active_instruments_unlocked(self, names: Sequence[str]) -> None:
        replacement = set(names)
        removed = self._active_instruments - replacement
        self._active_instruments = replacement
        for name in removed:
            self._quotes.pop(name, None)
            self._quote_generations.pop(name, None)
            self._incremental_payloads.pop(name, None)
        self._warmup_complete = self._calculate_warmup_unlocked()

    def _calculate_warmup_unlocked(self) -> bool:
        return (
            self._connected
            and self._universe_is_current_unlocked()
            and bool(self._active_instruments)
            and all(
                name in self._quotes
                and self._quote_generations.get(name) == self._connection_generation
                and self._quotes[name].is_open
                for name in self._active_instruments
            )
        )

    def _is_ready_unlocked(
        self,
        now: datetime,
        *,
        minimum_quotes: int,
        instrument_names: set[str] | None,
    ) -> bool:
        if not self._connected or not self._universe_is_current_unlocked():
            return False
        requested = (
            self._active_instruments
            if instrument_names is None
            else instrument_names
        )
        ready_names = {
            name
            for name in requested
            if name in self._active_instruments
            and name in self._quotes
            and self._quote_generations.get(name) == self._connection_generation
            and self._quotes[name].is_open
            and _quote_age_seconds(self._quotes[name], now)
            <= self.stale_after_seconds
        }
        if instrument_names is not None and ready_names != requested:
            return False
        return len(ready_names) >= minimum_quotes

    def _universe_is_current_unlocked(self) -> bool:
        return (
            self._connected
            and self._universe_generation == self._connection_generation
        )

    def _quotes_for_active_unlocked(
        self, *, current_only: bool = False
    ) -> tuple[DeribitTickerQuote, ...]:
        return tuple(
            self._quotes[name]
            for name in self._active_instruments
            if name in self._quotes
            and (
                not current_only
                or self._quote_generations.get(name) == self._connection_generation
            )
        )

    def _flush_requested_tickers(self, connection: WebSocketConnection) -> None:
        """Subscribe pinned expiries and evict farther unpinned names if needed."""

        with self._condition:
            missing = [
                name
                for name in self._requested_tickers
                if name in self._active_instruments
                and name not in self._subscribed_instruments
            ]
            unpinned = self._subscribed_instruments - self._requested_tickers
            overflow = (
                len(self._subscribed_instruments)
                + len(missing)
                - self.max_ticker_subscriptions
            )
        evict = _farthest_instruments(unpinned, overflow) if overflow > 0 else []
        if evict:
            self._unsubscribe_tickers(connection, evict)
            with self._condition:
                self._subscribed_instruments.difference_update(evict)
        if not missing:
            return
        self._subscribe_tickers(connection, missing)
        with self._condition:
            self._subscribed_instruments.update(missing)
            self._condition.notify_all()

    def _subscribe_tickers(
        self, connection: WebSocketConnection, instruments: Sequence[str]
    ) -> None:
        self._subscribe_channels(
            connection, [self.ticker_channel(name) for name in instruments]
        )

    def _unsubscribe_tickers(
        self, connection: WebSocketConnection, instruments: Sequence[str]
    ) -> None:
        self._send_channels(
            connection,
            "public/unsubscribe",
            [self.ticker_channel(name) for name in instruments],
        )

    def _subscribe_channels(
        self, connection: WebSocketConnection, channels: Sequence[str]
    ) -> None:
        self._send_channels(connection, "public/subscribe", channels)

    def _send_channels(
        self,
        connection: WebSocketConnection,
        method: str,
        channels: Sequence[str],
    ) -> None:
        ordered = list(dict.fromkeys(channel for channel in channels if channel))
        for offset in range(0, len(ordered), self.subscription_batch_size):
            batch = ordered[offset : offset + self.subscription_batch_size]
            self._send_request(connection, method, {"channels": batch})

    def _send_request(
        self,
        connection: WebSocketConnection,
        method: str,
        params: Mapping[str, Any],
    ) -> None:
        with self._condition:
            self._request_id += 1
            request_id = self._request_id
        connection.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": dict(params),
                },
                separators=(",", ":"),
            )
        )


def _quote_from_ticker(data: Mapping[str, Any]) -> DeribitTickerQuote | None:
    instrument_name = str(data.get("instrument_name") or "").strip().upper()
    if _parse_option_instrument(instrument_name) is None:
        return None
    quote_as_of = _millis_as_datetime(data.get("timestamp"))
    if quote_as_of is None:
        return None
    state = str(data.get("state") or "unknown").strip().lower()
    return DeribitTickerQuote(
        instrument_name=instrument_name,
        quote_as_of=quote_as_of,
        state=state,
        is_open=state == "open",
        best_bid_price=_optional_float(data.get("best_bid_price")),
        best_bid_amount=_optional_float(data.get("best_bid_amount")),
        best_ask_price=_optional_float(data.get("best_ask_price")),
        best_ask_amount=_optional_float(data.get("best_ask_amount")),
        bid_iv=_optional_float(data.get("bid_iv")),
        ask_iv=_optional_float(data.get("ask_iv")),
        mark_iv=_optional_float(data.get("mark_iv")),
        mark_price=_optional_float(data.get("mark_price")),
        index_price=_optional_float(data.get("index_price")),
        underlying_price=_optional_float(data.get("underlying_price")),
        estimated_delivery_price=_optional_float(
            data.get("estimated_delivery_price")
        ),
        open_interest=_optional_float(data.get("open_interest")),
        delta=_optional_greeks_delta(data),
    )


def _instrument_name_from_channel(channel: str) -> str:
    text = str(channel or "").strip()
    if text.startswith("incremental_ticker."):
        return text.split(".", 1)[1].strip().upper()
    if text.startswith("ticker."):
        parts = text.split(".")
        return parts[1].strip().upper() if len(parts) >= 2 else ""
    return ""


def _instrument_sort_key(name: str) -> tuple[str, float, str, str]:
    parsed = _parse_option_instrument(name)
    if parsed is None:
        return ("9999-99-99", float("inf"), "z", name)
    expiry, strike, side = parsed
    return (expiry, strike, side, name)


def _sorted_instruments(names: Sequence[str] | set[str]) -> list[str]:
    return sorted((str(name).strip().upper() for name in names if str(name).strip()), key=_instrument_sort_key)


def _farthest_instruments(names: Sequence[str] | set[str], count: int) -> list[str]:
    if count <= 0:
        return []
    ordered = list(reversed(_sorted_instruments(names)))
    return ordered[:count]


def _select_ticker_universe(
    active: Sequence[str] | set[str],
    *,
    pinned: set[str],
    budget: int,
) -> list[str]:
    active_set = {
        str(name).strip().upper() for name in active if str(name).strip()
    }
    pinned_live = [name for name in _sorted_instruments(pinned) if name in active_set]
    remaining = max(0, int(budget) - len(pinned_live))
    fillers = [
        name
        for name in _sorted_instruments(active_set.difference(pinned_live))
        [:remaining]
    ]
    return list(dict.fromkeys([*pinned_live, *fillers]))


def _parse_option_instrument(value: Any) -> tuple[str, float, str] | None:
    match = _INSTRUMENT_RE.fullmatch(str(value or "").strip())
    if match is None:
        return None
    try:
        expiry = datetime.strptime(
            match.group("expiry").upper(), "%d%b%y"
        ).date().isoformat()
        strike = float(match.group("strike"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(strike) or strike <= 0:
        return None
    option_type = "call" if match.group("side").upper() == "C" else "put"
    return expiry, strike, option_type


def _optional_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _optional_greeks_delta(data: Mapping[str, Any]) -> float | None:
    greeks = data.get("greeks")
    if isinstance(greeks, Mapping):
        return _optional_float(greeks.get("delta"))
    return _optional_float(data.get("delta"))


def _millis_as_datetime(value: Any) -> datetime | None:
    millis = _optional_float(value)
    if millis is None or millis <= 0:
        return None
    try:
        return datetime.fromtimestamp(millis / 1_000.0, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def _as_utc(value: datetime) -> datetime:
    if not isinstance(value, datetime):
        raise TypeError("clock must return a datetime.")
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _quote_age_seconds(quote: DeribitTickerQuote, now: datetime) -> float:
    return max(0.0, (now - quote.quote_as_of).total_seconds())


# -- Production synchronous WebSocket transport -----------------------------


class _WebsocketsConnection:
    def __init__(self, connection: Any) -> None:
        self._connection = connection

    def send(self, message: str) -> None:
        self._connection.send(message)

    def recv(self, timeout_seconds: float) -> str | bytes | None:
        return self._connection.recv(timeout=float(timeout_seconds))

    def close(self) -> None:
        self._connection.close()


def _websockets_factory(
    url: str, timeout_seconds: float
) -> WebSocketConnection:
    return _WebsocketsConnection(
        websocket_connect(
            url,
            open_timeout=float(timeout_seconds),
            close_timeout=2.0,
            ping_interval=None,
            compression=None,
            max_size=32 * 1024 * 1024,
            max_queue=128,
            user_agent_header="Lotus-IV-Ticker/2",
        )
    )


# Retained as a dependency-free fallback implementation for controlled
# recovery environments.  It is not the production default.

_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _stdlib_websocket_factory(
    url: str, timeout_seconds: float
) -> WebSocketConnection:
    return _StdlibWebSocket.connect(url, timeout_seconds)


class _StdlibWebSocket:
    """Minimal RFC 6455 client supporting text, control, and fragmented frames."""

    def __init__(self, sock: socket.socket, initial_buffer: bytes = b"") -> None:
        self._socket = sock
        self._buffer = bytearray(initial_buffer)
        self._send_lock = Lock()
        self._closed = False
        self._fragment_opcode: int | None = None
        self._fragments = bytearray()
        self._max_message_bytes = 32 * 1024 * 1024

    @classmethod
    def connect(cls, url: str, timeout_seconds: float) -> "_StdlibWebSocket":
        parsed = urlsplit(url)
        if parsed.scheme not in {"ws", "wss"} or not parsed.hostname:
            raise TickerStreamError("websocket_url must use ws:// or wss://.")
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        raw_socket = socket.create_connection(
            (parsed.hostname, port), timeout=float(timeout_seconds)
        )
        sock: socket.socket = raw_socket
        try:
            if parsed.scheme == "wss":
                sock = ssl.create_default_context().wrap_socket(
                    raw_socket, server_hostname=parsed.hostname
                )
                sock.settimeout(float(timeout_seconds))
            path = parsed.path or "/"
            if parsed.query:
                path = f"{path}?{parsed.query}"
            key = b64encode(secrets.token_bytes(16)).decode("ascii")
            host_header = parsed.hostname
            if port not in {80, 443}:
                host_header = f"{host_header}:{port}"
            request = (
                f"GET {path} HTTP/1.1\r\n"
                f"Host: {host_header}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                "User-Agent: Lotus-IV-Ticker/1\r\n\r\n"
            ).encode("ascii")
            sock.sendall(request)
            headers, remainder = _read_http_upgrade(sock)
            status_line, header_map = _parse_http_headers(headers)
            if not status_line.startswith("HTTP/1.1 101"):
                raise TickerStreamError(f"WebSocket upgrade failed: {status_line}")
            if header_map.get("upgrade", "").lower() != "websocket":
                raise TickerStreamError("WebSocket upgrade response is missing Upgrade.")
            if "upgrade" not in header_map.get("connection", "").lower():
                raise TickerStreamError("WebSocket upgrade response is missing Connection.")
            expected = b64encode(
                hashlib.sha1((key + _WEBSOCKET_GUID).encode("ascii")).digest()
            ).decode("ascii")
            if header_map.get("sec-websocket-accept") != expected:
                raise TickerStreamError("WebSocket upgrade accept key did not match.")
            return cls(sock, remainder)
        except Exception:
            try:
                sock.close()
            finally:
                if sock is not raw_socket:
                    try:
                        raw_socket.close()
                    except OSError:
                        pass
            raise

    def send(self, message: str) -> None:
        payload = str(message).encode("utf-8")
        self._send_frame(0x1, payload)

    def recv(self, timeout_seconds: float) -> str | bytes | None:
        self._socket.settimeout(float(timeout_seconds))
        while not self._closed:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x8:
                if not self._closed:
                    self._send_frame(0x8, payload[:125])
                self._closed = True
                return None
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in {0x1, 0x2}:
                if self._fragment_opcode is not None:
                    raise TickerStreamError("overlapping fragmented WebSocket messages.")
                if fin:
                    return payload.decode("utf-8") if opcode == 0x1 else payload
                self._fragment_opcode = opcode
                self._fragments = bytearray(payload)
                continue
            if opcode == 0x0:
                if self._fragment_opcode is None:
                    raise TickerStreamError("unexpected WebSocket continuation frame.")
                self._fragments.extend(payload)
                if len(self._fragments) > self._max_message_bytes:
                    raise TickerStreamError("WebSocket message exceeded size limit.")
                if fin:
                    complete = bytes(self._fragments)
                    complete_opcode = self._fragment_opcode
                    self._fragment_opcode = None
                    self._fragments.clear()
                    return (
                        complete.decode("utf-8")
                        if complete_opcode == 0x1
                        else complete
                    )
                continue
            raise TickerStreamError(f"unsupported WebSocket opcode {opcode}.")
        return None

    def close(self) -> None:
        with self._send_lock:
            if self._closed:
                return
            self._closed = True
            try:
                self._socket.sendall(_encode_websocket_frame(0x8, b"", masked=True))
            except OSError:
                pass
            try:
                self._socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self._socket.close()

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        with self._send_lock:
            if self._closed:
                raise ConnectionError("WebSocket is closed.")
            self._socket.sendall(
                _encode_websocket_frame(opcode, payload, masked=True)
            )

    def _read_frame(self) -> tuple[bool, int, bytes]:
        first, second = self._read_exact(2)
        fin = bool(first & 0x80)
        if first & 0x70:
            raise TickerStreamError("WebSocket extension bits are unsupported.")
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = int.from_bytes(self._read_exact(2), "big")
        elif length == 127:
            length = int.from_bytes(self._read_exact(8), "big")
        if opcode >= 0x8 and (not fin or length > 125):
            raise TickerStreamError("invalid WebSocket control frame.")
        if length > self._max_message_bytes:
            raise TickerStreamError("WebSocket frame exceeded size limit.")
        mask_key = self._read_exact(4) if masked else b""
        payload = self._read_exact(length)
        if masked:
            payload = bytes(
                byte ^ mask_key[index % 4] for index, byte in enumerate(payload)
            )
        return fin, opcode, payload

    def _read_exact(self, size: int) -> bytes:
        while len(self._buffer) < size:
            chunk = self._socket.recv(max(4_096, size - len(self._buffer)))
            if not chunk:
                raise ConnectionError("WebSocket peer closed the TCP connection.")
            self._buffer.extend(chunk)
        result = bytes(self._buffer[:size])
        del self._buffer[:size]
        return result


def _read_http_upgrade(sock: socket.socket) -> tuple[bytes, bytes]:
    buffer = bytearray()
    marker = b"\r\n\r\n"
    while marker not in buffer:
        chunk = sock.recv(4_096)
        if not chunk:
            raise ConnectionError("peer closed during WebSocket upgrade.")
        buffer.extend(chunk)
        if len(buffer) > 65_536:
            raise TickerStreamError("WebSocket upgrade headers exceeded size limit.")
    end = buffer.index(marker) + len(marker)
    return bytes(buffer[:end]), bytes(buffer[end:])


def _parse_http_headers(headers: bytes) -> tuple[str, dict[str, str]]:
    try:
        lines = headers.decode("iso-8859-1").split("\r\n")
    except UnicodeDecodeError as exc:  # pragma: no cover - ISO-8859-1 is exhaustive
        raise TickerStreamError("invalid WebSocket upgrade headers.") from exc
    status_line = lines[0]
    parsed: dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            break
        if ":" not in line:
            raise TickerStreamError("malformed WebSocket upgrade header.")
        name, value = line.split(":", 1)
        parsed[name.strip().lower()] = value.strip()
    return status_line, parsed


def _encode_websocket_frame(opcode: int, payload: bytes, *, masked: bool) -> bytes:
    first = 0x80 | (opcode & 0x0F)
    length = len(payload)
    mask_bit = 0x80 if masked else 0
    if length < 126:
        header = bytes((first, mask_bit | length))
    elif length <= 0xFFFF:
        header = bytes((first, mask_bit | 126)) + length.to_bytes(2, "big")
    else:
        header = bytes((first, mask_bit | 127)) + length.to_bytes(8, "big")
    if not masked:
        return header + payload
    mask_key = secrets.token_bytes(4)
    masked_payload = bytes(
        byte ^ mask_key[index % 4] for index, byte in enumerate(payload)
    )
    return header + mask_key + masked_payload
