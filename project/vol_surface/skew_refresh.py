"""Independent scheduled skew captures and a version-isolated hourly archive."""
from functools import lru_cache
import logging
import math
import os
from pathlib import Path
import threading
import time

from greeks.providers import DeribitPublicGreeksProvider
from vol_surface.atm_refresh import CollectorLease, write_atomic, read_json, next_boundary_ms
from vol_surface.skew import VERSION, build_skew_snapshot

LIVE_FILENAME = "local_skew_live.json"
STATUS_FILENAME = "local_skew_refresh_status.json"
HISTORY_DIR = "local_skew_history_v1"
INTERVAL_SECONDS = 600
FIELDS = {"skew_25": "skew_25_normalized", "skew_10": "skew_10_normalized", "tail_gap": "tail_gap_vol_points"}
logger = logging.getLogger(__name__)


class SkewRefresher:
    def __init__(self, root, *, interval_seconds=INTERVAL_SECONDS, provider_factory=None):
        if not math.isfinite(interval_seconds) or interval_seconds <= 0:
            raise ValueError("Skew interval must be positive and finite")
        self.root, self.interval_seconds = Path(root), interval_seconds
        self.provider_factory = provider_factory or (lambda: DeribitPublicGreeksProvider(
            use_process_cache=False, cache_ttl_seconds=0, max_concurrency=3, inter_batch_delay_seconds=.12))
        self.lease = CollectorLease(self.root, "local_skew_refresh.lock")
        self.stop_event, self.thread = threading.Event(), None
        self.status = {"pid": os.getpid(), "interval_seconds": interval_seconds, "consecutive_failures": 0}

    def start(self):
        if self.thread is not None:
            return True
        if not self.lease.acquire():
            return False
        self.thread = threading.Thread(target=self._run, name="skew-quote-refresh", daemon=True)
        try:
            self.thread.start()
        except BaseException:
            self.lease.close()
            self.thread = None
            raise
        return True

    def stop(self, timeout=45):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout)

    def refresh_once(self, provider):
        started = time.monotonic()
        self.status.update(state="fetching", last_attempt_ms=int(time.time()*1000))
        write_atomic(self.root / STATUS_FILENAME, self.status)
        try:
            quotes = provider.fetch_skew_greeks()
            payload = build_skew_snapshot(quotes, as_of_ms=int(time.time()*1000))
            supported = sum(r["status"] == "ok" for r in payload["term_structure"])
            stamp = payload["as_of_ms"]
            next_capture = next_boundary_ms(stamp, self.interval_seconds)
            payload.update(capture_validated=payload["valid_until_ms"] > stamp,
                           next_capture_ms=next_capture, capture_due_ms=next_capture+60_000)
            # Persist missing tenors explicitly too. A newly failed tenor must not
            # acquire an old value, and failed captures cannot erase history.
            path = self.root / HISTORY_DIR / f"{stamp:013d}.json"
            if not path.exists():
                write_atomic(path, payload)
            write_atomic(self.root / LIVE_FILENAME, payload)
            self.status.update(state="ok" if supported else "unavailable", as_of_ms=stamp,
                               supported_tenors=supported, quote_count=len(quotes), error=None,
                               next_capture_ms=next_capture, capture_due_ms=next_capture+60_000,
                               consecutive_failures=0)
        except Exception as exc:
            # Transport failure retains the previous observation with its actual
            # timestamp; readers also receive this failed-attempt status.
            self.status.update(state="failed", error=str(exc), consecutive_failures=self.status["consecutive_failures"]+1)
            logger.warning("Skew refresh failed: %s", exc)
        finally:
            self.status.update(finished_ms=int(time.time()*1000), duration_seconds=round(time.monotonic()-started, 3))
            write_atomic(self.root / STATUS_FILENAME, self.status)

    def _run(self):
        try:
            with self.provider_factory() as provider:
                while not self.stop_event.is_set():
                    try:
                        self.refresh_once(provider)
                    except Exception:
                        logger.exception("Skew refresh cycle failed")
                    now = int(time.time()*1000)
                    self.stop_event.wait(max(.01, (next_boundary_ms(now, self.interval_seconds)-now)/1000))
        finally:
            self.lease.close()


@lru_cache(maxsize=20_000)
def _observation(path, modified):
    row = read_json(path)
    if row.get("version") != VERSION or row.get("capture_validated") is not True:
        return None
    stamp = row["as_of_ms"]
    if not isinstance(stamp, (int, float)) or not math.isfinite(stamp) or row.get("valid_until_ms", 0) <= stamp:
        return None
    return stamp, tuple((r["tenor"], metric, r[field]) for r in row["term_structure"]
        for metric, field in FIELDS.items() if not r.get("metric_reasons", {}).get(metric)
        and isinstance(r.get(field), (int, float)) and math.isfinite(r[field]))


@lru_cache(maxsize=8)
def _capture_paths(directory, modified):
    return tuple(sorted((int(p.stem),p) for p in directory.glob("*.json") if p.stem.isdigit()))


def load_skew(root, *, now_ms):
    root = Path(root)
    try:
        payload = read_json(root / LIVE_FILENAME)
        if payload.get("version") != VERSION:
            payload = {}
    except (OSError, ValueError, AttributeError):
        payload = {}
    history = {metric: {} for metric in FIELDS}
    hours = {}
    directory = root / HISTORY_DIR
    for stamp,path in _capture_paths(directory,directory.stat().st_mtime_ns if directory.exists() else 0):
        if now_ms-365*86_400_000 <= stamp <= now_ms:
            if stamp > hours.get(stamp//3_600_000, (0, None))[0]:
                hours[stamp//3_600_000] = stamp, path
    for _, path in sorted(hours.values()):
        try:
            observation = _observation(path, path.stat().st_mtime_ns)
            if observation is not None:
                stamp, values = observation
                if stamp > now_ms or stamp < now_ms-365*86_400_000:
                    continue
                for tenor, metric, value in values:
                    series = history[metric].setdefault(tenor, [])
                    gap = bool(series and stamp//3_600_000-series[-1]["ts_ms"]//3_600_000 > 1)
                    series.append({"ts_ms": stamp, "value": value, **({"gap_before": True} if gap else {})})
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            continue
    try:
        status = read_json(root / STATUS_FILENAME)
        if not isinstance(status,dict):
            status = {}
    except (OSError, ValueError):
        status = {}
    # Raw inputs stay on disk for replay, not in every dashboard response.
    return {**{k:v for k,v in payload.items() if k != "source_quotes"},
            "version": VERSION, "history": history, "refresh_status": status}
