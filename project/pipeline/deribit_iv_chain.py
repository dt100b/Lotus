"""Deribit input adapters for the IV signal scanner.

The dashboard GEX snapshot is intentionally *not* an IV-chain data source: its
rows only contain instruments that appear in the dealer-inventory ledger.  The
production scanner consumes the generation-safe ticker WebSocket cache.  The
one-call public book-summary adapter remains for frozen parity, reconciliation,
and diagnostics, but it is never marked as verified streaming input.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import math
import re
from threading import Lock
from typing import Any, Callable, Mapping, Protocol, Sequence

import httpx
import numpy as np

from .deribit_ticker_stream import DeribitTickerStreamCache


DERIBIT_BOOK_SUMMARY_URL = (
    "https://www.deribit.com/api/v2/public/get_book_summary_by_currency"
)
DEFAULT_CACHE_SECONDS = 10.0
DEFAULT_TIMEOUT_SECONDS = 15.0
SOURCE_NAME = "deribit_book_summary"
TICKER_SOURCE_NAME = "deribit_ticker_ws"
DEFAULT_TICKER_WARMUP_TIMEOUT_SECONDS = 8.0

_INSTRUMENT_RE = re.compile(
    r"^BTC-(?P<expiry>\d{1,2}[A-Z]{3}\d{2})-"
    r"(?P<strike>\d+(?:\.\d+)?)-(?P<side>[CP])$",
    re.IGNORECASE,
)


class IvChainProviderError(RuntimeError):
    """Raised when a verified live full-chain snapshot cannot be produced."""


@dataclass(frozen=True)
class IvChainSnapshot:
    as_of: datetime
    spot: float
    rows: Sequence[dict[str, Any]]
    source: str = SOURCE_NAME
    verified_live_quotes: bool = True
    feed: Mapping[str, Any] | None = None


class IvChainProvider(Protocol):
    def fetch(self, expiry: str | None = None) -> IvChainSnapshot: ...


class DeribitIvChainProvider:
    """Fetch and briefly cache all active BTC option book summaries.

    ``http_get`` and ``clock`` are injectable so provider and repository tests
    remain completely offline.  One cache miss performs exactly one HTTP call.
    """

    def __init__(
        self,
        *,
        cache_seconds: float = DEFAULT_CACHE_SECONDS,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        http_get: Callable[..., Any] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not math.isfinite(float(cache_seconds)) or cache_seconds < 0:
            raise ValueError("cache_seconds must be finite and non-negative.")
        self.cache_seconds = float(cache_seconds)
        self.timeout_seconds = float(timeout_seconds)
        self._http_get = http_get or httpx.get
        self._clock = clock or (lambda: datetime.now(UTC))
        self._cached_at: datetime | None = None
        self._cached_snapshot: IvChainSnapshot | None = None
        self._lock = Lock()

    def fetch(self, expiry: str | None = None) -> IvChainSnapshot:
        del expiry
        now = _as_utc(self._clock())
        with self._lock:
            if (
                self._cached_at is not None
                and self._cached_snapshot is not None
                and (now - self._cached_at).total_seconds() <= self.cache_seconds
            ):
                return self._cached_snapshot

            snapshot = self._fetch_uncached()
            self._cached_at = now
            self._cached_snapshot = snapshot
            return snapshot

    def _fetch_uncached(self) -> IvChainSnapshot:
        try:
            response = self._http_get(
                DERIBIT_BOOK_SUMMARY_URL,
                params={"currency": "BTC", "kind": "option"},
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:  # pragma: no cover - exact transport type varies
            raise IvChainProviderError(
                f"Deribit BTC option book-summary request failed: {exc}"
            ) from exc

        if not isinstance(payload, dict) or not isinstance(payload.get("result"), list):
            raise IvChainProviderError("Deribit book-summary response has no result list.")

        as_of = _response_as_of(payload)
        normalized_rows: list[dict[str, Any]] = []
        spot_candidates: list[float] = []

        for raw in payload["result"]:
            if not isinstance(raw, dict):
                continue
            parsed = _parse_instrument_name(raw.get("instrument_name"))
            if parsed is None:
                continue
            expiry, strike, option_type = parsed

            # The endpoint is documented as active-only, but retain an explicit
            # settlement check so a response/cache race cannot revive an expiry.
            if _settlement_timestamp(expiry) <= as_of:
                continue

            estimated_spot = _positive_finite(raw.get("estimated_delivery_price"))
            if estimated_spot is not None:
                spot_candidates.append(estimated_spot)

            normalized_rows.append(
                {
                    "expiry": expiry,
                    "strike": strike,
                    "option_type": option_type,
                    "instrument_name": str(raw.get("instrument_name")),
                    "mark_iv": raw.get("mark_iv"),
                    "bid_price": raw.get("bid_price"),
                    "ask_price": raw.get("ask_price"),
                    # This is the age of Deribit's generated summary row, not a
                    # venue guarantee about the last time either quote changed.
                    # The one-call endpoint exposes no last-quote-change clock.
                    "quote_as_of": _row_as_of(raw.get("creation_timestamp")),
                    "underlying_price": raw.get("underlying_price"),
                    "estimated_delivery_price": raw.get("estimated_delivery_price"),
                }
            )

        if not normalized_rows:
            raise IvChainProviderError("Deribit returned no active BTC option summaries.")
        if not spot_candidates:
            raise IvChainProviderError(
                "Deribit summaries contain no positive estimated delivery price."
            )

        return IvChainSnapshot(
            as_of=as_of,
            spot=float(np.median(np.asarray(spot_candidates, dtype=float))),
            rows=tuple(normalized_rows),
            verified_live_quotes=False,
            feed={
                "source": SOURCE_NAME,
                "transport": "snapshot",
                "channel_interval": None,
                "status": "DEGRADED",
                "connected": False,
                "warmup_complete": True,
                "universe_is_current": True,
                "expected_expiry_instruments": len(normalized_rows),
                "subscribed_expiry_instruments": 0,
                "initialized_expiry_instruments": len(normalized_rows),
                "fresh_expiry_instruments": len(normalized_rows),
                "completeness_ratio": 1.0,
                "last_message_at": as_of,
                "last_message_age_seconds": 0.0,
                "reconnect_count": 0,
                "connection_generation": 0,
                "last_error": None,
            },
        )

    def start(self) -> bool:
        return False

    def close(self) -> bool:
        return True


class DeribitTickerIvChainProvider:
    """Adapt the live ticker cache to the scanner's immutable chain contract.

    Network I/O lives exclusively in the cache's daemon worker.  ``fetch``
    takes a coherent expiry snapshot, waits briefly for first-generation
    ticker initialization, and derives feed eligibility without ever mixing in
    summary rows.
    """

    def __init__(
        self,
        *,
        stream: DeribitTickerStreamCache | None = None,
        warmup_timeout_seconds: float = DEFAULT_TICKER_WARMUP_TIMEOUT_SECONDS,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if (
            not math.isfinite(float(warmup_timeout_seconds))
            or warmup_timeout_seconds < 0
        ):
            raise ValueError(
                "warmup_timeout_seconds must be finite and non-negative."
            )
        self.stream = stream or DeribitTickerStreamCache()
        self.warmup_timeout_seconds = float(warmup_timeout_seconds)
        self._clock = clock or (lambda: datetime.now(UTC))

    @property
    def source(self) -> str:
        if self.stream.channel_mode == "incremental":
            return f"{TICKER_SOURCE_NAME}_incremental"
        return f"{TICKER_SOURCE_NAME}_{self.stream.channel_interval}"

    def start(self) -> bool:
        return self.stream.start()

    def close(self) -> bool:
        return self.stream.stop()

    def fetch(self, expiry: str | None = None) -> IvChainSnapshot:
        self.start()
        active_names = self.stream.active_instrument_names()
        if not active_names:
            self.stream.wait_until_ready(
                self.warmup_timeout_seconds,
                minimum_quotes=1,
            )
            active_names = self.stream.active_instrument_names()
        if not active_names:
            status = self.stream.status()
            detail = f" ({status.last_error})" if status.last_error else ""
            raise IvChainProviderError(
                f"Deribit ticker stream is warming; no active option universe{detail}."
            )

        selected_names = active_names
        if expiry is not None:
            normalized_expiry = str(expiry).strip()
            selected_names = tuple(
                name
                for name in active_names
                if (
                    (parsed := _parse_instrument_name(name)) is not None
                    and parsed[0] == normalized_expiry
                )
            )
            if not selected_names:
                raise KeyError(f"Unknown expiry: {normalized_expiry}")

        request_tickers = getattr(self.stream, "request_tickers", None)
        if callable(request_tickers):
            request_tickers(selected_names)

        snapshot = self.stream.wait_for_snapshot(
            selected_names,
            self.warmup_timeout_seconds,
        )
        rows = snapshot.rows
        if not rows:
            detail = f" ({snapshot.last_error})" if snapshot.last_error else ""
            raise IvChainProviderError(
                "Deribit ticker stream has not initialized the selected expiry"
                f"{detail}."
            )

        spot_candidates = [
            candidate
            for quote in snapshot.quotes
            for candidate in (
                _positive_finite(quote.underlying_price),
                _positive_finite(quote.estimated_delivery_price),
                _positive_finite(quote.index_price),
            )
            if candidate is not None
        ]
        if not spot_candidates:
            raise IvChainProviderError(
                "Deribit ticker rows contain no positive underlying/index price."
            )

        now = _as_utc(self._clock())
        expected = snapshot.requested_instrument_count
        initialized = snapshot.initialized_quote_count
        completeness = initialized / expected if expected else 0.0
        ready = (
            snapshot.healthy
            and snapshot.connected
            and snapshot.warmup_complete
            and snapshot.universe_current
            and expected > 0
            and snapshot.subscribed_instrument_count == expected
            and initialized == expected
            and snapshot.fresh_quote_count == expected
        )
        if ready:
            feed_status = "READY"
        elif snapshot.connected and initialized < expected:
            feed_status = "WARMING"
        elif snapshot.connected:
            feed_status = "DEGRADED"
        else:
            feed_status = "DISCONNECTED"
        last_message_age = (
            max((now - snapshot.last_message_at).total_seconds(), 0.0)
            if snapshot.last_message_at is not None
            else None
        )
        return IvChainSnapshot(
            as_of=now,
            spot=float(np.median(np.asarray(spot_candidates, dtype=float))),
            rows=rows,
            source=self.source,
            verified_live_quotes=ready,
            feed={
                "source": self.source,
                "transport": "websocket",
                "channel_interval": (
                    "incremental"
                    if self.stream.channel_mode == "incremental"
                    else self.stream.channel_interval
                ),
                "status": feed_status,
                "connected": snapshot.connected,
                "warmup_complete": snapshot.warmup_complete,
                "universe_is_current": snapshot.universe_current,
                "expected_expiry_instruments": expected,
                "subscribed_expiry_instruments": (
                    snapshot.subscribed_instrument_count
                ),
                "initialized_expiry_instruments": initialized,
                "fresh_expiry_instruments": snapshot.fresh_quote_count,
                "completeness_ratio": float(completeness),
                "last_message_at": snapshot.last_message_at,
                "last_message_age_seconds": last_message_age,
                "reconnect_count": snapshot.reconnect_count,
                "connection_generation": snapshot.connection_generation,
                "last_error": snapshot.last_error,
            },
        )


def _parse_instrument_name(value: Any) -> tuple[str, float, str] | None:
    match = _INSTRUMENT_RE.match(str(value or "").strip())
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
    return expiry, strike, "call" if match.group("side").upper() == "C" else "put"


def _response_as_of(payload: dict[str, Any]) -> datetime:
    # JSON-RPC ``usOut`` is the server's response timestamp in microseconds and
    # is a better chain-wide quote clock than the local request completion time.
    try:
        micros = float(payload["usOut"])
    except (KeyError, TypeError, ValueError) as exc:
        raise IvChainProviderError(
            "Deribit book-summary response is missing its server usOut timestamp."
        ) from exc
    if not math.isfinite(micros) or micros <= 0:
        raise IvChainProviderError("Deribit server usOut timestamp is invalid.")
    return datetime.fromtimestamp(micros / 1_000_000.0, tz=UTC)


def _row_as_of(value: Any) -> datetime | None:
    try:
        millis = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(millis) or millis <= 0:
        return None
    return datetime.fromtimestamp(millis / 1_000.0, tz=UTC)


def _settlement_timestamp(expiry: str) -> datetime:
    parsed = datetime.strptime(expiry, "%Y-%m-%d")
    return parsed.replace(hour=8, tzinfo=UTC)


def _positive_finite(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and parsed > 0 else None


def _as_utc(value: datetime) -> datetime:
    return (
        value.replace(tzinfo=UTC)
        if value.tzinfo is None
        else value.astimezone(UTC)
    )
