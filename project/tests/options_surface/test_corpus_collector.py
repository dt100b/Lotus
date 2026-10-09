"""Collection isolation, dry-run, and lock behavior."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from project.options_surface.corpus.collector import CaptureProviders, run_collection
from project.options_surface.corpus.lock import InstanceLock
from project.options_surface.corpus.store import CorpusSnapshotStore
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    flat_vol_chain,
    listed_future,
)


@dataclass
class _Chain:
    as_of: datetime
    spot: float
    rows: list[dict[str, Any]]
    source: str = "test"
    verified_live_quotes: bool = False
    feed: dict[str, Any] | None = None


def test_one_expiry_failure_does_not_stop_batch(tmp_path: Path) -> None:
    def fetch_chain(expiry: str | None):
        if expiry == "2030-08-17":
            raise RuntimeError("synthetic chain failure")
        return _Chain(as_of=AS_OF, spot=INDEX, rows=flat_vol_chain(forward=FORWARD))

    providers = CaptureProviders(
        fetch_chain=fetch_chain,
        fetch_futures=lambda: (listed_future(mid=FORWARD),),
        clock=lambda: AS_OF,
    )
    store = CorpusSnapshotStore(tmp_path)
    summary = run_collection(
        store=store,
        providers=providers,
        expiries=[EXPIRY, "2030-08-17", EXPIRY],
        curated=False,
        pause_seconds=0.0,
        max_retries=0,
    )
    assert EXPIRY in summary["captured"]
    failed_expiries = [item["expiry"] for item in summary["failed"]]
    assert "2030-08-17" in failed_expiries
    assert len(summary["captured"]) == 2


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    providers = CaptureProviders(
        fetch_chain=lambda expiry: _Chain(as_of=AS_OF, spot=INDEX, rows=flat_vol_chain()),
        fetch_futures=lambda: (listed_future(mid=FORWARD),),
        clock=lambda: AS_OF,
    )
    store = CorpusSnapshotStore(tmp_path)
    summary = run_collection(
        store=store,
        providers=providers,
        expiries=[EXPIRY],
        dry_run=True,
    )
    assert summary["requested"] == [EXPIRY]
    assert summary["captured"] == []
    assert list(store.jsonl_paths()) == []


def test_instance_lock_is_exclusive(tmp_path: Path) -> None:
    path = tmp_path / "collector.lock"
    first = InstanceLock(path)
    second = InstanceLock(path)
    assert first.acquire() is True
    assert second.acquire() is False
    first.release()
    assert second.acquire() is True
    second.release()
