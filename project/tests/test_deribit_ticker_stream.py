"""Offline tests for the public Deribit ticker WebSocket cache."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from queue import Empty, Queue
from threading import Condition, Event, Lock
import time
from typing import Any, Callable

import pytest

from project.pipeline.deribit_ticker_stream import (
    ConnectionState,
    DeribitTickerStreamCache,
)


AS_OF = datetime(2030, 8, 15, 12, 0, 0, tzinfo=UTC)
CALL = "BTC-16AUG30-100-C"
PUT = "BTC-16AUG30-100-P"
NEW_CALL = "BTC-30AUG30-110-C"


class MutableClock:
    def __init__(self, value: datetime) -> None:
        self._value = value
        self._lock = Lock()

    def __call__(self) -> datetime:
        with self._lock:
            return self._value

    def advance(self, seconds: float) -> None:
        with self._lock:
            self._value += timedelta(seconds=seconds)


class FakeWebSocket:
    def __init__(self) -> None:
        self._incoming: Queue[str | bytes | BaseException | None] = Queue()
        self._sent_condition = Condition()
        self.sent: list[dict[str, Any]] = []
        self.closed = Event()

    def send(self, message: str) -> None:
        with self._sent_condition:
            self.sent.append(json.loads(message))
            self._sent_condition.notify_all()

    def recv(self, timeout_seconds: float) -> str | bytes | None:
        if self.closed.is_set():
            return None
        try:
            item = self._incoming.get(timeout=min(timeout_seconds, 0.05))
        except Empty as exc:
            raise TimeoutError from exc
        if isinstance(item, BaseException):
            raise item
        return item

    def close(self) -> None:
        if not self.closed.is_set():
            self.closed.set()
            self._incoming.put(None)

    def push(self, message: dict[str, Any] | BaseException | None) -> None:
        self._incoming.put(
            json.dumps(message) if isinstance(message, dict) else message
        )

    def wait_for_sent(
        self, predicate: Callable[[list[dict[str, Any]]], bool], timeout: float = 1.0
    ) -> bool:
        deadline = time.monotonic() + timeout
        with self._sent_condition:
            while not predicate(self.sent):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._sent_condition.wait(remaining)
            return True


class FakeFactory:
    def __init__(self, *connections: FakeWebSocket) -> None:
        self.connections = list(connections)
        self.calls: list[tuple[str, float]] = []
        self._lock = Lock()

    def __call__(self, url: str, timeout_seconds: float) -> FakeWebSocket:
        with self._lock:
            index = len(self.calls)
            self.calls.append((url, timeout_seconds))
            if index >= len(self.connections):
                raise ConnectionError("no more fake connections")
            return self.connections[index]


def _ticker_data(
    instrument_name: str,
    *,
    timestamp: datetime = AS_OF,
    message_type: str | None = "snapshot",
    **overrides: Any,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "instrument_name": instrument_name,
        "timestamp": int(timestamp.timestamp() * 1_000),
        "state": "open",
        "best_bid_price": 0.011,
        "best_bid_amount": 2.5,
        "best_ask_price": 0.012,
        "best_ask_amount": 3.5,
        "bid_iv": 49.0,
        "ask_iv": 51.0,
        "mark_iv": 50.0,
        "mark_price": 0.0115,
        "index_price": 100_050.0,
        "underlying_price": 100_100.0,
        "estimated_delivery_price": 100_000.0,
        "open_interest": 123.0,
        "greeks": {"delta": 0.55, "gamma": 0.0001, "vega": 12.0, "theta": -5.0},
    }
    if message_type is not None:
        data["type"] = message_type
    data.update(overrides)
    return data


def _subscription(channel: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "method": "subscription",
        "params": {"channel": channel, "data": data},
    }


def _heartbeat_test_request() -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "method": "heartbeat",
        "params": {"type": "test_request"},
    }


def _instrument_rows(*names: str) -> list[dict[str, Any]]:
    return [
        {
            "instrument_name": name,
            "kind": "option",
            "is_active": True,
            "expiration_timestamp": int(
                datetime(2030, 8, 16, 8, tzinfo=UTC).timestamp() * 1_000
            ),
        }
        for name in names
    ]


def _wait_for(predicate: Callable[[], bool], timeout: float = 1.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


def test_public_incremental_cache_maps_full_ticker_and_heartbeat() -> None:
    clock = MutableClock(AS_OF + timedelta(seconds=1))
    socket = FakeWebSocket()
    factory = FakeFactory(socket)
    source_calls: list[str] = []

    def instruments(*, currency: str) -> list[dict[str, Any]]:
        source_calls.append(currency)
        return [
            *_instrument_rows(CALL, PUT),
            {"instrument_name": "ETH-16AUG30-100-C", "is_active": True},
            {"instrument_name": "BTC-16AUG30-90-C", "is_active": False},
        ]

    socket.push(_heartbeat_test_request())
    socket.push(
        _subscription(
            f"incremental_ticker.{CALL}",
            _ticker_data(CALL),
        )
    )
    socket.push(
        _subscription(
            f"incremental_ticker.{PUT}",
            _ticker_data(PUT, mark_iv=52.0),
        )
    )

    cache = DeribitTickerStreamCache(
        instrument_source=instruments,
        websocket_factory=factory,
        clock=clock,
        stale_after_seconds=5,
    )
    try:
        # Lazy-start plus condition-based expiry completeness; no caller polling.
        snapshot = cache.wait_for_snapshot([CALL, PUT], timeout_seconds=1)
        assert snapshot.healthy is True
        assert snapshot.warmup_complete is True
        assert snapshot.universe_current is True
        assert snapshot.connection_generation == 1
        assert snapshot.active_instrument_names == (CALL, PUT)
        assert snapshot.initialized_quote_count == 2
        assert snapshot.fresh_quote_count == 2
        assert snapshot.missing_quote_count == 0
        assert snapshot.as_of == AS_OF
        assert source_calls == ["BTC"]

        call = cache.get(CALL)
        assert call is not None
        assert call.quote_as_of == AS_OF
        assert call.state == "open"
        assert call.is_open is True
        assert call.best_bid_price == 0.011
        assert call.best_bid_amount == 2.5
        assert call.best_ask_price == 0.012
        assert call.best_ask_amount == 3.5
        assert call.bid_iv == 49.0
        assert call.ask_iv == 51.0
        assert call.mark_iv == 50.0
        assert call.mark_price == 0.0115
        assert call.index_price == 100_050.0
        assert call.underlying_price == 100_100.0
        assert call.estimated_delivery_price == 100_000.0
        assert call.open_interest == 123.0
        assert call.delta == 0.55

        row = snapshot.rows[0]
        assert row["expiry"] == "2030-08-16"
        assert row["strike"] == 100.0
        assert row["option_type"] == "call"
        assert row["bid_size"] == row["bid_amount"] == 2.5
        assert row["ask_size"] == row["ask_amount"] == 3.5

        assert socket.wait_for_sent(
            lambda sent: any(item["method"] == "public/test" for item in sent)
        )
        methods = [message["method"] for message in socket.sent]
        assert methods[0] == "public/set_heartbeat"
        assert set(methods) <= {
            "public/set_heartbeat",
            "public/subscribe",
            "public/test",
        }
        channels = [
            channel
            for message in socket.sent
            for channel in message.get("params", {}).get("channels", [])
        ]
        assert "instrument.state.option.BTC" in channels
        assert f"incremental_ticker.{CALL}" in channels
        assert f"incremental_ticker.{PUT}" in channels
        serialized = json.dumps(socket.sent).lower()
        assert "private/" not in serialized
        assert "public/auth" not in serialized
        assert ".raw" not in serialized

        status = cache.status()
        assert status.connection_state is ConnectionState.CONNECTED
        assert status.channel_mode == "incremental"
        assert status.connected is True
        assert status.healthy is True
        assert status.warmup_complete is True
        assert status.quote_count == status.initialized_quote_count == 2
        assert status.retained_quote_count == 0
        assert status.last_message_at == clock()
    finally:
        assert cache.stop()
    assert socket.closed.is_set()
    assert cache.status().connection_state is ConnectionState.STOPPED


def test_full_ticker_mode_is_public_configurable_and_batches_at_500() -> None:
    names = tuple(f"BTC-31DEC30-{strike}-C" for strike in range(1, 1_002))
    socket = FakeWebSocket()
    cache = DeribitTickerStreamCache(
        channel_mode="ticker",
        channel_interval="agg2",
        instrument_source=lambda *, currency: list(names),
        websocket_factory=FakeFactory(socket),
        clock=lambda: AS_OF,
        max_ticker_subscriptions=1_001,
    )
    try:
        cache.start()
        assert _wait_for(lambda: cache.status().connected)
        ticker_batches = [
            message["params"]["channels"]
            for message in socket.sent
            if message["method"] == "public/subscribe"
            and message["params"]["channels"]
            and message["params"]["channels"][0].startswith("ticker.")
        ]
        assert [len(batch) for batch in ticker_batches] == [500, 500, 1]
        assert all(
            channel.endswith(".agg2")
            for batch in ticker_batches
            for channel in batch
        )
        assert all(len(batch) <= 500 for batch in ticker_batches)
        assert cache.status().subscribed_instrument_count == 1_001
        assert cache.status().channel_mode == "ticker"
    finally:
        assert cache.stop()


def test_instrument_state_dynamically_adds_and_removes_subscriptions() -> None:
    socket = FakeWebSocket()
    cache = DeribitTickerStreamCache(
        instrument_source=lambda *, currency: _instrument_rows(CALL),
        websocket_factory=FakeFactory(socket),
        clock=lambda: AS_OF + timedelta(seconds=1),
    )
    try:
        socket.push(
            _subscription(
                f"incremental_ticker.{CALL}",
                _ticker_data(CALL),
            )
        )
        assert cache.wait_until_ready(1)

        socket.push(
            _subscription(
                cache.instrument_state_channel,
                {
                    "timestamp": int(AS_OF.timestamp() * 1_000),
                    "state": "open",
                    "instrument_name": NEW_CALL,
                },
            )
        )
        assert socket.wait_for_sent(
            lambda sent: any(
                message["method"] == "public/subscribe"
                and f"incremental_ticker.{NEW_CALL}"
                in message["params"].get("channels", [])
                for message in sent
            )
        )
        socket.push(
            _subscription(
                f"incremental_ticker.{NEW_CALL}",
                _ticker_data(NEW_CALL),
            )
        )
        assert cache.wait_until_ready(
            1, instrument_names=[CALL, NEW_CALL]
        )
        assert cache.active_instrument_names() == (CALL, NEW_CALL)

        socket.push(
            _subscription(
                cache.instrument_state_channel,
                {
                    "timestamp": int(AS_OF.timestamp() * 1_000),
                    "state": "delivered",
                    "instrument_name": CALL,
                },
            )
        )
        assert _wait_for(lambda: cache.active_instrument_names() == (NEW_CALL,))
        assert socket.wait_for_sent(
            lambda sent: any(
                message["method"] == "public/unsubscribe"
                and f"incremental_ticker.{CALL}"
                in message["params"].get("channels", [])
                for message in sent
            )
        )
        assert cache.get(CALL) is None
        assert cache.snapshot().healthy is True
    finally:
        assert cache.stop()


def test_incremental_generation_requires_snapshot_and_merges_only_current_fields() -> None:
    first = FakeWebSocket()
    second = FakeWebSocket()
    factory = FakeFactory(first, second)
    source_calls: list[str] = []
    backoffs: list[float] = []

    def instruments(*, currency: str) -> list[dict[str, Any]]:
        source_calls.append(currency)
        return _instrument_rows(CALL)

    first.push(
        _subscription(
            f"incremental_ticker.{CALL}",
            _ticker_data(CALL),
        )
    )
    cache = DeribitTickerStreamCache(
        instrument_source=instruments,
        websocket_factory=factory,
        clock=lambda: AS_OF + timedelta(seconds=5),
        sleeper=lambda seconds: backoffs.append(seconds),
        reconnect_initial_seconds=0.01,
        reconnect_max_seconds=0.02,
        stale_after_seconds=20,
    )
    try:
        assert cache.wait_until_ready(1)
        first.push(ConnectionError("simulated disconnect"))
        assert _wait_for(
            lambda: cache.status().connected
            and cache.status().connection_generation == 2
        )

        # A patch before this generation's snapshot is ignored.  The old quote
        # remains available through get(), but not through the trading snapshot.
        second.push(
            _subscription(
                f"incremental_ticker.{CALL}",
                _ticker_data(
                    CALL,
                    timestamp=AS_OF + timedelta(seconds=1),
                    message_type="change",
                    ask_iv=60.0,
                ),
            )
        )
        assert _wait_for(lambda: cache.status().last_message_at is not None)
        generation_two = cache.snapshot([CALL])
        assert generation_two.quotes == ()
        assert generation_two.initialized_quote_count == 0
        assert generation_two.retained_quote_count == 1
        assert generation_two.missing_quote_count == 1
        assert generation_two.healthy is False
        assert cache.get(CALL) is not None

        # A fresh snapshot is a clean base: omitted fields must not leak from
        # the previous socket generation.
        new_snapshot = _ticker_data(
            CALL,
            timestamp=AS_OF + timedelta(seconds=2),
            best_bid_amount=None,
            best_ask_amount=None,
        )
        new_snapshot.pop("bid_iv")
        second.push(
            _subscription(f"incremental_ticker.{CALL}", new_snapshot)
        )
        assert cache.wait_until_ready(1, instrument_names=[CALL])
        current = cache.get(CALL)
        assert current is not None
        assert current.best_bid_amount is None
        assert current.best_ask_amount is None
        assert current.bid_iv is None

        # Current-generation patches merge only changed fields.
        second.push(
            _subscription(
                f"incremental_ticker.{CALL}",
                {
                    "type": "change",
                    "instrument_name": CALL,
                    "timestamp": int(
                        (AS_OF + timedelta(seconds=3)).timestamp() * 1_000
                    ),
                    "ask_iv": 61.0,
                },
            )
        )
        assert _wait_for(lambda: cache.get(CALL).ask_iv == 61.0)  # type: ignore[union-attr]
        assert cache.get(CALL).mark_iv == 50.0  # type: ignore[union-attr]

        # An out-of-order patch cannot roll the quote back.
        second.push(
            _subscription(
                f"incremental_ticker.{CALL}",
                {
                    "type": "change",
                    "instrument_name": CALL,
                    "timestamp": int(
                        (AS_OF + timedelta(seconds=2, milliseconds=500)).timestamp()
                        * 1_000
                    ),
                    "ask_iv": 99.0,
                },
            )
        )
        time.sleep(0.05)
        assert cache.get(CALL).ask_iv == 61.0  # type: ignore[union-attr]

        status = cache.status()
        assert status.connection_generation == 2
        assert status.reconnect_count == 1
        assert status.last_error is not None
        assert "simulated disconnect" in status.last_error
        assert source_calls == ["BTC", "BTC"]
        assert backoffs == [0.01]
    finally:
        assert cache.stop()


def test_stale_and_reconnecting_feeds_fail_closed_but_retain_diagnostics() -> None:
    clock = MutableClock(AS_OF + timedelta(seconds=1))
    socket = FakeWebSocket()
    factory = FakeFactory(socket)
    reconnect_waiting = Event()
    release_reconnect = Event()

    def sleeper(_: float) -> None:
        reconnect_waiting.set()
        release_reconnect.wait(1)

    socket.push(
        _subscription(
            f"incremental_ticker.{CALL}",
            _ticker_data(CALL),
        )
    )
    cache = DeribitTickerStreamCache(
        instrument_source=lambda *, currency: _instrument_rows(CALL),
        websocket_factory=factory,
        clock=clock,
        sleeper=sleeper,
        stale_after_seconds=5,
    )
    try:
        assert cache.wait_until_ready(1)
        clock.advance(10)
        stale = cache.snapshot([CALL])
        assert stale.healthy is False
        assert stale.stale_quote_count == 1
        assert cache.wait_until_ready(
            0.02, instrument_names=[CALL], start_if_needed=False
        ) is False

        socket.push(ConnectionError("network down"))
        assert reconnect_waiting.wait(1)
        status = cache.status()
        assert status.connection_state is ConnectionState.RECONNECTING
        assert status.connected is False
        assert status.universe_current is False
        assert status.quote_count == status.initialized_quote_count == 0
        assert status.retained_quote_count == 1
        assert status.healthy is False

        disconnected = cache.snapshot([CALL])
        assert disconnected.quotes == ()
        assert disconnected.missing_quote_count == 1
        assert disconnected.retained_quote_count == 1
        assert disconnected.healthy is False
        assert cache.get(CALL) is not None
    finally:
        release_reconnect.set()
        assert cache.stop()


def test_subscription_budget_prefers_near_dated_and_pins_requested() -> None:
    near = tuple(f"BTC-16AUG30-{strike}-C" for strike in range(80, 85))
    far = tuple(f"BTC-16AUG31-{strike}-C" for strike in range(80, 86))
    socket = FakeWebSocket()
    cache = DeribitTickerStreamCache(
        instrument_source=lambda *, currency: _instrument_rows(*near, *far),
        websocket_factory=FakeFactory(socket),
        clock=lambda: AS_OF,
        max_ticker_subscriptions=6,
        receive_timeout_seconds=0.05,
    )
    try:
        cache.start()
        connected = _wait_for(lambda: cache.status().connected, timeout=2)
        assert connected, cache.status()
        assert _wait_for(
            lambda: cache.status().subscribed_instrument_count == 6,
            timeout=2,
        )
        initial = {
            channel.split(".", 1)[1]
            for message in socket.sent
            if message.get("method") == "public/subscribe"
            for channel in message.get("params", {}).get("channels", [])
            if str(channel).startswith("incremental_ticker.")
        }
        assert set(near) <= initial
        assert len(initial) == 6

        cache.request_tickers([far[-1]])
        assert _wait_for(
            lambda: any(
                message.get("method") == "public/unsubscribe"
                for message in socket.sent
            ),
            timeout=2,
        )
        subscribed = {
            channel.split(".", 1)[1]
            for message in socket.sent
            if message.get("method") == "public/subscribe"
            for channel in message.get("params", {}).get("channels", [])
            if str(channel).startswith("incremental_ticker.")
        }
        unsubscribed = {
            channel.split(".", 1)[1]
            for message in socket.sent
            if message.get("method") == "public/unsubscribe"
            for channel in message.get("params", {}).get("channels", [])
            if str(channel).startswith("incremental_ticker.")
        }
        assert far[-1] in subscribed
        assert cache.status().subscribed_instrument_count == 6
        assert unsubscribed
    finally:
        assert cache.stop()


def test_incremental_change_uses_channel_name_and_ignores_null_fields() -> None:
    socket = FakeWebSocket()
    socket.push(
        _subscription(f"incremental_ticker.{CALL}", _ticker_data(CALL))
    )
    cache = DeribitTickerStreamCache(
        instrument_source=lambda *, currency: _instrument_rows(CALL),
        websocket_factory=FakeFactory(socket),
        clock=lambda: AS_OF + timedelta(seconds=1),
        receive_timeout_seconds=0.05,
    )
    try:
        assert cache.wait_until_ready(1)
        socket.push(
            _subscription(
                f"incremental_ticker.{CALL}",
                {
                    "type": "change",
                    "timestamp": int((AS_OF + timedelta(seconds=1)).timestamp() * 1_000),
                    "ask_iv": 55.0,
                    "bid_iv": None,
                    "best_bid_amount": None,
                },
            )
        )
        assert _wait_for(lambda: cache.get(CALL) is not None and cache.get(CALL).ask_iv == 55.0)  # type: ignore[union-attr]
        quote = cache.get(CALL)
        assert quote is not None
        assert quote.ask_iv == 55.0
        assert quote.bid_iv == 49.0
        assert quote.best_bid_amount == 2.5
        assert quote.instrument_name == CALL
    finally:
        assert cache.stop()


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"channel_interval": "raw"}, "raw requires auth"),
        ({"channel_mode": "unknown"}, "channel_mode"),
        ({"subscription_batch_size": 501}, "between 1 and 500"),
        ({"heartbeat_seconds": 9}, "at least 10"),
    ],
)
def test_public_stream_configuration_rejects_unsafe_values(
    kwargs: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        DeribitTickerStreamCache(**kwargs)
