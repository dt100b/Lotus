import json
import os
from pathlib import Path
import subprocess
import signal
import sys
import threading
import time
from types import SimpleNamespace

from scripts import refresh_dashboard_live
from vol_surface import atm_refresh
import pytest


class Provider:
    def __init__(self):
        self.calls = 0
        self.failure = False
        self.closed = False
        self.third_call = threading.Event()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True

    def fetch_near_atm_greeks(self):
        self.calls += 1
        if self.calls >= 3:
            self.third_call.set()
        if self.failure:
            raise RuntimeError("network outage")
        return {}


def payload():
    now = int(time.time()*1000)
    return {"version": "atm_term_curve.v1", "as_of_ms": now, "valid_until_ms": now+300_000,
            "quote_count": 4, "term_structure": [
                {"tenor": tenor, "status": "ok", "atm_iv_percent": 40}
                for tenor in ("7d", "30d", "60d", "180d")
            ]}


def test_single_collector_lease_and_recovery_after_close(tmp_path):
    first = atm_refresh.CollectorLease(tmp_path)
    second = atm_refresh.CollectorLease(tmp_path)
    assert first.acquire()
    assert atm_refresh.is_atm_refresh_running(tmp_path)
    assert not second.acquire()
    first.close()
    assert not atm_refresh.is_atm_refresh_running(tmp_path)
    assert second.acquire()
    second.close()


def test_failure_retains_original_quote_expiry_and_recovers(tmp_path, monkeypatch):
    monkeypatch.setattr(atm_refresh, "build_atm_term_curve", lambda *a, **k: payload())
    worker = atm_refresh.AtmCurveRefresher(tmp_path)
    provider = Provider()
    worker.refresh_once(provider)
    original = (tmp_path / atm_refresh.LIVE_FILENAME).read_text()
    provider.failure = True
    worker.refresh_once(provider)
    assert (tmp_path / atm_refresh.LIVE_FILENAME).read_text() == original
    status = json.loads((tmp_path / atm_refresh.STATUS_FILENAME).read_text())
    assert status["state"] == "failed"
    assert status["consecutive_failures"] == 1
    assert status["error"] == "network outage"
    assert status["valid_until_ms"] == json.loads(original)["valid_until_ms"]
    provider.failure = False
    worker.refresh_once(provider)
    assert worker.status["state"] == "ok"
    assert worker.status["consecutive_failures"] == 0


def test_collector_crash_releases_cross_process_ownership(tmp_path):
    environment = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    code = """
import sys
import os
from pathlib import Path
from vol_surface.atm_refresh import CollectorLease
lease = CollectorLease(Path(sys.argv[1]))
assert lease.acquire()
print(os.getpid(), flush=True)
sys.stdin.read()
"""
    child = subprocess.Popen([sys.executable, "-c", code, str(tmp_path)], env=environment,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        collector_pid = int(child.stdout.readline().strip())
        assert atm_refresh.is_atm_refresh_running(tmp_path)
        # Windows venv launchers spawn the interpreter: kill the actual owner.
        os.kill(collector_pid, signal.SIGTERM)
        child.wait(timeout=5)
        assert not atm_refresh.is_atm_refresh_running(tmp_path)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        child.stdin.close()
        child.stdout.close()
        child.stderr.close()


def test_invalid_quote_cycle_does_not_erase_good_curve(tmp_path, monkeypatch):
    good = payload()
    monkeypatch.setattr(atm_refresh, "build_atm_term_curve", lambda *a, **k: good)
    worker = atm_refresh.AtmCurveRefresher(tmp_path)
    worker.refresh_once(Provider())
    published = json.loads((tmp_path / atm_refresh.LIVE_FILENAME).read_text())
    invalid = {**good, "term_structure": [{"tenor": "7d", "status": "unavailable"}]}
    monkeypatch.setattr(atm_refresh, "build_atm_term_curve", lambda *a, **k: invalid)
    worker.refresh_once(Provider())
    assert json.loads((tmp_path / atm_refresh.LIVE_FILENAME).read_text()) == published
    assert worker.status["state"] == "failed"


def test_slow_inventory_loop_cannot_block_atm_collection(tmp_path, monkeypatch):
    monkeypatch.setattr(refresh_dashboard_live, "SkewRefresher", lambda *a: SimpleNamespace(start=lambda: True, stop=lambda: None))
    monkeypatch.setattr(atm_refresh, "build_atm_term_curve", lambda *a, **k: payload())
    provider = Provider()
    worker = atm_refresh.AtmCurveRefresher(tmp_path, interval_seconds=.03, provider_factory=lambda: provider)
    monkeypatch.setattr(refresh_dashboard_live, "AtmCurveRefresher", lambda *a: worker)
    monkeypatch.setattr(refresh_dashboard_live, "parse_args", lambda: SimpleNamespace(
        once=False, greeks_json=None, artifacts_dir=tmp_path))
    inventory_started = threading.Event()
    release_inventory = threading.Event()
    def slow_loop(_):
        inventory_started.set()
        assert release_inventory.wait(2)
    monkeypatch.setattr(refresh_dashboard_live, "run_loop", slow_loop)
    main_thread = threading.Thread(target=refresh_dashboard_live.main)
    main_thread.start()
    try:
        assert inventory_started.wait(1)
        assert provider.third_call.wait(1)
        assert main_thread.is_alive()  # GEX has not returned, ATM already refreshed three times.
        assert not atm_refresh.AtmCurveRefresher(tmp_path).start()
        assert atm_refresh.read_json(tmp_path / atm_refresh.LIVE_FILENAME)["version"] == "atm_term_curve.v1"
    finally:
        release_inventory.set()
        main_thread.join(2)
    assert not main_thread.is_alive()
    assert provider.closed
    assert not atm_refresh.is_atm_refresh_running(tmp_path)


def test_frozen_and_once_runs_do_not_start_background_collector(monkeypatch):
    for once, frozen in ((True, None), (False, "frozen.json")):
        monkeypatch.setattr(refresh_dashboard_live, "parse_args", lambda: SimpleNamespace(
            once=once, greeks_json=frozen))
        monkeypatch.setattr(refresh_dashboard_live, "AtmCurveRefresher", lambda *a: (_ for _ in ()).throw(AssertionError("collector started")))
        monkeypatch.setattr(refresh_dashboard_live, "SkewRefresher", lambda *a: (_ for _ in ()).throw(AssertionError("skew collector started")))
        monkeypatch.setattr(refresh_dashboard_live, "run_loop", lambda _: None)
        refresh_dashboard_live.main()


def test_utc_boundaries_and_capture_metadata(tmp_path, monkeypatch):
    assert atm_refresh.next_boundary_ms(601_000,600) == 1_200_000
    assert atm_refresh.next_boundary_ms(1_200_000,600) == 1_800_000
    monkeypatch.setattr(atm_refresh,"build_atm_term_curve",lambda *a,**k:payload())
    worker = atm_refresh.AtmCurveRefresher(tmp_path)
    worker.refresh_once(Provider())
    live = atm_refresh.read_json(tmp_path/atm_refresh.LIVE_FILENAME)
    assert live['capture_validated'] is True
    assert live['next_capture_ms'] % 600_000 == 0
    assert live['capture_due_ms'] == live['next_capture_ms']+60_000
    archives = list((tmp_path/'atm_term_history'/'captures').glob('*.json'))
    assert len(archives) == 1
    assert atm_refresh.read_json(archives[0]) == live


@pytest.mark.parametrize('interval',[0,-1,float('nan'),float('inf')])
def test_invalid_collection_interval_rejected(tmp_path,interval):
    with pytest.raises(ValueError):
        atm_refresh.AtmCurveRefresher(tmp_path,interval_seconds=interval)


def test_fetch_crossing_boundary_schedules_after_completed_capture(tmp_path,monkeypatch):
    p = {**payload(),'as_of_ms':600_050,'valid_until_ms':900_050}
    monkeypatch.setattr(atm_refresh.time,'time',lambda:599.9)
    monkeypatch.setattr(atm_refresh,'build_atm_term_curve',lambda *a,**k:p)
    worker = atm_refresh.AtmCurveRefresher(tmp_path)
    worker.refresh_once(Provider())
    live = atm_refresh.read_json(tmp_path/atm_refresh.LIVE_FILENAME)
    assert live['next_capture_ms'] == 1_200_000
