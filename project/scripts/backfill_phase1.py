from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict

import _bootstrap  # noqa: F401

from collector.config import Settings
from collector.deribit_client import build_clients
from collector.phase1_sync import Phase1SyncService, parse_iso_to_ms
from ledger.raw_store import RawStore


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Phase 1 Deribit BTC options raw backfill")
    parser.add_argument("--start", required=True, help="UTC ISO-8601 start")
    parser.add_argument("--end", required=True, help="UTC ISO-8601 end")
    parser.add_argument("--db-path", default=None, help="Override SQLite path")
    parser.add_argument(
        "--job-name",
        required=True,
        help="Stable backfill job identity for cursor/resume, e.g. btc_options_2026_04_24",
    )
    parser.add_argument(
        "--reset-empty-cursors",
        action="store_true",
        help=(
            "Delete completed cursors with fetched_rows=0 for this job before running. "
            "Use when re-backfilling older windows after switching to history.deribit.com."
        ),
    )
    parser.add_argument(
        "--no-history",
        action="store_true",
        help="Force trade backfill onto the main Deribit host (ignore history URL).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    settings = Settings.from_env()

    if args.db_path:
        settings = settings.with_overrides(db_path=args.db_path)
    if args.no_history:
        settings = settings.with_overrides(use_history_for_backfill=False)

    start_ms = parse_iso_to_ms(args.start)
    end_ms = parse_iso_to_ms(args.end)

    if end_ms <= start_ms:
        raise SystemExit("--end must be greater than --start")

    store = RawStore(settings.db_path)
    store.ensure_schema()

    reset_count = 0
    if args.reset_empty_cursors:
        # Ensure job row exists so FK on backfill_cursors is valid for future inserts.
        store.upsert_backfill_job(
            job_name=args.job_name,
            window_start_ms=start_ms,
            window_end_ms=end_ms,
            status="running",
        )
        reset_count = store.reset_empty_completed_cursors(args.job_name)

    live_client, history_client = build_clients(settings)
    try:
        service = Phase1SyncService(
            live_client,
            store,
            settings,
            history_client=history_client,
        )
        run_id = store.start_run(start_ms, end_ms)

        try:
            instrument_rows = service.sync_instruments()
            backfill_summary = service.backfill_trades(
                start_ms=start_ms,
                end_ms=end_ms,
                run_id=run_id,
                job_name=args.job_name,
            )
            validations = service.validate_sample_windows(start_ms, end_ms)

            summary = {
                "run_id": run_id,
                "job_name": args.job_name,
                "instrument_rows_upserted": instrument_rows,
                "total_instruments": store.count_instruments(),
                "total_trades": store.count_trades(),
                "duplicate_trade_groups": store.duplicate_trade_count(),
                "empty_cursors_reset": reset_count,
                "trade_host": backfill_summary.get("trade_host"),
                "backfill": backfill_summary,
                "validations": [asdict(row) for row in validations],
                "chunk_size_ms": settings.chunk_size_ms,
                "resume_enabled": settings.resume_enabled,
                "page_size": settings.page_size,
                "history_page_size": settings.history_page_size,
                "use_history_for_backfill": settings.use_history_for_backfill,
            }

            passed = (
                summary["duplicate_trade_groups"] == 0
                and all(row["missing_count"] == 0 and row["extra_count"] == 0 for row in summary["validations"])
            )

            store.finish_run(run_id, "completed" if passed else "failed_validation", summary)
            print(json.dumps(summary, indent=2))

            return 0 if passed else 2

        except Exception as exc:
            store.finish_run(run_id, "failed", {"error": str(exc), "job_name": args.job_name})
            raise
        finally:
            store.close()
    finally:
        live_client.close()
        if history_client is not None:
            history_client.close()


if __name__ == "__main__":
    sys.exit(main())
