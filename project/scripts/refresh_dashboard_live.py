from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, datetime, timedelta

import _bootstrap  # noqa: F401

from api.config import settings as api_settings
from collector.config import Settings
from collector.deribit_client import DeribitPublicClient
from collector.phase1_sync import Phase1SyncService
from ledger.raw_store import RawStore
from pipeline.dashboard_snapshot import materialize_dashboard_snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Continuously backfill a rolling BTC options window and refresh the Phase 5 dashboard snapshot."
    )
    parser.add_argument(
        "--db-path",
        default="project/data/phase1.sqlite3",
        help="Path to the Phase 1 SQLite database.",
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
        default=120,
        help="Rolling lookback window for each live sync pass.",
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=30,
        help="Seconds to wait between refresh cycles.",
    )
    parser.add_argument(
        "--greeks-json",
        default=None,
        help="Optional frozen greeks JSON to use instead of live Deribit ticker calls.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single backfill + materialization cycle and exit.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cycle = 0

    while True:
        cycle += 1
        summary = run_cycle(args)
        print(json.dumps(summary, indent=2))

        if args.once:
            return

        time.sleep(max(args.interval_seconds, 1))


def run_cycle(args: argparse.Namespace) -> dict[str, object]:
    now = datetime.now(UTC)
    start = now - timedelta(minutes=args.lookback_minutes)
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(now.timestamp() * 1000)

    settings = Settings.from_env().with_overrides(db_path=args.db_path)
    store = RawStore(settings.db_path)
    store.ensure_schema()

    with DeribitPublicClient(
        settings.deribit_base_url,
        settings.request_timeout_s,
        settings.max_retries,
        settings.retry_backoff_s,
    ) as client:
        service = Phase1SyncService(client, store, settings)
        run_id = store.start_run(start_ms, end_ms)

        try:
            instrument_rows = service.sync_instruments()
            backfill = service.backfill_trades(
                start_ms=start_ms,
                end_ms=end_ms,
                run_id=run_id,
                job_name=args.job_name,
            )
            store.finish_run(
                run_id,
                "completed",
                {
                    "job_name": args.job_name,
                    "instrument_rows_upserted": instrument_rows,
                    "backfill": backfill,
                },
            )
        except Exception as exc:
            store.finish_run(run_id, "failed", {"error": str(exc), "job_name": args.job_name})
            store.close()
            raise
        finally:
            store.close()

    snapshot = materialize_dashboard_snapshot(
        db_path=args.db_path,
        artifacts_dir=args.artifacts_dir,
        snapshot_path=args.snapshot_path,
        greeks_json=args.greeks_json,
        fail_on_empty=False,
    )

    return {
        "as_of": now.isoformat().replace("+00:00", "Z"),
        "db_path": args.db_path,
        "job_name": args.job_name,
        "lookback_minutes": args.lookback_minutes,
        "interval_seconds": args.interval_seconds,
        "raw_trade_count": snapshot.raw_trade_count,
        "inventory_row_count": snapshot.inventory_row_count,
        "snapshot_row_count": snapshot.snapshot_row_count,
        "snapshot_path": str(snapshot.phase5_snapshot_path),
    }


if __name__ == "__main__":
    main()
