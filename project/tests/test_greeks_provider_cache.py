from __future__ import annotations

import threading
import time
from typing import Any

import httpx
import pytest

from greeks.providers import (
    DEFAULT_GREEKS_CACHE_TTL_SECONDS,
    DEFAULT_GREEKS_CONCURRENCY,
    DEFAULT_GREEKS_429_MAX_RETRIES,
    DeribitPublicGreeksProvider,
    GreeksLiveCache,
    resolve_greeks_cache_ttl_seconds,
    resolve_greeks_concurrency,
    reset_process_greeks_cache,
)
from greeks.types import GreekSnapshot


def _ticker_payload(
    instrument_name: str,
    *,
    gamma: float = 0.0001,
    spot: float = 100_000.0,
    status_code: int = 200,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    if status_code != 200:
        return httpx.Response(
            status_code,
            json={"error": {"message": "bad request"}},
            headers=headers or {},
        )
    return httpx.Response(
        200,
        json={
            "result": {
                "instrument_name": instrument_name,
                "timestamp": 1_700_000_000_000,
                "underlying_price": spot,
                "open_interest": 10.0,
                "mark_iv": 55.0,
                "greeks": {"gamma": gamma, "delta": 0.5, "theta": -10.0, "vega": 20.0},
            }
        },
        headers=headers or {},
    )


def _make_handler(
    call_log: list[str],
    *,
    bad_names: set[str] | None = None,
    fail_names: set[str] | None = None,
    rate_limit_names: dict[str, int] | None = None,
    rate_limit_forever: set[str] | None = None,
    retry_after_seconds: float | None = None,
    max_in_flight: list[int] | None = None,
    hold_seconds: float = 0.0,
) -> Any:
    """Build a MockTransport handler.

    ``rate_limit_names`` maps instrument → number of initial 429 responses
    before a successful 200. ``rate_limit_forever`` always returns 429.
    """
    bad_names = bad_names or set()
    fail_names = fail_names or set()
    rate_limit_names = dict(rate_limit_names or {})
    rate_limit_forever = rate_limit_forever or set()
    remaining_429 = dict(rate_limit_names)
    lock = threading.Lock()
    active = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/public/ticker")
        name = request.url.params["instrument_name"]
        with lock:
            call_log.append(name)
            active["n"] += 1
            if max_in_flight is not None:
                max_in_flight[0] = max(max_in_flight[0], active["n"])

        try:
            if hold_seconds > 0:
                time.sleep(hold_seconds)
            if name in fail_names:
                return httpx.Response(500, json={"error": {"message": "upstream"}})
            if name in bad_names:
                return _ticker_payload(name, status_code=400)
            if name in rate_limit_forever:
                headers = {}
                if retry_after_seconds is not None:
                    headers["Retry-After"] = str(retry_after_seconds)
                return _ticker_payload(name, status_code=429, headers=headers)
            with lock:
                left = remaining_429.get(name, 0)
                if left > 0:
                    remaining_429[name] = left - 1
                    headers = {}
                    if retry_after_seconds is not None:
                        headers["Retry-After"] = str(retry_after_seconds)
                    return _ticker_payload(name, status_code=429, headers=headers)
            return _ticker_payload(name, gamma=0.001 * (len(name) % 7 + 1))
        finally:
            with lock:
                active["n"] -= 1

    return handler


@pytest.fixture(autouse=True)
def _reset_process_cache() -> None:
    reset_process_greeks_cache()
    yield
    reset_process_greeks_cache()


def test_cache_ttl_and_get_put() -> None:
    cache = GreeksLiveCache(ttl_seconds=0.05)
    snap = GreekSnapshot(
        instrument_name="BTC-31DEC26-100000-C",
        gamma=0.0002,
        spot_price=100000.0,
        snapshot_ts=1,
    )
    cache.put(snap, now=100.0)
    assert cache.get("BTC-31DEC26-100000-C", now=100.01) == snap
    assert cache.get("BTC-31DEC26-100000-C", now=100.06) is None
    assert len(cache) == 0


def test_cache_disabled_when_ttl_zero() -> None:
    cache = GreeksLiveCache(ttl_seconds=0)
    snap = GreekSnapshot(
        instrument_name="BTC-31DEC26-100000-C",
        gamma=0.0002,
        spot_price=100000.0,
        snapshot_ts=1,
    )
    cache.put(snap)
    assert cache.get("BTC-31DEC26-100000-C") is None


def test_fetch_reuses_cache_within_ttl() -> None:
    call_log: list[str] = []
    transport = httpx.MockTransport(_make_handler(call_log))
    cache = GreeksLiveCache(ttl_seconds=60)

    with DeribitPublicGreeksProvider(
        transport=transport,
        cache=cache,
        use_process_cache=False,
        max_concurrency=4,
        inter_batch_delay_seconds=0.0,
    ) as provider:
        first = provider.fetch_greeks_for_instruments(
            ["BTC-A", "BTC-B", "BTC-C"]
        )
        assert set(first) == {"BTC-A", "BTC-B", "BTC-C"}
        assert provider.last_stats.fetched_count == 3
        assert provider.last_stats.cache_hits == 0
        assert sorted(call_log) == ["BTC-A", "BTC-B", "BTC-C"]

        call_log.clear()
        second = provider.fetch_greeks_for_instruments(
            ["BTC-A", "BTC-B", "BTC-C"]
        )
        assert second == first
        assert provider.last_stats.fetched_count == 0
        assert provider.last_stats.cache_hits == 3
        assert call_log == []


def test_fetch_only_refreshes_stale_or_missing() -> None:
    call_log: list[str] = []
    transport = httpx.MockTransport(_make_handler(call_log))
    cache = GreeksLiveCache(ttl_seconds=60)
    stale = GreekSnapshot(
        instrument_name="BTC-A",
        gamma=9.9,
        spot_price=1.0,
        snapshot_ts=1,
    )
    # Force BTC-A expired by writing with an old monotonic clock.
    cache.put(stale, now=time.monotonic() - 120)

    with DeribitPublicGreeksProvider(
        transport=transport,
        cache=cache,
        use_process_cache=False,
        max_concurrency=4,
        inter_batch_delay_seconds=0.0,
    ) as provider:
        out = provider.fetch_greeks_for_instruments(["BTC-A", "BTC-B"])
        assert set(out) == {"BTC-A", "BTC-B"}
        assert out["BTC-A"].gamma != 9.9
        assert provider.last_stats.fetched_count == 2
        assert provider.last_stats.cache_hits == 0
        assert sorted(call_log) == ["BTC-A", "BTC-B"]

        call_log.clear()
        # Seed only BTC-B as fresh; BTC-C is new.
        out2 = provider.fetch_greeks_for_instruments(["BTC-B", "BTC-C"])
        assert provider.last_stats.cache_hits == 1
        assert provider.last_stats.fetched_count == 1
        assert call_log == ["BTC-C"]
        assert "BTC-B" in out2 and "BTC-C" in out2


def test_http_400_skips_instrument_other_errors_raise() -> None:
    call_log: list[str] = []
    transport = httpx.MockTransport(
        _make_handler(call_log, bad_names={"BTC-BAD"}, fail_names={"BTC-FAIL"})
    )
    with DeribitPublicGreeksProvider(
        transport=transport,
        cache=GreeksLiveCache(ttl_seconds=60),
        use_process_cache=False,
        max_concurrency=4,
        inter_batch_delay_seconds=0.0,
    ) as provider:
        ok = provider.fetch_greeks_for_instruments(["BTC-OK", "BTC-BAD"])
        assert set(ok) == {"BTC-OK"}
        assert provider.last_stats.fetched_count == 1
        assert provider.last_stats.skipped_count == 1

        with pytest.raises(httpx.HTTPStatusError):
            provider.fetch_greeks_for_instruments(["BTC-FAIL"])


def test_http_429_retries_then_succeeds() -> None:
    call_log: list[str] = []
    sleeps: list[float] = []
    transport = httpx.MockTransport(
        _make_handler(call_log, rate_limit_names={"BTC-RL": 2})
    )
    with DeribitPublicGreeksProvider(
        transport=transport,
        cache=GreeksLiveCache(ttl_seconds=0),
        use_process_cache=False,
        max_concurrency=2,
        inter_batch_delay_seconds=0.0,
        sleep_fn=sleeps.append,
    ) as provider:
        out = provider.fetch_greeks_for_instruments(["BTC-OK", "BTC-RL"])

    assert set(out) == {"BTC-OK", "BTC-RL"}
    assert call_log.count("BTC-RL") == 3  # 2x 429 + 1x success
    assert call_log.count("BTC-OK") == 1
    assert provider.last_stats.rate_limit_count == 2
    assert provider.last_stats.skipped_after_retries == 0
    assert provider.last_stats.fetched_count == 2
    assert sleeps == [1.0, 2.0]


def test_http_429_skips_after_retries_without_failing_cycle() -> None:
    call_log: list[str] = []
    sleeps: list[float] = []
    transport = httpx.MockTransport(
        _make_handler(
            call_log,
            rate_limit_forever={"BTC-RL"},
            fail_names=set(),
        )
    )
    with DeribitPublicGreeksProvider(
        transport=transport,
        cache=GreeksLiveCache(ttl_seconds=0),
        use_process_cache=False,
        max_concurrency=2,
        inter_batch_delay_seconds=0.0,
        sleep_fn=sleeps.append,
        max_429_retries=3,
    ) as provider:
        out = provider.fetch_greeks_for_instruments(["BTC-OK", "BTC-RL", "BTC-OK2"])

    assert set(out) == {"BTC-OK", "BTC-OK2"}
    assert "BTC-RL" not in out
    # initial + 3 retries
    assert call_log.count("BTC-RL") == DEFAULT_GREEKS_429_MAX_RETRIES + 1
    assert provider.last_stats.rate_limit_count == DEFAULT_GREEKS_429_MAX_RETRIES + 1
    assert provider.last_stats.skipped_after_retries == 1
    assert provider.last_stats.skipped_count >= 1
    assert provider.last_stats.fetched_count == 2
    assert sleeps == [1.0, 2.0, 4.0]
    assert provider.last_stats.to_dict()["greeks_429_count"] == (
        DEFAULT_GREEKS_429_MAX_RETRIES + 1
    )
    assert provider.last_stats.to_dict()["greeks_skipped_after_retries"] == 1


def test_http_429_respects_retry_after_header() -> None:
    call_log: list[str] = []
    sleeps: list[float] = []
    transport = httpx.MockTransport(
        _make_handler(
            call_log,
            rate_limit_names={"BTC-RL": 1},
            retry_after_seconds=3.5,
        )
    )
    with DeribitPublicGreeksProvider(
        transport=transport,
        cache=GreeksLiveCache(ttl_seconds=0),
        use_process_cache=False,
        max_concurrency=1,
        inter_batch_delay_seconds=0.0,
        sleep_fn=sleeps.append,
    ) as provider:
        out = provider.fetch_greeks_for_instruments(["BTC-RL"])

    assert "BTC-RL" in out
    # max(backoff=1.0, Retry-After=3.5) == 3.5
    assert sleeps == [3.5]
    assert provider.last_stats.rate_limit_count == 1
    assert provider.last_stats.skipped_after_retries == 0


def test_concurrent_fetch_respects_max_concurrency() -> None:
    call_log: list[str] = []
    max_in_flight = [0]
    names = [f"BTC-{i:03d}" for i in range(16)]
    # Brief hold so overlapping workers are observable under the concurrency cap.
    transport = httpx.MockTransport(
        _make_handler(
            call_log,
            max_in_flight=max_in_flight,
            hold_seconds=0.03,
        )
    )

    with DeribitPublicGreeksProvider(
        transport=transport,
        cache=GreeksLiveCache(ttl_seconds=0),  # force network for all
        use_process_cache=False,
        max_concurrency=4,
        inter_batch_delay_seconds=0.0,
    ) as provider:
        out = provider.fetch_greeks_for_instruments(names)

    assert len(out) == 16
    assert len(call_log) == 16
    assert max_in_flight[0] <= 4
    assert max_in_flight[0] >= 2  # concurrency actually used


def test_process_cache_shared_across_provider_instances() -> None:
    call_log: list[str] = []
    transport = httpx.MockTransport(_make_handler(call_log))

    with DeribitPublicGreeksProvider(
        transport=transport,
        use_process_cache=True,
        cache_ttl_seconds=120,
        max_concurrency=2,
        inter_batch_delay_seconds=0.0,
    ) as first:
        first.fetch_greeks_for_instruments(["BTC-X"])
        assert first.last_stats.fetched_count == 1

    call_log.clear()
    with DeribitPublicGreeksProvider(
        transport=transport,
        use_process_cache=True,
        max_concurrency=2,
        inter_batch_delay_seconds=0.0,
    ) as second:
        second.fetch_greeks_for_instruments(["BTC-X"])
        assert second.last_stats.cache_hits == 1
        assert second.last_stats.fetched_count == 0
        assert call_log == []


def test_resolve_config_from_env_and_args(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOTUS_GREEKS_CACHE_TTL_SECONDS", raising=False)
    monkeypatch.delenv("LOTUS_GREEKS_CONCURRENCY", raising=False)
    assert resolve_greeks_cache_ttl_seconds() == DEFAULT_GREEKS_CACHE_TTL_SECONDS
    assert resolve_greeks_concurrency() == DEFAULT_GREEKS_CONCURRENCY
    assert DEFAULT_GREEKS_CONCURRENCY == 5

    monkeypatch.setenv("LOTUS_GREEKS_CACHE_TTL_SECONDS", "180")
    monkeypatch.setenv("LOTUS_GREEKS_CONCURRENCY", "12")
    assert resolve_greeks_cache_ttl_seconds() == 180.0
    assert resolve_greeks_concurrency() == 12

    assert resolve_greeks_cache_ttl_seconds(90) == 90.0
    assert resolve_greeks_concurrency(8) == 8
