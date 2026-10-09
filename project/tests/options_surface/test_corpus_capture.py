"""Snapshot capture, atomic persistence, schema handling, and replay."""

from __future__ import annotations

from pathlib import Path

from project.options_surface.config import default_serving_config
from project.options_surface.corpus.capture import capture_from_market
from project.options_surface.corpus.replay import replay_capture, replay_matches
from project.options_surface.corpus.schema import CAPTURE_SCHEMA_VERSION, LEGACY_RESULT_SCHEMA
from project.options_surface.corpus.store import CorpusSnapshotStore, classify_schema, iter_jsonl_file
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    flat_vol_chain,
    listed_future,
)


def _capture(tmp_path: Path):
    record = capture_from_market(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
        serving_config=default_serving_config(),
        source={"api": "test"},
    )
    store = CorpusSnapshotStore(tmp_path)
    store.persist(record)
    return store, record


def test_capture_round_trip(tmp_path: Path) -> None:
    store, record = _capture(tmp_path)
    assert record["schema_version"] == CAPTURE_SCHEMA_VERSION
    assert record["capture_ok"] is True
    assert record["serving_mode"] == "diagnostic_candidate"
    assert record["candidates"]["constrained_svi"]["attempted"] is True
    assert record["candidates"]["tv_pchip"]["selected"] is False
    assert record["candidates"]["svi_raw"]["selected"] is False
    loaded = store.load(record["snapshot_id"])
    rebuilt = replay_capture(loaded)
    match = replay_matches(loaded, rebuilt)
    assert match["ok"], match["mismatches"]
    assert rebuilt.fitter_name == loaded["serving"]["selected_candidate"]
    assert rebuilt.display.density_status.value == loaded["serving"]["density_status"]


def test_partial_jsonl_line_is_skipped(tmp_path: Path) -> None:
    store, record = _capture(tmp_path)
    jsonl = next(iter(store.jsonl_paths()))
    with jsonl.open("a", encoding="utf-8") as handle:
        handle.write('{"schema_version":"options_surface_capture.v1","snapshot_id":"partial"')
    parsed = list(iter_jsonl_file(jsonl))
    corrupt = [item for item in parsed if item.get("_corrupt")]
    valid = [item for item in parsed if not item.get("_corrupt") and item.get("snapshot_id") == record["snapshot_id"]]
    assert corrupt
    assert len(valid) == 1
    loaded = store.load(record["snapshot_id"])
    assert loaded["snapshot_id"] == record["snapshot_id"]


def test_datetime_fields_serialize(tmp_path: Path) -> None:
    from datetime import UTC, datetime

    store, record = _capture(tmp_path)
    record["market_inputs"]["feed"] = {"last_message_at": datetime(2026, 8, 17, 4, tzinfo=UTC)}
    record["snapshot_id"] = "datetime-safe"
    store.persist(record)
    loaded = store.load("datetime-safe")
    assert loaded["market_inputs"]["feed"]["last_message_at"].startswith("2026-08-17T04:00:00")


def test_legacy_schema_is_identified_not_mixed(tmp_path: Path) -> None:
    store = CorpusSnapshotStore(tmp_path)
    jsonl = tmp_path / "2026" / "08" / "captures-2026-08-16.jsonl"
    jsonl.parent.mkdir(parents=True)
    jsonl.write_text(
        '{"schema_version":"%s","snapshot_id":"legacy","as_of_utc":"2026-08-16T00:00:00+00:00"}\n'
        % LEGACY_RESULT_SCHEMA,
        encoding="utf-8",
    )
    records = list(store.iter_records(include_incompatible=False))
    skipped = [item for item in records if item.get("_skipped_incompatible")]
    assert skipped
    assert classify_schema(skipped[0]) == "incompatible_identified"
    used = [item for item in records if not item.get("_skipped_incompatible") and not item.get("_corrupt")]
    assert used == []
