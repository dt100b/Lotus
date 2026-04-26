from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict

from collector.config import Settings
from collector.deribit_client import DeribitPublicClient
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
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    settings = Settings.from_env()

    if args.db_path:
        settings = settings.with_overrides(db_path=args.db_path)

    start_ms = parse_iso_to_ms(args.start)
    end_ms = parse_iso_to_ms(args.end)

    if end_ms <= start_ms:
        raise SystemExit("--end must be greater than --start")

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
                "backfill": backfill_summary,
                "validations": [asdict(row) for row in validations],
                "chunk_size_ms": settings.chunk_size_ms,
                "resume_enabled": settings.resume_enabled,
                "page_size": settings.page_size,
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


if __name__ == "__main__":
    sys.exit(main())
