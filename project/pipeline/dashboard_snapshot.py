from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from statistics import median
from typing import Any, Iterable, Literal
import json
import sqlite3
import time

from greeks.gex_engine import compute_gex_profile, write_profile_artifacts
from greeks.providers import (
    DeribitPublicGreeksProvider,
    GreeksFetchStats,
    load_greeks_snapshot_json,
    write_greeks_snapshot_json,
)
from greeks.types import DealerInventoryRow, GEXProfile, GreekSnapshot
from ledger.models import NormalizedTradeEvent as LedgerNormalizedTradeEvent
from ledger.models import to_decimal
from ledger.replay import LedgerReplayer
from ledger.rules import (
    INCLUDE_OTC_LEDGER_METHODOLOGY_VERSION,
    include_otc_ledger_policy,
    production_ledger_policy,
)
from normalizer.instruments import InstrumentRegistry
from normalizer.service import normalize_trade_batch
from pipeline.flow_regime import (
    append_history_sample,
    build_flow_regime_payload,
    empty_flow_regime_payload,
    ny_session_anchor_ms,
    strike_gex_map_from_profile_rows,
)
from pipeline.skew_25d import build_and_persist_skew_25d, empty_skew_25d_payload
from pipeline.inventory_checkpoint import (
    InventoryCheckpoint,
    build_checkpoint,
    checkpoint_is_compatible,
    checkpoint_path,
    evaluate_checkpoint_lag,
    filter_events_after_cursors,
    include_otc_checkpoint_path,
    include_otc_inventory_csv_path,
    load_checkpoint,
    measure_checkpoint_inventory_lag,
    merge_instrument_cursors,
    positions_from_inventory_rows,
    rewrite_checkpoint_from_inventory,
)
from scripts.export_inventory_snapshot import (
    enrich_snapshot_positions,
    select_snapshot,
    write_inventory_csv,
)

MaterializeMode = Literal["auto", "full", "incremental"]

# Intermediate artifacts that become multi-GB on deep history; safe to prune in
# lightweight/live mode because they are not required to serve the Phase 5 API.
_HEAVY_ARTIFACT_NAMES = (
    "normalized_trades_phase2.jsonl",
    "normalized_events_phase3.jsonl",
    "position_deltas.jsonl",
)


@dataclass(frozen=True)
class MaterializationResult:
    raw_instrument_count: int
    raw_trade_count: int
    phase2_instrument_count: int
    phase2_trade_count: int
    phase3_event_count: int
    ledger_snapshot_count: int
    inventory_row_count: int
    gex_instrument_count: int
    gex_strike_count: int
    snapshot_row_count: int
    artifacts_dir: Path
    greeks_dir: Path
    phase5_snapshot_path: Path
    latest_snapshot_id: str
    materialize_mode: str = "full"
    incremental_new_trades: int = 0
    checkpoint_path: str | None = None
    checkpoint_lag_count: int | None = None
    checkpoint_positions_sha256: str | None = None
    stage_timings_seconds: dict[str, float] | None = None
    greeks_fetched_count: int = 0
    greeks_cache_hits: int = 0
    greeks_wall_seconds: float = 0.0
    greeks_429_count: int = 0
    greeks_skipped_after_retries: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "raw_instrument_count": self.raw_instrument_count,
            "raw_trade_count": self.raw_trade_count,
            "phase2_instrument_count": self.phase2_instrument_count,
            "phase2_trade_count": self.phase2_trade_count,
            "phase3_event_count": self.phase3_event_count,
            "ledger_snapshot_count": self.ledger_snapshot_count,
            "inventory_row_count": self.inventory_row_count,
            "gex_instrument_count": self.gex_instrument_count,
            "gex_strike_count": self.gex_strike_count,
            "snapshot_row_count": self.snapshot_row_count,
            "artifacts_dir": str(self.artifacts_dir),
            "greeks_dir": str(self.greeks_dir),
            "phase5_snapshot_path": str(self.phase5_snapshot_path),
            "latest_snapshot_id": self.latest_snapshot_id,
            "materialize_mode": self.materialize_mode,
            "incremental_new_trades": self.incremental_new_trades,
            "checkpoint_path": self.checkpoint_path,
            "checkpoint_lag_count": self.checkpoint_lag_count,
            "checkpoint_positions_sha256": self.checkpoint_positions_sha256,
            "stage_timings_seconds": self.stage_timings_seconds,
            "greeks_fetched_count": self.greeks_fetched_count,
            "greeks_cache_hits": self.greeks_cache_hits,
            "greeks_wall_seconds": self.greeks_wall_seconds,
            "greeks_429_count": self.greeks_429_count,
            "greeks_skipped_after_retries": self.greeks_skipped_after_retries,
        }


def count_raw_phase1_rows(db_path: str | Path) -> tuple[int, int, int | None, int | None]:
    """Return (instrument_count, trade_count, min_trade_ts_ms, max_trade_ts_ms)."""
    database_path = Path(db_path)
    if not database_path.exists():
        raise FileNotFoundError(f"Phase 1 SQLite database not found: {database_path}")

    with sqlite3.connect(database_path) as conn:
        instrument_count = int(
            conn.execute("SELECT COUNT(*) FROM raw_instruments").fetchone()[0]
        )
        trade_count = int(conn.execute("SELECT COUNT(*) FROM raw_trades").fetchone()[0])
        min_ts, max_ts = conn.execute(
            "SELECT MIN(timestamp_ms), MAX(timestamp_ms) FROM raw_trades"
        ).fetchone()
    return instrument_count, trade_count, min_ts, max_ts


def load_raw_phase1_records(
    db_path: str | Path,
    *,
    trades_after_timestamp_ms: int | None = None,
    include_trades: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    database_path = Path(db_path)
    if not database_path.exists():
        raise FileNotFoundError(f"Phase 1 SQLite database not found: {database_path}")

    with sqlite3.connect(database_path) as conn:
        instrument_rows = _load_payload_rows(
            conn,
            """
            SELECT payload_json
            FROM raw_instruments
            ORDER BY instrument_name
            """,
        )
        if not include_trades:
            return instrument_rows, []

        if trades_after_timestamp_ms is None:
            trade_query = """
            SELECT payload_json
            FROM raw_trades
            ORDER BY timestamp_ms, trade_seq, instrument_name, trade_id
            """
            trade_params: tuple[Any, ...] = ()
        else:
            # Inclusive lower bound: per-instrument trade_seq cursors drop already
            # applied rows so equal-timestamp races on the watermark are safe.
            trade_query = """
            SELECT payload_json
            FROM raw_trades
            WHERE timestamp_ms >= ?
            ORDER BY timestamp_ms, trade_seq, instrument_name, trade_id
            """
            trade_params = (int(trades_after_timestamp_ms),)

        trade_rows = _load_payload_rows(conn, trade_query, trade_params)

    return instrument_rows, trade_rows


def materialize_dashboard_snapshot(
    *,
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
    greeks_json: str | Path | None = None,
    snapshot_id: str | None = None,
    normalization_version: str = "phase2.v1",
    ledger_methodology_version: str = "phase3.ledger.v1",
    gex_methodology_version: str = "phase4.gex.v1",
    fail_on_empty: bool = True,
    strict_instrument_lookup: bool = True,
    lightweight: bool = False,
    mode: MaterializeMode = "auto",
    write_inventory_checkpoint: bool = True,
    # Archived secondary path — off by default. See docs/archived_include_otc_prints.md.
    enable_include_otc_secondary: bool = False,
) -> MaterializationResult:
    """Materialize Phase 2→5 artifacts from a Phase 1 SQLite DB.

    ``lightweight=True`` (Phase 6 live path):
    - skip multi-GB intermediate JSONL writes
    - retain only genesis/checkpoint + final ledger snapshots (same final inventory)
    - fetch live Greeks only for non-expired, non-zero inventory rows
    - prune leftover heavy intermediate artifacts from prior full builds

    ``mode``:
    - ``full``: always normalize + replay the entire raw trade history
    - ``incremental``: require a compatible inventory checkpoint and only apply
      newly ingested trades (falls back is not automatic)
    - ``auto``: incremental when a compatible checkpoint exists, else full

    ``enable_include_otc_secondary`` (archived, default False):
    dual-replay with include-OTC ledger policy and write separate artifacts /
    ``rows_include_otc``. Production inventory and default GEX stay unchanged.
    """
    artifacts_root = Path(artifacts_dir)
    artifacts_root.mkdir(parents=True, exist_ok=True)
    greeks_dir = artifacts_root / "gex"
    greeks_dir.mkdir(parents=True, exist_ok=True)
    ckpt_file = checkpoint_path(artifacts_root)
    timings: dict[str, float] = {}

    def _mark(stage: str, started: float) -> float:
        timings[stage] = round(time.perf_counter() - started, 3)
        return time.perf_counter()

    t0 = time.perf_counter()
    instrument_count, trade_count, _min_ts, max_ts = count_raw_phase1_rows(db_path)
    t0 = _mark("count_raw", t0)

    if fail_on_empty and trade_count == 0:
        raise ValueError("raw_trades is empty; backfill data before building the dashboard snapshot.")

    checkpoint = load_checkpoint(ckpt_file) if mode != "full" else None
    use_incremental = False
    incremental_reason = "forced_full" if mode == "full" else "no_checkpoint"

    if checkpoint is not None:
        ok, reason = checkpoint_is_compatible(
            checkpoint,
            normalization_version=normalization_version,
            ledger_methodology_version=ledger_methodology_version,
            gex_methodology_version=gex_methodology_version,
            raw_trade_count=trade_count,
        )
        if ok and mode in {"auto", "incremental"}:
            use_incremental = True
            incremental_reason = "compatible_checkpoint"
        else:
            incremental_reason = reason
            if mode == "incremental":
                raise ValueError(
                    f"Incremental materialize requested but checkpoint is not usable: {reason}"
                )
            checkpoint = None
    elif mode in {"auto", "incremental"}:
        # Cold-start optimization: reuse the last final inventory book so the
        # first cycle after upgrade does not replay multi-million trade histories.
        bootstrapped = _try_bootstrap_checkpoint_from_snapshot(
            artifacts_root=artifacts_root,
            db_path=db_path,
            normalization_version=normalization_version,
            ledger_methodology_version=ledger_methodology_version,
            gex_methodology_version=gex_methodology_version,
            instrument_count=instrument_count,
            trade_count=trade_count,
        )
        if bootstrapped is not None:
            checkpoint = bootstrapped
            use_incremental = True
            incremental_reason = "bootstrapped_from_final_snapshot"
        elif mode == "incremental":
            raise ValueError(
                "Incremental materialize requested but no checkpoint or bootstrap snapshot exists."
            )

    if use_incremental and checkpoint is not None:
        result = _materialize_incremental(
            db_path=db_path,
            artifacts_root=artifacts_root,
            greeks_dir=greeks_dir,
            snapshot_path=snapshot_path,
            greeks_json=greeks_json,
            snapshot_id=snapshot_id,
            normalization_version=normalization_version,
            ledger_methodology_version=ledger_methodology_version,
            gex_methodology_version=gex_methodology_version,
            fail_on_empty=fail_on_empty,
            strict_instrument_lookup=strict_instrument_lookup,
            lightweight=lightweight,
            write_inventory_checkpoint=write_inventory_checkpoint,
            checkpoint=checkpoint,
            ckpt_file=ckpt_file,
            instrument_count=instrument_count,
            trade_count=trade_count,
            db_max_timestamp_ms=int(max_ts or 0),
            timings=timings,
            mark=_mark,
            enable_include_otc_secondary=enable_include_otc_secondary,
        )
        # Stash reason for operators (not part of frozen dataclass).
        payload = result.to_dict()
        payload["incremental_reason"] = incremental_reason
        return result

    return _materialize_full(
        db_path=db_path,
        artifacts_root=artifacts_root,
        greeks_dir=greeks_dir,
        snapshot_path=snapshot_path,
        greeks_json=greeks_json,
        snapshot_id=snapshot_id,
        normalization_version=normalization_version,
        ledger_methodology_version=ledger_methodology_version,
        gex_methodology_version=gex_methodology_version,
        fail_on_empty=fail_on_empty,
        strict_instrument_lookup=strict_instrument_lookup,
        lightweight=lightweight,
        write_inventory_checkpoint=write_inventory_checkpoint,
        ckpt_file=ckpt_file,
        instrument_count=instrument_count,
        trade_count=trade_count,
        timings=timings,
        mark=_mark,
        incremental_reason=incremental_reason,
        enable_include_otc_secondary=enable_include_otc_secondary,
    )


def _materialize_full(
    *,
    db_path: str | Path,
    artifacts_root: Path,
    greeks_dir: Path,
    snapshot_path: str | Path,
    greeks_json: str | Path | None,
    snapshot_id: str | None,
    normalization_version: str,
    ledger_methodology_version: str,
    gex_methodology_version: str,
    fail_on_empty: bool,
    strict_instrument_lookup: bool,
    lightweight: bool,
    write_inventory_checkpoint: bool,
    ckpt_file: Path,
    instrument_count: int,
    trade_count: int,
    timings: dict[str, float],
    mark,
    incremental_reason: str,
    enable_include_otc_secondary: bool = False,
) -> MaterializationResult:
    t = time.perf_counter()
    raw_instruments, raw_trades = load_raw_phase1_records(db_path)
    t = mark("load_raw", t)

    # Live paths may see trades whose instruments Deribit no longer lists
    # (long-expired). Non-strict mode marks them unresolved and excludes them
    # from v1 inventory/GEX instead of aborting the whole materialization.
    phase2 = normalize_trade_batch(
        raw_instruments,
        raw_trades,
        method_version=normalization_version,
        strict_instrument_lookup=strict_instrument_lookup,
    )
    del raw_instruments
    del raw_trades
    t = mark("normalize", t)

    if lightweight:
        _prune_heavy_artifacts(artifacts_root)
    else:
        _write_jsonl(artifacts_root / "normalized_trades_phase2.jsonl", phase2["trades"])
    _write_jsonl(artifacts_root / "canonical_instruments.jsonl", phase2["instruments"])

    phase3_events = build_phase3_events(
        phase2["trades"], normalization_version=normalization_version
    )
    phase2_trade_count = len(phase2["trades"])
    phase2_instrument_count = len(phase2["instruments"])
    instruments_by_name = _instruments_from_phase2_records(phase2["instruments"])
    del phase2["trades"]
    t = mark("phase3_adapt", t)

    if fail_on_empty and not phase3_events:
        raise ValueError("No Phase 3 eligible events were produced from normalized trades.")
    if not lightweight:
        _write_jsonl(artifacts_root / "normalized_events_phase3.jsonl", phase3_events)

    max_timestamp_ms = max((int(row["ts_ms"]) for row in phase3_events), default=0)
    instrument_cursors = merge_instrument_cursors({}, phase3_events)

    ledger_events = [LedgerNormalizedTradeEvent.from_dict(row) for row in phase3_events]
    phase3_event_count = len(phase3_events)
    del phase3_events
    t = mark("ledger_event_objects", t)

    # Production path: blocks + combos excluded (unchanged methodology).
    ledger_result = LedgerReplayer(
        production_ledger_policy(
            methodology_version=ledger_methodology_version,
            # In full mode, one mid-run snapshot is enough; live lightweight keeps
            # only genesis + final regardless of this cadence.
            snapshot_every=max(phase3_event_count, 1),
        )
    ).replay(
        ledger_events,
        retain_deltas=not lightweight,
        retain_intermediate_snapshots=not lightweight,
    )
    t = mark("ledger_replay", t)

    # Archived secondary include-OTC path (opt-in only). See archived_include_otc_prints.md.
    otc_ledger_result = None
    if enable_include_otc_secondary:
        otc_ledger_result = LedgerReplayer(
            include_otc_ledger_policy(
                snapshot_every=max(phase3_event_count, 1),
            )
        ).replay(
            ledger_events,
            retain_deltas=False,
            retain_intermediate_snapshots=False,
        )
        t = mark("ledger_replay_include_otc", t)
    del ledger_events

    return _finish_from_ledger(
        ledger_result=ledger_result,
        otc_ledger_result=otc_ledger_result,
        instruments_by_name=instruments_by_name,
        artifacts_root=artifacts_root,
        greeks_dir=greeks_dir,
        snapshot_path=snapshot_path,
        greeks_json=greeks_json,
        snapshot_id=snapshot_id,
        gex_methodology_version=gex_methodology_version,
        fail_on_empty=fail_on_empty,
        lightweight=lightweight,
        write_inventory_checkpoint=write_inventory_checkpoint,
        ckpt_file=ckpt_file,
        normalization_version=normalization_version,
        ledger_methodology_version=ledger_methodology_version,
        instrument_count=instrument_count,
        trade_count=trade_count,
        phase2_instrument_count=phase2_instrument_count,
        phase2_trade_count=phase2_trade_count,
        phase3_event_count=phase3_event_count,
        max_timestamp_ms=max_timestamp_ms,
        instrument_cursors=instrument_cursors,
        materialize_mode="full",
        incremental_new_trades=phase2_trade_count,
        timings=timings,
        mark=mark,
        incremental_reason=incremental_reason,
        db_path=db_path,
        strict_instrument_lookup=strict_instrument_lookup,
    )


def _materialize_incremental(
    *,
    db_path: str | Path,
    artifacts_root: Path,
    greeks_dir: Path,
    snapshot_path: str | Path,
    greeks_json: str | Path | None,
    snapshot_id: str | None,
    normalization_version: str,
    ledger_methodology_version: str,
    gex_methodology_version: str,
    fail_on_empty: bool,
    strict_instrument_lookup: bool,
    lightweight: bool,
    write_inventory_checkpoint: bool,
    checkpoint: InventoryCheckpoint,
    ckpt_file: Path,
    instrument_count: int,
    trade_count: int,
    db_max_timestamp_ms: int,
    timings: dict[str, float],
    mark,
    enable_include_otc_secondary: bool = False,
) -> MaterializationResult:
    """Apply only trades at/after the checkpoint watermark to the saved book."""
    t = time.perf_counter()
    if lightweight:
        _prune_heavy_artifacts(artifacts_root)

    # Always refresh instruments (listings change; enrichment needs full map).
    # Trades: only the watermark window, then cursor-filter already-applied seqs.
    raw_instruments, raw_trades = load_raw_phase1_records(
        db_path,
        trades_after_timestamp_ms=int(checkpoint.max_timestamp_ms),
    )
    t = mark("load_raw_incremental", t)

    phase2 = normalize_trade_batch(
        raw_instruments,
        raw_trades,
        method_version=normalization_version,
        strict_instrument_lookup=strict_instrument_lookup,
    )
    del raw_instruments
    del raw_trades
    t = mark("normalize_incremental", t)

    _write_jsonl(artifacts_root / "canonical_instruments.jsonl", phase2["instruments"])
    instruments_by_name = _instruments_from_phase2_records(phase2["instruments"])

    phase3_events = build_phase3_events(
        phase2["trades"], normalization_version=normalization_version
    )
    phase2_trade_count = len(phase2["trades"])
    phase2_instrument_count = len(phase2["instruments"])
    del phase2["trades"]

    # Drop events already covered by per-instrument trade_seq cursors.
    new_events = filter_events_after_cursors(
        phase3_events, checkpoint.instrument_cursors
    )
    del phase3_events
    t = mark("phase3_filter", t)

    ledger_events = [LedgerNormalizedTradeEvent.from_dict(row) for row in new_events]
    instrument_cursors = merge_instrument_cursors(
        checkpoint.instrument_cursors, ledger_events
    )
    max_timestamp_ms = max(
        int(checkpoint.max_timestamp_ms),
        max((int(event.ts_ms) for event in ledger_events), default=0),
        int(db_max_timestamp_ms or 0),
    )
    phase3_event_count = checkpoint.input_event_count + len(ledger_events)
    t = mark("ledger_event_objects", t)

    ledger_result = LedgerReplayer(
        production_ledger_policy(
            methodology_version=ledger_methodology_version,
            snapshot_every=max(len(ledger_events), 1),
        )
    ).replay(
        ledger_events,
        retain_deltas=not lightweight,
        retain_intermediate_snapshots=not lightweight,
        initial_positions=dict(checkpoint.positions),
        prior_input_event_count=checkpoint.input_event_count,
        prior_applied_event_count=checkpoint.applied_event_count,
        prior_excluded_event_count=checkpoint.excluded_event_count,
        prior_final_trade_seq=checkpoint.last_trade_seq,
        prior_final_ts_ms=checkpoint.final_ts_ms,
    )
    t = mark("ledger_replay_incremental", t)

    # Archived secondary include-OTC path (opt-in). Needs its own checkpoint when incremental.
    otc_ledger_result = None
    if enable_include_otc_secondary:
        otc_ckpt_file = include_otc_checkpoint_path(artifacts_root)
        otc_checkpoint = load_checkpoint(otc_ckpt_file)
        if otc_checkpoint is not None:
            otc_ok, _otc_reason = checkpoint_is_compatible(
                otc_checkpoint,
                normalization_version=normalization_version,
                ledger_methodology_version=INCLUDE_OTC_LEDGER_METHODOLOGY_VERSION,
                gex_methodology_version=gex_methodology_version,
                raw_trade_count=trade_count,
            )
            if otc_ok:
                otc_ledger_result = LedgerReplayer(
                    include_otc_ledger_policy(
                        snapshot_every=max(len(ledger_events), 1),
                    )
                ).replay(
                    ledger_events,
                    retain_deltas=False,
                    retain_intermediate_snapshots=False,
                    initial_positions=dict(otc_checkpoint.positions),
                    prior_input_event_count=otc_checkpoint.input_event_count,
                    prior_applied_event_count=otc_checkpoint.applied_event_count,
                    prior_excluded_event_count=otc_checkpoint.excluded_event_count,
                    prior_final_trade_seq=otc_checkpoint.last_trade_seq,
                    prior_final_ts_ms=otc_checkpoint.final_ts_ms,
                )
                t = mark("ledger_replay_include_otc_incremental", t)
    del ledger_events

    return _finish_from_ledger(
        ledger_result=ledger_result,
        otc_ledger_result=otc_ledger_result,
        instruments_by_name=instruments_by_name,
        artifacts_root=artifacts_root,
        greeks_dir=greeks_dir,
        snapshot_path=snapshot_path,
        greeks_json=greeks_json,
        snapshot_id=snapshot_id,
        gex_methodology_version=gex_methodology_version,
        fail_on_empty=fail_on_empty,
        lightweight=lightweight,
        write_inventory_checkpoint=write_inventory_checkpoint,
        ckpt_file=ckpt_file,
        normalization_version=normalization_version,
        ledger_methodology_version=ledger_methodology_version,
        instrument_count=instrument_count,
        trade_count=trade_count,
        phase2_instrument_count=phase2_instrument_count,
        phase2_trade_count=phase2_trade_count,
        phase3_event_count=phase3_event_count,
        max_timestamp_ms=max_timestamp_ms,
        instrument_cursors=instrument_cursors,
        materialize_mode="incremental",
        incremental_new_trades=len(new_events),
        timings=timings,
        mark=mark,
        incremental_reason="compatible_checkpoint",
        db_path=db_path,
        strict_instrument_lookup=strict_instrument_lookup,
    )


def _finish_from_ledger(
    *,
    ledger_result,
    instruments_by_name,
    artifacts_root: Path,
    greeks_dir: Path,
    snapshot_path: str | Path,
    greeks_json: str | Path | None,
    snapshot_id: str | None,
    gex_methodology_version: str,
    fail_on_empty: bool,
    lightweight: bool,
    write_inventory_checkpoint: bool,
    ckpt_file: Path,
    normalization_version: str,
    ledger_methodology_version: str,
    instrument_count: int,
    trade_count: int,
    phase2_instrument_count: int,
    phase2_trade_count: int,
    phase3_event_count: int,
    max_timestamp_ms: int,
    instrument_cursors: dict[str, int],
    materialize_mode: str,
    incremental_new_trades: int,
    timings: dict[str, float],
    mark,
    incremental_reason: str,
    otc_ledger_result=None,
    db_path: str | Path | None = None,
    strict_instrument_lookup: bool = True,
) -> MaterializationResult:
    t = time.perf_counter()
    snapshots = [record.to_dict() for record in ledger_result.snapshots]
    if not lightweight:
        position_deltas = [record.to_dict() for record in ledger_result.position_deltas]
        _write_jsonl(artifacts_root / "position_deltas.jsonl", position_deltas)
        del position_deltas
    _write_jsonl(artifacts_root / "dealer_inventory_snapshots.jsonl", snapshots)
    manifest = dict(ledger_result.manifest)
    manifest["materialize_mode"] = materialize_mode
    manifest["incremental_reason"] = incremental_reason
    manifest["incremental_new_trades"] = incremental_new_trades
    _write_json(artifacts_root / "ledger_manifest.json", manifest)

    selected_snapshot = select_snapshot(snapshots, snapshot_id=snapshot_id)
    inventory_rows = enrich_snapshot_positions(selected_snapshot, instruments_by_name)
    inventory_csv_path = artifacts_root / "inventory_snapshot.csv"
    write_inventory_csv(inventory_rows, inventory_csv_path)
    t = mark("inventory_enrich", t)

    # Rewrite checkpoint immediately after inventory so the serving book and
    # ops acceleration file cannot diverge if later greeks/GEX stages fail.
    # Positions map is taken from the inventory rows just written (exact match
    # to inventory_snapshot.csv after dust prune), not a parallel ledger map.
    written_checkpoint: str | None = None
    checkpoint_lag_count: int | None = None
    checkpoint_positions_sha256: str | None = None
    if write_inventory_checkpoint:
        inventory_positions = positions_from_inventory_rows(inventory_rows)
        ckpt = rewrite_checkpoint_from_inventory(
            checkpoint_file=ckpt_file,
            inventory_csv=inventory_csv_path,
            inventory_positions=inventory_positions,
            normalization_version=normalization_version,
            ledger_methodology_version=ledger_methodology_version,
            gex_methodology_version=gex_methodology_version,
            raw_trade_count=trade_count,
            raw_instrument_count=instrument_count,
            max_timestamp_ms=max_timestamp_ms,
            last_trade_seq=int(selected_snapshot.get("last_trade_seq", -1)),
            final_ts_ms=int(selected_snapshot.get("ts_ms", 0)),
            input_event_count=int(ledger_result.manifest.get("input_event_count", 0)),
            applied_event_count=int(
                ledger_result.manifest.get("applied_event_count", 0)
            ),
            excluded_event_count=int(
                ledger_result.manifest.get("excluded_event_count", 0)
            ),
            instrument_cursors=instrument_cursors,
        )
        # Verify against the on-disk inventory CSV (serving artifact), not only
        # the in-memory map used to build the checkpoint.
        lag = measure_checkpoint_inventory_lag(
            artifacts_root,
            checkpoint_file=ckpt_file,
            inventory_file=inventory_csv_path,
        )
        evaluate_checkpoint_lag(
            lag,
            context=f"post_materialize[{materialize_mode}]",
        )
        written_checkpoint = str(ckpt_file)
        checkpoint_lag_count = lag.delta_count
        checkpoint_positions_sha256 = ckpt.positions_sha256
        t = mark("write_checkpoint", t)

    # --- Secondary include-OTC inventory (separate files only) ---
    otc_inventory_rows = None
    if otc_ledger_result is not None:
        otc_snapshots = [record.to_dict() for record in otc_ledger_result.snapshots]
        otc_selected = select_snapshot(otc_snapshots, snapshot_id=None)
        otc_inventory_rows = enrich_snapshot_positions(otc_selected, instruments_by_name)
        otc_inv_csv = include_otc_inventory_csv_path(artifacts_root)
        write_inventory_csv(otc_inventory_rows, otc_inv_csv)
        if write_inventory_checkpoint:
            otc_positions = positions_from_inventory_rows(otc_inventory_rows)
            rewrite_checkpoint_from_inventory(
                checkpoint_file=include_otc_checkpoint_path(artifacts_root),
                inventory_csv=otc_inv_csv,
                inventory_positions=otc_positions,
                normalization_version=normalization_version,
                ledger_methodology_version=INCLUDE_OTC_LEDGER_METHODOLOGY_VERSION,
                gex_methodology_version=gex_methodology_version,
                raw_trade_count=trade_count,
                raw_instrument_count=instrument_count,
                max_timestamp_ms=max_timestamp_ms,
                last_trade_seq=int(otc_selected.get("last_trade_seq", -1)),
                final_ts_ms=int(otc_selected.get("ts_ms", 0)),
                input_event_count=int(
                    otc_ledger_result.manifest.get("input_event_count", 0)
                ),
                applied_event_count=int(
                    otc_ledger_result.manifest.get("applied_event_count", 0)
                ),
                excluded_event_count=int(
                    otc_ledger_result.manifest.get("excluded_event_count", 0)
                ),
                instrument_cursors=instrument_cursors,
            )
        t = mark("inventory_enrich_include_otc", t)

    now_ms = int(datetime.now(UTC).timestamp() * 1000)
    gex_inventory_rows = [
        DealerInventoryRow(
            instrument_name=row.instrument_name,
            option_type=row.option_type,
            strike=float(row.strike),
            expiry_ts=int(row.expiry_ts),
            net_contracts=float(row.net_contracts),
            contract_multiplier=float(row.contract_multiplier),
            include_in_gex=bool(row.include_in_gex),
        )
        for row in inventory_rows
        # Expired names cannot receive live ticker greeks; skip the round-trips.
        if (not lightweight) or int(row.expiry_ts) >= now_ms
    ]

    otc_gex_inventory_rows: list[DealerInventoryRow] = []
    if otc_inventory_rows is not None:
        otc_gex_inventory_rows = [
            DealerInventoryRow(
                instrument_name=row.instrument_name,
                option_type=row.option_type,
                strike=float(row.strike),
                expiry_ts=int(row.expiry_ts),
                net_contracts=float(row.net_contracts),
                contract_multiplier=float(row.contract_multiplier),
                include_in_gex=bool(row.include_in_gex),
            )
            for row in otc_inventory_rows
            if (not lightweight) or int(row.expiry_ts) >= now_ms
        ]

    # Fetch greeks for the union of production + include-OTC non-zero books.
    greeks_names = sorted(
        {
            row.instrument_name
            for row in gex_inventory_rows
            if row.include_in_gex and row.net_contracts != 0
        }
        | {
            row.instrument_name
            for row in otc_gex_inventory_rows
            if row.include_in_gex and row.net_contracts != 0
        }
    )
    greeks, greeks_stats = _load_or_fetch_greeks(
        greeks_dir=greeks_dir,
        greeks_json=greeks_json,
        instrument_names=greeks_names,
    )
    t = mark("greeks", t)
    # Explicit wall clock for the Greeks stage (same interval as stage "greeks").
    timings["greeks_wall_seconds"] = float(timings.get("greeks", greeks_stats.wall_seconds))
    timings["greeks_fetched_count"] = float(greeks_stats.fetched_count)
    timings["greeks_cache_hits"] = float(greeks_stats.cache_hits)
    timings["greeks_429_count"] = float(greeks_stats.rate_limit_count)
    timings["greeks_skipped_after_retries"] = float(greeks_stats.skipped_after_retries)

    profile = compute_gex_profile(
        inventory_rows=gex_inventory_rows,
        greeks_by_instrument=greeks,
        methodology_version=gex_methodology_version,
    )
    if not lightweight:
        write_profile_artifacts(profile, greeks_dir)
    else:
        # Still persist a greeks snapshot for debugging; skip bulky CSV profiles.
        write_greeks_snapshot_json(greeks, greeks_dir / "greeks_snapshot.json")

    otc_profile: GEXProfile | None = None
    if otc_gex_inventory_rows:
        otc_profile = compute_gex_profile(
            inventory_rows=otc_gex_inventory_rows,
            greeks_by_instrument=greeks,
            methodology_version=gex_methodology_version,
            as_of_ts=profile.as_of_ts,
        )
        if not lightweight:
            # Clearly separated artifact — does not overwrite gex_by_strike.csv.
            _write_gex_by_strike_csv(
                greeks_dir / "gex_by_strike_with_blocks.csv",
                otc_profile.by_strike,
            )
        t = mark("gex_include_otc", t)

    phase5_payload = build_phase5_snapshot_payload(profile)
    if otc_profile is not None:
        otc_payload = build_phase5_snapshot_payload(otc_profile)
        # Production `rows` stay the excluded (default) profile; secondary is additive.
        phase5_payload["rows_include_otc"] = otc_payload["rows"]
        phase5_payload["include_otc_prints_available"] = True
        phase5_payload["ledger_policy_default"] = "exclude_otc_prints"
        phase5_payload["ledger_policy_include_otc"] = "include_otc_prints"
    else:
        phase5_payload["include_otc_prints_available"] = False

    # Secondary Regime analytics (Velocity / Horizon / Active Strikes). Additive only —
    # does not alter inventory, GEX formula, or main Regime polarity inputs.
    try:
        phase5_payload["flow_regime"] = _build_and_persist_flow_regime(
            artifacts_root=artifacts_root,
            profile=profile,
            greeks=greeks,
            gex_methodology_version=gex_methodology_version,
            db_path=db_path,
            normalization_version=normalization_version,
            ledger_methodology_version=ledger_methodology_version,
            strict_instrument_lookup=strict_instrument_lookup,
            lightweight=lightweight,
        )
        t = mark("flow_regime", t)
    except Exception as exc:  # noqa: BLE001 — never block serving snapshot
        phase5_payload["flow_regime"] = empty_flow_regime_payload(
            as_of_ms=int(profile.as_of_ts),
            spot=float(phase5_payload.get("spot_price") or 0.0),
        )
        phase5_payload["flow_regime"]["error"] = str(exc)[:240]
        t = mark("flow_regime_error", t)

    if fail_on_empty and not phase5_payload["rows"]:
        raise ValueError(
            "Phase 5 snapshot rows are empty; no visible GEX strikes would be rendered."
        )

    phase5_target = Path(snapshot_path)
    phase5_target.parent.mkdir(parents=True, exist_ok=True)
    # Atomic temp+rename so a crash mid-write cannot leave a half JSON that
    # makes the API return 500 while inventory/checkpoint already advanced.
    _write_json_atomic(phase5_target, phase5_payload)
    t = mark("gex_phase5_write", t)

    return MaterializationResult(
        raw_instrument_count=phase2_instrument_count,
        raw_trade_count=trade_count,
        phase2_instrument_count=phase2_instrument_count,
        phase2_trade_count=phase2_trade_count,
        phase3_event_count=phase3_event_count,
        ledger_snapshot_count=len(snapshots),
        inventory_row_count=len(inventory_rows),
        gex_instrument_count=len(profile.instrument_rows),
        gex_strike_count=len(profile.by_strike),
        snapshot_row_count=len(phase5_payload["rows"]),
        artifacts_dir=artifacts_root,
        greeks_dir=greeks_dir,
        phase5_snapshot_path=phase5_target,
        latest_snapshot_id=str(selected_snapshot["snapshot_id"]),
        materialize_mode=materialize_mode,
        incremental_new_trades=incremental_new_trades,
        checkpoint_path=written_checkpoint,
        checkpoint_lag_count=checkpoint_lag_count,
        checkpoint_positions_sha256=checkpoint_positions_sha256,
        stage_timings_seconds=dict(timings),
        greeks_fetched_count=int(greeks_stats.fetched_count),
        greeks_cache_hits=int(greeks_stats.cache_hits),
        greeks_wall_seconds=float(timings["greeks_wall_seconds"]),
        greeks_429_count=int(greeks_stats.rate_limit_count),
        greeks_skipped_after_retries=int(greeks_stats.skipped_after_retries),
    )


def build_phase3_events(
    normalized_trade_rows: Iterable[dict[str, Any]],
    *,
    normalization_version: str = "phase2.v1",
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    for row in normalized_trade_rows:
        if str(row.get("underlying", "")).upper() != "BTC":
            continue
        if str(row.get("instrument_kind", "")).lower() != "option":
            continue

        trade_seq = row.get("trade_seq")
        option_type = row.get("option_type")
        expiry_ts_ms = row.get("expiry_ts_ms")
        strike = row.get("strike")

        if trade_seq is None or option_type is None or expiry_ts_ms is None or strike is None:
            raise ValueError(
                f"Normalized trade cannot be adapted into Phase 3 input: {row.get('instrument_name')}"
            )

        source_trade_id = str(row.get("trade_id") or row.get("raw_payload_sha256"))
        event_id = str(row.get("raw_payload_sha256") or f"{row.get('instrument_name')}:{source_trade_id}")
        events.append(
            {
                "event_id": event_id,
                "source_trade_id": source_trade_id,
                "trade_seq": int(trade_seq),
                "ts_ms": int(row["timestamp_ms"]),
                "venue": str(row.get("venue", "deribit")).lower(),
                "base_currency": str(row["underlying"]).upper(),
                "kind": "option",
                "instrument_name": str(row["instrument_name"]),
                "option_type": str(option_type).lower(),
                "strike": row["strike"],
                "expiry_ts_ms": int(expiry_ts_ms),
                "contract_size": "1",
                "amount": row["amount"],
                "price": row["price"],
                "taker_side": str(row["taker_side"]).lower(),
                "is_block_trade": bool(row.get("is_block", False)),
                "is_combo_trade": bool(row.get("is_combo", False)),
                "is_single_leg": not bool(row.get("is_combo", False)),
                "normalization_version": normalization_version,
            }
        )

    events.sort(key=lambda row: (int(row["trade_seq"]), int(row["ts_ms"]), str(row["event_id"])))
    return events


def _build_and_persist_flow_regime(
    *,
    artifacts_root: Path,
    profile: GEXProfile,
    greeks: dict[str, GreekSnapshot],
    gex_methodology_version: str,
    db_path: str | Path | None,
    normalization_version: str,
    ledger_methodology_version: str,
    strict_instrument_lookup: bool,
    lightweight: bool,
) -> dict[str, Any]:
    """Ring-buffer ΔGEX history + NY-session inventory polarity for Regime secondary."""
    as_of_ms = int(profile.as_of_ts)
    by_strike_now = strike_gex_map_from_profile_rows(profile.by_strike)
    net_gex_now = sum(by_strike_now.values())
    spot_candidates = [float(row.spot_price) for row in profile.instrument_rows if row.spot_price > 0]
    spot = float(median(spot_candidates)) if spot_candidates else 0.0

    history_doc = append_history_sample(
        artifacts_root,
        ts_ms=as_of_ms,
        spot=spot,
        net_gex=net_gex_now,
        by_strike=by_strike_now,
    )

    session_by_strike: dict[float, float] | None = None
    session_available = False
    session_status: str | None = None
    session_reason: str | None = None
    anchor_ms = ny_session_anchor_ms(as_of_ms)

    if db_path is None:
        session_status = "unavailable"
        session_reason = "No Phase 1 DB path for NY-session trade replay"
    elif as_of_ms < anchor_ms:
        # Before 08:00 America/New_York: session window not open yet.
        session_status = "pre_open"
        session_reason = "Before 08:00 America/New_York — session book not open"
        session_by_strike = {}
        session_available = True
    else:
        session_by_strike, compute_error = _compute_session_gex_by_strike(
            db_path=db_path,
            anchor_ms=anchor_ms,
            as_of_ms=as_of_ms,
            greeks=greeks,
            gex_methodology_version=gex_methodology_version,
            normalization_version=normalization_version,
            ledger_methodology_version=ledger_methodology_version,
            strict_instrument_lookup=strict_instrument_lookup,
            lightweight=lightweight,
        )
        if compute_error is not None:
            session_available = False
            session_status = "error"
            session_reason = compute_error
            session_by_strike = None
        else:
            session_available = True
            # empty vs ok decided inside _build_horizon from the strike map

    payload = build_flow_regime_payload(
        as_of_ms=as_of_ms,
        spot=spot,
        net_gex_now=net_gex_now,
        by_strike_now=by_strike_now,
        history_doc=history_doc,
        session_by_strike=session_by_strike,
        session_available=session_available,
        session_anchor_ms=anchor_ms,
        session_status=session_status,
        session_reason=session_reason,
    )

    # 25Δ normalized skew (Regime Velocity replacement). Additive — does not
    # touch Horizon / Net GEX / inventory / gex_window_history.
    try:
        payload["skew_25d"] = build_and_persist_skew_25d(
            artifacts_root,
            as_of_ms=as_of_ms,
            greeks=greeks,
        )
    except Exception as exc:  # noqa: BLE001 — never block flow_regime serve
        skew = empty_skew_25d_payload(as_of_ms=as_of_ms)
        skew["error"] = str(exc)[:240]
        payload["skew_25d"] = skew

    return payload


def _compute_session_gex_by_strike(
    *,
    db_path: str | Path,
    anchor_ms: int,
    as_of_ms: int,
    greeks: dict[str, GreekSnapshot],
    gex_methodology_version: str,
    normalization_version: str,
    ledger_methodology_version: str,
    strict_instrument_lookup: bool,
    lightweight: bool,
) -> tuple[dict[float, float] | None, str | None]:
    """Replay only production-eligible trades with ts ≥ NY open; GEX with current greeks.

    Returns ``(strike → net_gex, None)`` on success (empty dict when the session
    book has no eligible inventory). Returns ``(None, reason)`` on hard failure
    so Horizon can surface a diagnostic instead of a silent dash.
    """
    try:
        raw_instruments, raw_trades = load_raw_phase1_records(
            db_path,
            trades_after_timestamp_ms=int(anchor_ms),
        )
        phase2 = normalize_trade_batch(
            raw_instruments,
            raw_trades,
            method_version=normalization_version,
            strict_instrument_lookup=strict_instrument_lookup,
        )
        del raw_instruments
        del raw_trades

        events = build_phase3_events(
            phase2["trades"], normalization_version=normalization_version
        )
        instruments_by_name = _instruments_from_phase2_records(phase2["instruments"])
        del phase2

        # Strict session gate: trade timestamp ≥ today's 08:00 America/New_York.
        session_events = [
            row for row in events if int(row["ts_ms"]) >= int(anchor_ms) and int(row["ts_ms"]) <= int(as_of_ms)
        ]
        del events

        ledger_events = [LedgerNormalizedTradeEvent.from_dict(row) for row in session_events]
        del session_events

        ledger_result = LedgerReplayer(
            production_ledger_policy(
                methodology_version=ledger_methodology_version,
                snapshot_every=max(len(ledger_events), 1),
            )
        ).replay(
            ledger_events,
            retain_deltas=False,
            retain_intermediate_snapshots=False,
        )
        del ledger_events

        snapshots = [record.to_dict() for record in ledger_result.snapshots]
        if not snapshots:
            return {}, None
        selected = select_snapshot(snapshots, snapshot_id=None)
        inventory_rows = enrich_snapshot_positions(selected, instruments_by_name)

        gex_rows = [
            DealerInventoryRow(
                instrument_name=row.instrument_name,
                option_type=row.option_type,
                strike=float(row.strike),
                expiry_ts=int(row.expiry_ts),
                net_contracts=float(row.net_contracts),
                contract_multiplier=float(row.contract_multiplier),
                include_in_gex=bool(row.include_in_gex),
            )
            for row in inventory_rows
            if (not lightweight) or int(row.expiry_ts) >= as_of_ms
        ]
        session_profile = compute_gex_profile(
            inventory_rows=gex_rows,
            greeks_by_instrument=greeks,
            methodology_version=gex_methodology_version,
            as_of_ts=as_of_ms,
        )
        return strike_gex_map_from_profile_rows(session_profile.by_strike), None
    except Exception as exc:  # noqa: BLE001 — Horizon must not fail materialize
        return None, f"{type(exc).__name__}: {exc}"[:240]


def build_phase5_snapshot_payload(profile: GEXProfile) -> dict[str, Any]:
    rows_by_bucket: dict[tuple[str, float], dict[str, float]] = {}

    for row in profile.instrument_rows:
        expiry = datetime.fromtimestamp(row.expiry_ts / 1000, tz=UTC).date().isoformat()
        bucket = rows_by_bucket.setdefault(
            (expiry, float(row.strike)),
            {
                "expiry": expiry,
                "strike": float(row.strike),
                "call_gex": 0.0,
                "put_gex": 0.0,
                "call_open_interest": 0.0,
                "put_open_interest": 0.0,
                "call_iv_weighted": 0.0,
                "put_iv_weighted": 0.0,
            },
        )
        option_type = row.option_type
        open_interest = float(row.open_interest or 0.0)
        mark_iv = float(row.mark_iv or 0.0)
        bucket[option_type + "_gex"] += float(row.dollar_gamma_per_1pct)
        bucket[option_type + "_open_interest"] += open_interest
        bucket[option_type + "_iv_weighted"] += mark_iv * open_interest

    rows = []
    for _, bucket in sorted(rows_by_bucket.items(), key=lambda item: (item[0][0], item[0][1])):
        call_gex = float(bucket["call_gex"])
        put_gex = float(bucket["put_gex"])
        call_open_interest = float(bucket["call_open_interest"])
        put_open_interest = float(bucket["put_open_interest"])
        open_interest = call_open_interest + put_open_interest
        call_mark_iv = _weighted_average(bucket["call_iv_weighted"], call_open_interest)
        put_mark_iv = _weighted_average(bucket["put_iv_weighted"], put_open_interest)
        mark_iv = _weighted_average(
            bucket["call_iv_weighted"] + bucket["put_iv_weighted"],
            open_interest,
        )
        rows.append(
            {
                "expiry": str(bucket["expiry"]),
                "strike": float(bucket["strike"]),
                "net_gex": call_gex + put_gex,
                "call_gex": call_gex,
                "put_gex": put_gex,
                "open_interest": open_interest,
                "call_open_interest": call_open_interest,
                "put_open_interest": put_open_interest,
                "mark_iv": mark_iv,
                "call_mark_iv": call_mark_iv,
                "put_mark_iv": put_mark_iv,
            }
        )

    spot_candidates = [float(row.spot_price) for row in profile.instrument_rows]
    if not spot_candidates:
        spot_candidates = [0.0]

    return {
        "as_of": _isoformat_utc(profile.as_of_ts),
        "underlying": "BTC",
        "spot_price": float(median(spot_candidates)),
        "rows": rows,
    }


def _weighted_average(weighted_total: float, total_weight: float) -> float | None:
    if total_weight <= 0:
        return None

    return weighted_total / total_weight


def _load_or_fetch_greeks(
    *,
    greeks_dir: Path,
    greeks_json: str | Path | None,
    instrument_names: Iterable[str],
) -> tuple[dict[str, GreekSnapshot], GreeksFetchStats]:
    """Load frozen Greeks or fetch live tickers (cached + concurrent).

    Live path uses the process-wide short TTL cache so consecutive materialize
    cycles only hit Deribit for missing/stale instruments. Inventory filtering
    (non-zero, live) is applied by the caller before ``instrument_names``.
    """
    names = list(instrument_names)
    if greeks_json is not None:
        started = time.perf_counter()
        snapshots = load_greeks_snapshot_json(greeks_json)
        wall = round(time.perf_counter() - started, 3)
        # Frozen file path: treat as full coverage with zero network fetches.
        stats = GreeksFetchStats(
            requested_count=len(names),
            fetched_count=0,
            cache_hits=len(names),
            skipped_count=0,
            wall_seconds=wall,
        )
        return snapshots, stats

    with DeribitPublicGreeksProvider() as provider:
        snapshots = provider.fetch_greeks_for_instruments(names)
        stats = provider.last_stats

    write_greeks_snapshot_json(snapshots, greeks_dir / "greeks_snapshot.json")
    return snapshots, stats


def _instruments_from_phase2_records(
    records: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Build CanonicalInstrument map without a multi-MB JSONL round-trip."""
    registry = InstrumentRegistry.build(records)
    return {instrument.instrument_name: instrument for instrument in registry.values()}


def _try_bootstrap_checkpoint_from_snapshot(
    *,
    artifacts_root: Path,
    db_path: str | Path,
    normalization_version: str,
    ledger_methodology_version: str,
    gex_methodology_version: str,
    instrument_count: int,
    trade_count: int,
) -> InventoryCheckpoint | None:
    """Build a one-shot checkpoint from the last final inventory snapshot.

    Per-instrument trade_seq cursors are taken only from trades at or before the
    snapshot watermark so any newer raw trades are still applied incrementally.
    This assumes the saved final book was produced by the same methodology from
    the Phase 1 history up to that watermark (true for prior Lotus materializes).
    """
    snapshots_path = artifacts_root / "dealer_inventory_snapshots.jsonl"
    if not snapshots_path.exists():
        return None

    try:
        lines = [
            json.loads(line)
            for line in snapshots_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if not lines:
            return None
        selected = select_snapshot(lines, snapshot_id=None)
        positions = {
            str(name): to_decimal(value)
            for name, value in dict(selected.get("positions") or {}).items()
        }
        if not positions:
            return None

        snapshot_ts = int(selected.get("ts_ms") or 0)
        if snapshot_ts <= 0:
            return None

        # Count trades that should already be reflected in the book so the
        # checkpoint's raw_trade_count is not the live total (which would hide
        # catch-up work). Compatibility only rejects regressions below this.
        with sqlite3.connect(db_path) as conn:
            covered_trade_count = int(
                conn.execute(
                    "SELECT COUNT(*) FROM raw_trades WHERE timestamp_ms <= ?",
                    (snapshot_ts,),
                ).fetchone()[0]
            )
            cursor_rows = conn.execute(
                """
                SELECT instrument_name, MAX(trade_seq)
                FROM raw_trades
                WHERE trade_seq IS NOT NULL AND timestamp_ms <= ?
                GROUP BY instrument_name
                """,
                (snapshot_ts,),
            ).fetchall()

        instrument_cursors = {
            str(name): int(seq) for name, seq in cursor_rows if seq is not None
        }
        return build_checkpoint(
            normalization_version=normalization_version,
            ledger_methodology_version=ledger_methodology_version,
            gex_methodology_version=gex_methodology_version,
            raw_trade_count=covered_trade_count,
            raw_instrument_count=instrument_count,
            max_timestamp_ms=snapshot_ts,
            last_trade_seq=int(selected.get("last_trade_seq", -1)),
            final_ts_ms=snapshot_ts,
            input_event_count=covered_trade_count,
            applied_event_count=0,
            excluded_event_count=0,
            positions=positions,
            instrument_cursors=instrument_cursors,
        )
    except (OSError, ValueError, KeyError, json.JSONDecodeError, TypeError):
        return None


def _prune_heavy_artifacts(artifacts_root: Path) -> None:
    for name in _HEAVY_ARTIFACT_NAMES:
        path = artifacts_root / name
        if path.exists():
            try:
                path.unlink()
            except OSError:
                pass


def _load_payload_rows(
    conn: sqlite3.Connection,
    query: str,
    params: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    rows = conn.execute(query, params).fetchall()
    return [json.loads(row[0]) for row in rows]


def _write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True))
            handle.write("\n")


def _write_gex_by_strike_csv(path: Path, by_strike) -> None:
    """Write only the strike profile CSV (secondary include-OTC artifact)."""
    import csv
    from dataclasses import asdict

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    records = list(by_strike)
    if not records:
        path.write_text("", encoding="utf-8")
        return
    first = asdict(records[0])
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(first.keys()))
        writer.writeheader()
        writer.writerow(first)
        for row in records[1:]:
            writer.writerow(asdict(row))


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON via temp file + os.replace so readers never see partial JSON."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp.replace(target)


def _isoformat_utc(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC).isoformat().replace("+00:00", "Z")
