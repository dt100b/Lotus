"""Analyzer counts, tenor segmentation, and rubric export."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from project.options_surface.corpus.analyze import analyze_corpus
from project.options_surface.corpus.capture import capture_from_market
from project.options_surface.corpus.schema import RUBRIC_METRIC_KEYS
from project.options_surface.corpus.store import CorpusSnapshotStore
from project.tests.options_surface.support import (
    FORWARD,
    INDEX,
    flat_vol_chain,
    listed_future,
)


def _persist_case(
    store: CorpusSnapshotStore,
    *,
    expiry: str,
    as_of: datetime,
    snapshot_id: str,
) -> None:
    record = capture_from_market(
        flat_vol_chain(forward=FORWARD, as_of=as_of, expiry=expiry),
        expiry=expiry,
        as_of_utc=as_of,
        index_usd=INDEX,
        futures=(listed_future(expiry=expiry, mid=FORWARD, name=f"BTC-{expiry[8:10]}AUG30"),),
        snapshot_id=snapshot_id,
        capture_utc=as_of,
    )
    store.persist(record)


def test_analyzer_fixture_corpus(tmp_path: Path) -> None:
    store = CorpusSnapshotStore(tmp_path)
    near = datetime(2030, 8, 15, 12, tzinfo=UTC)
    mid = datetime(2030, 7, 15, 12, tzinfo=UTC)
    far = datetime(2030, 5, 1, 12, tzinfo=UTC)
    _persist_case(store, expiry="2030-08-16", as_of=near, snapshot_id="snap-near")
    _persist_case(store, expiry="2030-08-29", as_of=mid, snapshot_id="snap-mid")
    _persist_case(store, expiry="2030-08-16", as_of=far, snapshot_id="snap-far")
    failed = capture_from_market(
        [],
        expiry="2030-08-16",
        as_of_utc=near,
        index_usd=INDEX,
        futures=(),
        snapshot_id="snap-fail-forward",
        capture_utc=near,
    )
    store.persist(failed)

    report = analyze_corpus(tmp_path)
    overall = report["overall"]
    assert overall["capture_attempts"] == 4
    assert overall["successful_captures"] == 4
    assert overall["unique_snapshot_count"] == 4
    assert overall["expiries_evaluated"] >= 2
    assert "0_2_dte" in report["by_tenor"]
    assert "15_30_dte" in report["by_tenor"]
    assert "31_90_dte" in report["by_tenor"]
    assert report["by_tenor"]["0_2_dte"]["successful_captures"] >= 1
    assert report["by_tenor"]["31_90_dte"]["successful_captures"] >= 1
    assert set(report["rubric_metrics"]) == set(RUBRIC_METRIC_KEYS)
    assert overall["serving_gate_failures"]
    reasons_total = sum(overall["serving_gate_failures"].values())
    assert reasons_total >= 0


def test_analyzer_writes_artifacts(tmp_path: Path) -> None:
    store = CorpusSnapshotStore(tmp_path)
    as_of = datetime(2030, 8, 15, 12, tzinfo=UTC)
    _persist_case(store, expiry="2030-08-16", as_of=as_of, snapshot_id="snap-out")
    out = tmp_path / "reports"
    analyze_corpus(tmp_path, output_dir=out)
    assert (out / "corpus_report.json").exists()
    assert (out / "corpus_report.md").exists()
    assert (out / "corpus_summary.csv").exists()
    assert (out / "rubric_metrics.json").exists()
    assert (out / "run_manifest.json").exists()
    text = (out / "corpus_report.md").read_text(encoding="utf-8").lower()
    assert "not a backtest" in text
    assert "not alpha" in text
    assert "forecast" not in text
    assert "bullish" not in text
