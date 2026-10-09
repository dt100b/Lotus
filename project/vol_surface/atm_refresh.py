"""Independent ATM quote refresh: inventory/trade work cannot delay its cadence."""
from __future__ import annotations

import json
import logging
import math
import os
from pathlib import Path
import tempfile
import threading
import time

from greeks.providers import DeribitPublicGreeksProvider
from vol_surface.atm_term import build_atm_term_curve

logger = logging.getLogger(__name__)
LIVE_FILENAME = "atm_term_curve_live.json"
STATUS_FILENAME = "atm_term_refresh_status.json"
LOCK_FILENAME = "atm_term_refresh.lock"
DISPLAY_TENORS = {"7d", "30d", "60d", "180d"}
DEFAULT_INTERVAL_SECONDS = 600


def next_boundary_ms(now_ms: int, interval_seconds: float) -> int:
    interval_ms = max(1, int(interval_seconds*1000))
    return (now_ms//interval_ms+1)*interval_ms


def write_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique temporary names also make concurrent diagnostic writers safe.
    fd, temporary = tempfile.mkstemp(prefix=path.name+".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        for attempt in range(5):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(.01)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_json(path: Path) -> dict:
    # Windows can briefly deny opening a destination during replacement.
    for attempt in range(5):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(.01)
    raise OSError(f"Unable to read {path}")


class CollectorLease:
    """OS-owned lock, released on process exit; no stale PID-file takeover."""
    def __init__(self, root: Path, filename: str = LOCK_FILENAME):
        self.path = root / filename
        self.handle = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                if self.path.stat().st_size == 0:
                    handle.write(b"0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self.handle = handle
        return True

    def close(self) -> None:
        if self.handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()
            self.handle = None


def is_atm_refresh_running(root: Path) -> bool:
    lease = CollectorLease(root)
    acquired = lease.acquire()
    if acquired:
        lease.close()
    return not acquired


class AtmCurveRefresher:
    def __init__(self, root: str | Path, *, interval_seconds: float = DEFAULT_INTERVAL_SECONDS,
                 provider_factory=None):
        self.root = Path(root)
        if not math.isfinite(interval_seconds) or interval_seconds <= 0:
            raise ValueError("ATM interval must be positive and finite")
        self.interval_seconds = max(float(interval_seconds), .01)
        # A separate zero-TTL cache avoids both old inventory quotes and cache
        # contention. Only the small near-ATM candidate set is requested.
        self.provider_factory = provider_factory or (lambda: DeribitPublicGreeksProvider(
            use_process_cache=False, cache_ttl_seconds=0,
        ))
        self.lease = CollectorLease(self.root)
        self.stop_event = threading.Event()
        self.thread = None
        self.status = {"pid": os.getpid(), "interval_seconds": self.interval_seconds,
                       "last_success_ms": None, "consecutive_failures": 0}

    def start(self) -> bool:
        if self.thread is not None:
            return True
        if not self.lease.acquire():
            return False
        self.thread = threading.Thread(target=self._run, name="atm-quote-refresh", daemon=True)
        try:
            self.thread.start()
        except BaseException:
            self.lease.close()
            self.thread = None
            raise
        return True

    def stop(self, timeout: float = 15) -> None:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout)
        # The thread releases ownership only after any in-flight fetch finishes.

    def refresh_once(self, provider) -> None:
        started = time.monotonic()
        self.status.update(state="fetching", last_attempt_ms=int(time.time()*1000))
        write_atomic(self.root / STATUS_FILENAME, self.status)
        try:
            quotes = provider.fetch_near_atm_greeks()
            payload = build_atm_term_curve(quotes, as_of_ms=int(time.time()*1000))
            supported = sum(row["tenor"] in DISPLAY_TENORS and row["status"] == "ok"
                            for row in payload["term_structure"])
            # A transient total fetch failure must not erase still-valid data.
            # Retain original quote expiry; never extend the last curve lifetime.
            if supported < 2 or payload["valid_until_ms"] <= payload["as_of_ms"]:
                if not (self.root / LIVE_FILENAME).exists():
                    write_atomic(self.root / LIVE_FILENAME, payload)
                raise ValueError("Fewer than two supported ATM tenors; retained last curve with original expiry")
            # A startup fetch can cross a UTC boundary. Its next update is the
            # next boundary after capture, not one already passed mid-request.
            scheduled = next_boundary_ms(payload["as_of_ms"], self.interval_seconds)
            payload = {**payload, "capture_validated": True,
                       "capture_interval_ms": int(self.interval_seconds*1000),
                       "next_capture_ms": scheduled,
                       "capture_due_ms": scheduled+60_000}
            from vol_surface.atm_history import retain_snapshot
            # Archive before publishing: a successful display must be replayable.
            retain_snapshot(self.root, payload)
            write_atomic(self.root / LIVE_FILENAME, payload)
            self.status.update(state="ok", last_success_ms=payload["as_of_ms"],
                               valid_until_ms=payload["valid_until_ms"], supported_tenors=supported,
                               next_capture_ms=scheduled, capture_due_ms=payload["capture_due_ms"],
                               quote_count=payload["quote_count"], consecutive_failures=0, error=None)
        except Exception as exc:
            self.status.update(state="failed", error=str(exc),
                               consecutive_failures=self.status["consecutive_failures"]+1)
            logger.warning("Independent ATM refresh failed: %s", exc)
        finally:
            self.status.update(finished_ms=int(time.time()*1000),
                               duration_seconds=round(time.monotonic()-started, 3))
            write_atomic(self.root / STATUS_FILENAME, self.status)
            logger.info("ATM refresh: %s", json.dumps(self.status))

    def _run(self) -> None:
        try:
            with self.provider_factory() as provider:
                while not self.stop_event.is_set():
                    try:
                        self.refresh_once(provider)
                    except Exception:
                        # Includes filesystem failures in status writes.
                        logger.exception("ATM refresh cycle failed")
                    now_ms = int(time.time()*1000)
                    self.stop_event.wait(max(.01, (next_boundary_ms(now_ms,self.interval_seconds)-now_ms)/1000))
        finally:
            self.lease.close()
