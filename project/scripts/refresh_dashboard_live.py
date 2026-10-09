from __future__ import annotations

import argparse
import json
import sqlite3
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import _bootstrap  # noqa: F401

from api.config import settings as api_settings
from collector.config import Settings
from collector.deribit_client import build_live_client
from collector.phase1_sync import Phase1SyncService
from ledger.raw_store import RawStore
from pipeline.dashboard_snapshot import materialize_dashboard_snapshot
from vol_surface.atm_refresh import AtmCurveRefresher
from vol_surface.skew_refresh import SkewRefresher

# Main Deribit public trade hot-store is roughly ~24h. Cap self-heal windows so
# a multi-day gap falls back to historical_backfill rather than empty main-host
# pages that mark chunks completed with zero rows.
_MAIN_HOST_CATCHUP_CAP_MS = 20 * 60 * 60 * 1000  # 20 hours
# Overlap a few seconds before DB max so equal-timestamp races at the watermark
# are re-fetched; INSERT OR IGNORE keeps this idempotent.
_WATERMARK_OVERLAP_MS = 1_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Continuously backfill a rolling BTC options window and refresh the Phase 5 dashboard snapshot."
    )
    parser.add_argument(
        "--db-path",
        default="project/data/phase1_history.sqlite3",
        help=(
            "Path to the Phase 1 SQLite database. "
            "Phase 6 default is the history-backed live DB "
            "(project/data/phase1_history.sqlite3)."
        ),
    )
    parser.add_argument(
        "--artifacts-dir",
        default="project/runtime/dashboard_build",
        help="Directory for intermediate Phase 2/3/4 artifacts.",
    )
    parser.add_argument(
        "--snapshot-path",
        default=str(api_settings.snapshot_path),
        help="Destination for the Phase 5 dashboard snapshot JSON.",
    )
    parser.add_argument(
        "--job-name",
        default="btc_options_live",
        help="Stable backfill job name for resume state.",
    )
    parser.add_argument(
        "--lookback-minutes",
        type=int,
        default=30,
        help=(
            "Minimum rolling lookback for each live sync pass. "
            "Actual start is min(now - lookback, max(DB max trade, now - 20h)) "
            "so multi-hour outages self-heal without a manual catch-up window."
        ),
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=60,
        help=(
            "Target seconds between cycle starts. Slow cycles begin the next pass "
            "immediately; fast cycles sleep only for the remaining cadence."
        ),
    )
    parser.add_argument(
        "--greeks-json",
        default=None,
        help="Optional frozen greeks JSON to use instead of live Deribit ticker calls.",
    )
    parser.add_argument(
        "--materialize-mode",
        choices=("auto", "full", "incremental"),
        default="auto",
        help=(
            "Materialize strategy. auto (default) uses the inventory checkpoint "
            "when present and only replays newly ingested trades; full rebuilds "
            "the entire history book (slow on deep DBs)."
        ),
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single backfill + materialization cycle and exit.",
    )
    return parser.parse_args()


def max_raw_trade_timestamp_ms(db_path: str | Path) -> int | None:
    """Return MAX(timestamp_ms) from raw_trades, or None if empty/missing."""
    path = Path(db_path)
    if not path.exists():
        return None
    try:
        with sqlite3.connect(path) as conn:
            row = conn.execute("SELECT MAX(timestamp_ms) FROM raw_trades").fetchone()
    except sqlite3.Error:
        return None
    if row is None or row[0] is None:
        return None
    return int(row[0])


def resolve_live_sync_window(
    *,
    now_ms: int,
    lookback_minutes: int,
    db_max_timestamp_ms: int | None,
    main_host_cap_ms: int = _MAIN_HOST_CATCHUP_CAP_MS,
    watermark_overlap_ms: int = _WATERMARK_OVERLAP_MS,
) -> tuple[int, int, dict[str, object]]:
    """Choose [start_ms, end_ms] for a live main-host append.

    Start is the earlier of:
    - wall-clock lookback (now - lookback_minutes), and
    - last known DB trade (minus a small overlap),

    but never older than ``now - main_host_cap_ms`` so we stay inside the main
    host's hot public store. Multi-day gaps still need history.deribit.com.
    """
    lookback_ms = max(int(lookback_minutes), 1) * 60_000
    wall_start_ms = now_ms - lookback_ms
    floor_ms = now_ms - int(main_host_cap_ms)

    if db_max_timestamp_ms is None:
        start_ms = max(wall_start_ms, floor_ms)
        source = "lookback_only"
    else:
        # Resume slightly before the watermark; INSERT OR IGNORE dedupes.
        from_db_ms = int(db_max_timestamp_ms) - int(watermark_overlap_ms)
        # Self-heal: pull from the earlier of lookback and DB watermark, but
        # never older than the main-host retention floor.
        start_ms = max(min(wall_start_ms, from_db_ms), floor_ms)
        if from_db_ms < wall_start_ms:
            source = "db_watermark"
        else:
            source = "lookback"

    end_ms = now_ms
    if start_ms > end_ms:
        start_ms = end_ms

    meta: dict[str, object] = {
        "sync_window_source": source,
        "db_max_timestamp_ms": db_max_timestamp_ms,
        "wall_lookback_start_ms": wall_start_ms,
        "main_host_floor_ms": floor_ms,
        "start_ms": start_ms,
        "end_ms": end_ms,
    }
    return start_ms, end_ms, meta


def main() -> None:
    args = parse_args()
    # ATM quote collection runs throughout slow trade/inventory cycles, rather
    # than waiting behind ingestion, replay, and the larger GEX ticker batch.
    atm_worker = None
    skew_worker = None
    if not args.once and args.greeks_json is None:
        atm_worker = AtmCurveRefresher(args.artifacts_dir)
        atm_worker.start()  # An existing standalone collector can own the lease.
        skew_worker = SkewRefresher(args.artifacts_dir)
        skew_worker.start()
    try:
        run_loop(args)
    finally:
        if atm_worker is not None:
            atm_worker.stop()
        if skew_worker is not None:
            skew_worker.stop()


def run_loop(args: argparse.Namespace) -> None:
    cycle = 0

    while True:
        cycle += 1
        cycle_started = time.monotonic()
        try:
            summary = run_cycle(args)
            # flush so operator logs stay current under Windows pipe buffering
            print(json.dumps(summary, indent=2), flush=True)
        except Exception as exc:
            # Phase 6: one bad cycle must not kill continuous collection.
            print(
                json.dumps(
                    {
                        "status": "cycle_failed",
                        "cycle": cycle,
                        "error": str(exc),
                        "error_type": type(exc).__name__,
                        "db_path": args.db_path,
                        "job_name": args.job_name,
                    },
                    indent=2,
                ),
                flush=True,
            )
            if args.once:
                raise

        if args.once:
            return

        elapsed = time.monotonic() - cycle_started
        time.sleep(max(float(args.interval_seconds) - elapsed, 1.0))


def run_cycle(args: argparse.Namespace) -> dict[str, object]:
    now = datetime.now(UTC)
    end_ms = int(now.timestamp() * 1000)
    db_max_ms = max_raw_trade_timestamp_ms(args.db_path)
    start_ms, end_ms, window_meta = resolve_live_sync_window(
        now_ms=end_ms,
        lookback_minutes=args.lookback_minutes,
        db_max_timestamp_ms=db_max_ms,
    )

    # Live refresh uses the main Deribit host only. Window start self-heals from
    # MAX(raw_trades.timestamp_ms) when the worker was down longer than lookback,
    # capped at ~20h so empty main-host pages do not poison cursors. Gaps beyond
    # that still need historical_backfill / backfill_phase1 on history.deribit.com.
    settings = Settings.from_env().with_overrides(db_path=args.db_path)
    store = RawStore(settings.db_path)
    store.ensure_schema()

    with build_live_client(settings) as client:
        service = Phase1SyncService(client, store, settings, history_client=None)
        run_id = store.start_run(start_ms, end_ms)

        try:
            # Live trades can only reference active instruments. Historical
            # catalogs already remain in SQLite; avoid re-downloading the main
            # host's expired catalog every minute.
            instrument_rows = service.sync_instruments(include_expired=False)
            backfill = service.backfill_trades(
                start_ms=start_ms,
                end_ms=end_ms,
                run_id=run_id,
                job_name=args.job_name,
                # Rolling live windows are deliberately re-fetched and deduped.
                # Persisting their ever-changing chunk boundaries only bloats
                # backfill_cursors; durable cursors remain enabled for history.
                persist_cursors=False,
            )
            store.finish_run(
                run_id,
                "completed",
                {
                    "job_name": args.job_name,
                    "instrument_rows_upserted": instrument_rows,
                    "backfill": backfill,
                    "sync_window": window_meta,
                },
            )
        except Exception as exc:
            store.finish_run(run_id, "failed", {"error": str(exc), "job_name": args.job_name})
            store.close()
            raise
        finally:
            store.close()

    # Non-strict + lightweight + checkpointed incremental:
    # - orphan trades excluded
    # - skip multi-GB intermediate artifacts; prune leftovers
    # - Greek only live/active inventory
    # - auto mode replays only newly ingested trades against inventory_checkpoint.json
    #   so deep YTD history does not force a full-book rebuild every cycle
    snapshot = materialize_dashboard_snapshot(
        db_path=args.db_path,
        artifacts_dir=args.artifacts_dir,
        snapshot_path=args.snapshot_path,
        greeks_json=args.greeks_json,
        fail_on_empty=False,
        strict_instrument_lookup=False,
        lightweight=True,
        mode=args.materialize_mode,
    )

    return {
        "as_of": now.isoformat().replace("+00:00", "Z"),
        "db_path": args.db_path,
        "job_name": args.job_name,
        "lookback_minutes": args.lookback_minutes,
        "interval_seconds": args.interval_seconds,
        "sync_window": window_meta,
        "raw_trade_count": snapshot.raw_trade_count,
        "inventory_row_count": snapshot.inventory_row_count,
        "snapshot_row_count": snapshot.snapshot_row_count,
        "snapshot_path": str(snapshot.phase5_snapshot_path),
        "materialize_mode": snapshot.materialize_mode,
        "incremental_new_trades": snapshot.incremental_new_trades,
        "checkpoint_path": snapshot.checkpoint_path,
        "stage_timings_seconds": snapshot.stage_timings_seconds,
        "greeks_fetched_count": snapshot.greeks_fetched_count,
        "greeks_cache_hits": snapshot.greeks_cache_hits,
        "greeks_wall_seconds": snapshot.greeks_wall_seconds,
    }


if __name__ == "__main__":
    main()
