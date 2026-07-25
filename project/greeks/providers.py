from __future__ import annotations

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable, Mapping, Protocol

import httpx

from greeks.types import GreekSnapshot

logger = logging.getLogger(__name__)

# Conservative defaults: short-lived cache + modest concurrency so live cycles
# stay correct without hammering Deribit public tickers.
DEFAULT_GREEKS_CACHE_TTL_SECONDS = 210.0
DEFAULT_GREEKS_CONCURRENCY = 5
ENV_GREEKS_CACHE_TTL_SECONDS = "LOTUS_GREEKS_CACHE_TTL_SECONDS"
ENV_GREEKS_CONCURRENCY = "LOTUS_GREEKS_CONCURRENCY"

# Per-instrument 429 policy: exponential backoff 1s → 2s → 4s, then skip.
DEFAULT_GREEKS_429_MAX_RETRIES = 3
DEFAULT_GREEKS_429_BACKOFF_SECONDS = (1.0, 2.0, 4.0)
# Optional tiny pause between ticker batches to reduce burst pressure on Deribit.
DEFAULT_GREEKS_INTER_BATCH_DELAY_SECONDS = 0.05
ENV_GREEKS_INTER_BATCH_DELAY_SECONDS = "LOTUS_GREEKS_INTER_BATCH_DELAY_SECONDS"

# Process-wide cache shared across materialize cycles in the live worker.
_PROCESS_GREEKS_CACHE: "GreeksLiveCache | None" = None
_PROCESS_GREEKS_CACHE_LOCK = threading.Lock()


class GreeksProvider(Protocol):
    def fetch_current_option_greeks(self, currency: str = "BTC") -> dict[str, GreekSnapshot]:
        ...


@dataclass(frozen=True, slots=True)
class GreeksFetchStats:
    """Per-call fetch accounting for observability."""

    requested_count: int
    fetched_count: int
    cache_hits: int
    skipped_count: int = 0
    rate_limit_count: int = 0
    skipped_after_retries: int = 0
    wall_seconds: float = 0.0

    def to_dict(self) -> dict[str, float | int]:
        return {
            "greeks_requested_count": self.requested_count,
            "greeks_fetched_count": self.fetched_count,
            "greeks_cache_hits": self.cache_hits,
            "greeks_skipped_count": self.skipped_count,
            "greeks_429_count": self.rate_limit_count,
            "greeks_skipped_after_retries": self.skipped_after_retries,
            "greeks_wall_seconds": self.wall_seconds,
        }


@dataclass
class _TickerAttemptResult:
    """Internal result for one instrument fetch (including 429 accounting)."""

    snapshot: GreekSnapshot | None
    rate_limit_hits: int = 0
    skipped_after_retries: bool = False


class GreeksLiveCache:
    """Short-lived in-memory Greeks cache keyed by instrument_name."""

    def __init__(self, ttl_seconds: float = DEFAULT_GREEKS_CACHE_TTL_SECONDS) -> None:
        self._ttl_seconds = max(float(ttl_seconds), 0.0)
        self._entries: dict[str, tuple[GreekSnapshot, float]] = {}
        self._lock = threading.Lock()

    @property
    def ttl_seconds(self) -> float:
        return self._ttl_seconds

    def get(self, instrument_name: str, *, now: float | None = None) -> GreekSnapshot | None:
        if self._ttl_seconds <= 0:
            return None
        monotonic_now = time.monotonic() if now is None else now
        with self._lock:
            entry = self._entries.get(instrument_name)
            if entry is None:
                return None
            snapshot, stored_at = entry
            if monotonic_now - stored_at > self._ttl_seconds:
                del self._entries[instrument_name]
                return None
            return snapshot

    def put(self, snapshot: GreekSnapshot, *, now: float | None = None) -> None:
        if self._ttl_seconds <= 0:
            return
        monotonic_now = time.monotonic() if now is None else now
        with self._lock:
            self._entries[snapshot.instrument_name] = (snapshot, monotonic_now)

    def put_many(self, snapshots: Mapping[str, GreekSnapshot], *, now: float | None = None) -> None:
        if self._ttl_seconds <= 0 or not snapshots:
            return
        monotonic_now = time.monotonic() if now is None else now
        with self._lock:
            for name, snapshot in snapshots.items():
                self._entries[str(name)] = (snapshot, monotonic_now)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


def get_process_greeks_cache(
    *,
    ttl_seconds: float | None = None,
) -> GreeksLiveCache:
    """Return the process-wide Greeks cache (created on first use).

    ``ttl_seconds`` is applied only when the cache is first created. Subsequent
    calls reuse the existing instance so live refresh cycles share state.
    """
    global _PROCESS_GREEKS_CACHE
    with _PROCESS_GREEKS_CACHE_LOCK:
        if _PROCESS_GREEKS_CACHE is None:
            resolved_ttl = (
                DEFAULT_GREEKS_CACHE_TTL_SECONDS
                if ttl_seconds is None
                else float(ttl_seconds)
            )
            _PROCESS_GREEKS_CACHE = GreeksLiveCache(ttl_seconds=resolved_ttl)
        return _PROCESS_GREEKS_CACHE


def reset_process_greeks_cache() -> None:
    """Drop the process-wide cache (tests / explicit operator reset)."""
    global _PROCESS_GREEKS_CACHE
    with _PROCESS_GREEKS_CACHE_LOCK:
        if _PROCESS_GREEKS_CACHE is not None:
            _PROCESS_GREEKS_CACHE.clear()
        _PROCESS_GREEKS_CACHE = None


def resolve_greeks_cache_ttl_seconds(explicit: float | None = None) -> float:
    if explicit is not None:
        return max(float(explicit), 0.0)
    return max(_env_float(ENV_GREEKS_CACHE_TTL_SECONDS, DEFAULT_GREEKS_CACHE_TTL_SECONDS), 0.0)


def resolve_greeks_concurrency(explicit: int | None = None) -> int:
    if explicit is not None:
        return max(int(explicit), 1)
    return max(_env_int(ENV_GREEKS_CONCURRENCY, DEFAULT_GREEKS_CONCURRENCY), 1)


def resolve_greeks_inter_batch_delay_seconds(explicit: float | None = None) -> float:
    if explicit is not None:
        return max(float(explicit), 0.0)
    return max(
        _env_float(
            ENV_GREEKS_INTER_BATCH_DELAY_SECONDS,
            DEFAULT_GREEKS_INTER_BATCH_DELAY_SECONDS,
        ),
        0.0,
    )


class StaticGreeksProvider:
    def __init__(self, snapshots: Mapping[str, GreekSnapshot]) -> None:
        self._snapshots = dict(snapshots)

    def fetch_current_option_greeks(self, currency: str = "BTC") -> dict[str, GreekSnapshot]:
        _validate_currency(currency)
        return dict(self._snapshots)

    @classmethod
    def from_json(cls, path: str | Path) -> "StaticGreeksProvider":
        return cls(load_greeks_snapshot_json(path))


class DeribitPublicGreeksProvider:
    def __init__(
        self,
        base_url: str = "https://www.deribit.com/api/v2",
        timeout_seconds: float = 10.0,
        transport: httpx.BaseTransport | None = None,
        *,
        cache: GreeksLiveCache | None = None,
        use_process_cache: bool = True,
        cache_ttl_seconds: float | None = None,
        max_concurrency: int | None = None,
        max_429_retries: int = DEFAULT_GREEKS_429_MAX_RETRIES,
        inter_batch_delay_seconds: float | None = None,
        sleep_fn: Callable[[float], None] | None = None,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout_seconds,
            headers={"Accept": "application/json"},
            transport=transport,
        )
        resolved_ttl = resolve_greeks_cache_ttl_seconds(cache_ttl_seconds)
        if cache is not None:
            self._cache: GreeksLiveCache | None = cache
        elif use_process_cache:
            self._cache = get_process_greeks_cache(ttl_seconds=resolved_ttl)
        else:
            self._cache = GreeksLiveCache(ttl_seconds=resolved_ttl)
        self._max_concurrency = resolve_greeks_concurrency(max_concurrency)
        self._max_429_retries = max(int(max_429_retries), 0)
        self._inter_batch_delay_seconds = resolve_greeks_inter_batch_delay_seconds(
            inter_batch_delay_seconds
        )
        self._sleep = sleep_fn if sleep_fn is not None else time.sleep
        self._last_stats = GreeksFetchStats(
            requested_count=0,
            fetched_count=0,
            cache_hits=0,
        )

    @property
    def last_stats(self) -> GreeksFetchStats:
        return self._last_stats

    @property
    def cache(self) -> GreeksLiveCache | None:
        return self._cache

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "DeribitPublicGreeksProvider":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def fetch_current_option_greeks(self, currency: str = "BTC") -> dict[str, GreekSnapshot]:
        _validate_currency(currency)

        response = self._client.get(
            "/public/get_book_summary_by_currency",
            params={"currency": currency.upper(), "kind": "option"},
        )
        response.raise_for_status()
        payload = response.json()

        result = payload.get("result")
        if not isinstance(result, list):
            raise ValueError(f"Unexpected Deribit payload: {payload}")

        instrument_names = [
            str(row["instrument_name"])
            for row in result
            if row.get("instrument_name")
        ]
        return self.fetch_greeks_for_instruments(instrument_names)

    def fetch_greeks_for_instruments(
        self,
        instrument_names: Iterable[str],
    ) -> dict[str, GreekSnapshot]:
        """Fetch option Greeks for the given instruments with TTL cache + concurrency.

        Cache key is ``instrument_name``. Fresh network tickers are issued only for
        names whose cache entry is missing or older than the TTL.

        Error policy (per instrument, partial success):
        - HTTP 400: skip (expired / invalid name).
        - HTTP 429: retry with exponential backoff; skip if still failing.
        - Other HTTP errors: propagate (fail the call).
        """
        started = time.perf_counter()
        names = sorted({str(name) for name in instrument_names if name})
        snapshots: dict[str, GreekSnapshot] = {}
        to_fetch: list[str] = []
        cache_hits = 0
        now = time.monotonic()

        for name in names:
            cached = self._cache.get(name, now=now) if self._cache is not None else None
            if cached is not None:
                snapshots[name] = cached
                cache_hits += 1
            else:
                to_fetch.append(name)

        fetched, rate_limit_count, skipped_after_retries, rate_limited_names = (
            self._fetch_tickers_concurrent(to_fetch)
        )
        if self._cache is not None and fetched:
            self._cache.put_many(fetched, now=time.monotonic())
        snapshots.update(fetched)

        skipped = len(to_fetch) - len(fetched)
        wall_seconds = round(time.perf_counter() - started, 3)
        self._last_stats = GreeksFetchStats(
            requested_count=len(names),
            fetched_count=len(fetched),
            cache_hits=cache_hits,
            skipped_count=max(skipped, 0),
            rate_limit_count=rate_limit_count,
            skipped_after_retries=skipped_after_retries,
            wall_seconds=wall_seconds,
        )
        logger.info(
            "greeks fetch: requested=%s fetched=%s cache_hits=%s skipped=%s "
            "greeks_429_count=%s greeks_skipped_after_retries=%s concurrency=%s "
            "wall_seconds=%.3f",
            self._last_stats.requested_count,
            self._last_stats.fetched_count,
            self._last_stats.cache_hits,
            self._last_stats.skipped_count,
            self._last_stats.rate_limit_count,
            self._last_stats.skipped_after_retries,
            self._max_concurrency,
            self._last_stats.wall_seconds,
        )
        if rate_limit_count > 0:
            logger.warning(
                "greeks 429 summary: count=%s instruments_affected=%s "
                "skipped_after_retries=%s examples=%s",
                rate_limit_count,
                len(rate_limited_names),
                skipped_after_retries,
                rate_limited_names[:20],
            )
        return snapshots

    def _fetch_tickers_concurrent(
        self,
        instrument_names: list[str],
    ) -> tuple[dict[str, GreekSnapshot], int, int, list[str]]:
        if not instrument_names:
            return {}, 0, 0, []

        # Single instrument: avoid thread pool overhead.
        if len(instrument_names) == 1:
            result = self._fetch_one_ticker(instrument_names[0])
            snapshots = (
                {instrument_names[0]: result.snapshot}
                if result.snapshot is not None
                else {}
            )
            rate_limited = [instrument_names[0]] if result.rate_limit_hits > 0 else []
            return (
                snapshots,
                result.rate_limit_hits,
                1 if result.skipped_after_retries else 0,
                rate_limited,
            )

        workers = min(self._max_concurrency, len(instrument_names))
        snapshots: dict[str, GreekSnapshot] = {}
        rate_limit_count = 0
        skipped_after_retries = 0
        rate_limited_names: list[str] = []
        # Process in batches of ``workers`` so we can insert a tiny inter-batch
        # delay and avoid sustained full-burst pressure on public tickers.
        for batch_start in range(0, len(instrument_names), workers):
            if batch_start > 0 and self._inter_batch_delay_seconds > 0:
                self._sleep(self._inter_batch_delay_seconds)
            batch = instrument_names[batch_start : batch_start + workers]
            with ThreadPoolExecutor(max_workers=workers) as executor:
                future_map = {
                    executor.submit(self._fetch_one_ticker, name): name
                    for name in batch
                }
                for future in as_completed(future_map):
                    name = future_map[future]
                    # Propagate non-400/429 errors; soft failures return result.
                    result = future.result()
                    rate_limit_count += result.rate_limit_hits
                    if result.rate_limit_hits > 0:
                        rate_limited_names.append(name)
                    if result.skipped_after_retries:
                        skipped_after_retries += 1
                    if result.snapshot is not None:
                        snapshots[name] = result.snapshot
        return snapshots, rate_limit_count, skipped_after_retries, rate_limited_names

    def _fetch_one_ticker(self, instrument_name: str) -> _TickerAttemptResult:
        fallback_snapshot_ts = int(time.time() * 1000)
        rate_limit_hits = 0
        max_attempts = self._max_429_retries + 1

        for attempt in range(max_attempts):
            response = self._client.get(
                "/public/ticker",
                params={"instrument_name": instrument_name},
            )
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                status = (
                    exc.response.status_code if exc.response is not None else None
                )
                if status == 400:
                    return _TickerAttemptResult(snapshot=None)
                if status == 429:
                    rate_limit_hits += 1
                    if attempt >= self._max_429_retries:
                        logger.warning(
                            "greeks 429: skipping instrument after %s retries: %s",
                            self._max_429_retries,
                            instrument_name,
                        )
                        return _TickerAttemptResult(
                            snapshot=None,
                            rate_limit_hits=rate_limit_hits,
                            skipped_after_retries=True,
                        )
                    delay = self._resolve_429_delay(attempt, response)
                    logger.warning(
                        "greeks 429: instrument=%s attempt=%s/%s sleep=%.2fs",
                        instrument_name,
                        attempt + 1,
                        self._max_429_retries,
                        delay,
                    )
                    self._sleep(delay)
                    continue
                raise

            payload = response.json()
            result = payload.get("result")
            if not isinstance(result, dict):
                return _TickerAttemptResult(
                    snapshot=None,
                    rate_limit_hits=rate_limit_hits,
                )

            greeks = result.get("greeks") or {}
            gamma = greeks.get("gamma")
            spot_price = self._extract_spot_price(result)
            open_interest = _maybe_float(result.get("open_interest"))
            mark_iv = _maybe_float(result.get("mark_iv") or result.get("iv"))
            delta = _maybe_float(greeks.get("delta"))
            snapshot_ts = int(result.get("timestamp") or fallback_snapshot_ts)

            if gamma is None or spot_price is None:
                return _TickerAttemptResult(
                    snapshot=None,
                    rate_limit_hits=rate_limit_hits,
                )

            return _TickerAttemptResult(
                snapshot=GreekSnapshot(
                    instrument_name=instrument_name,
                    gamma=float(gamma),
                    spot_price=float(spot_price),
                    snapshot_ts=snapshot_ts,
                    open_interest=open_interest,
                    mark_iv=mark_iv,
                    delta=delta,
                ),
                rate_limit_hits=rate_limit_hits,
            )

        # Exhausted attempts without a successful non-429 path (defensive).
        return _TickerAttemptResult(
            snapshot=None,
            rate_limit_hits=rate_limit_hits,
            skipped_after_retries=rate_limit_hits > 0,
        )

    def _resolve_429_delay(self, attempt: int, response: httpx.Response) -> float:
        """Exponential backoff (1s → 2s → 4s), honoring Retry-After when larger."""
        backoff_index = min(attempt, len(DEFAULT_GREEKS_429_BACKOFF_SECONDS) - 1)
        base = DEFAULT_GREEKS_429_BACKOFF_SECONDS[backoff_index]
        retry_after = _parse_retry_after(response)
        if retry_after is not None:
            return max(base, retry_after)
        return base

    @staticmethod
    def _extract_spot_price(row: dict[str, object]) -> float | None:
        for key in (
            "underlying_price",
            "index_price",
            "underlying_index_price",
            "estimated_delivery_price",
        ):
            value = row.get(key)
            if value is not None:
                return float(value)
        return None


def write_greeks_snapshot_json(
    snapshots: Mapping[str, GreekSnapshot],
    path: str | Path,
) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = [asdict(snapshot) for _, snapshot in sorted(snapshots.items(), key=lambda item: item[0])]
    target.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def load_greeks_snapshot_json(path: str | Path) -> dict[str, GreekSnapshot]:
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    snapshots: dict[str, GreekSnapshot] = {}

    for row in rows:
        snapshot = GreekSnapshot(
            instrument_name=str(row["instrument_name"]),
            gamma=float(row["gamma"]),
            spot_price=float(row["spot_price"]),
            snapshot_ts=int(row["snapshot_ts"]),
            open_interest=_maybe_float(row.get("open_interest")),
            mark_iv=_maybe_float(row.get("mark_iv")),
            delta=_maybe_float(row.get("delta")),
        )
        snapshots[snapshot.instrument_name] = snapshot

    return snapshots


def _validate_currency(currency: str) -> None:
    if currency.upper() != "BTC":
        raise ValueError("Phase 4 greeks provider is BTC-only.")


def _maybe_float(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_retry_after(response: httpx.Response) -> float | None:
    """Parse Retry-After as delay-seconds. HTTP-date form is ignored."""
    raw = response.headers.get("Retry-After")
    if raw is None or str(raw).strip() == "":
        return None
    try:
        return max(float(raw), 0.0)
    except (TypeError, ValueError):
        return None


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default
