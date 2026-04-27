from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import _bootstrap  # noqa: F401


DEFAULT_START = "2026-01-26T00:00:00Z"
DEFAULT_END = "2026-04-26T00:00:00Z"
DEFAULT_DB_PATH = "project/data/phase1_history.sqlite3"
DEFAULT_ARTIFACTS_DIR = "project/runtime/history_validation"
DEFAULT_SNAPSHOT_PATH = "project/runtime/history_validation/latest_gex_snapshot.json"
DEFAULT_JOB_NAME = "btc_options_history_2026_01_26_2026_04_26"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the production-depth BTC options historical backfill and validation workflow."
    )
    parser.add_argument("--start", default=DEFAULT_START, help="UTC ISO-8601 backfill start.")
    parser.add_argument("--end", default=DEFAULT_END, help="UTC ISO-8601 backfill end.")
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH, help="Historical SQLite database path.")
    parser.add_argument("--job-name", default=DEFAULT_JOB_NAME, help="Stable resumable backfill job name.")
    parser.add_argument("--artifacts-dir", default=DEFAULT_ARTIFACTS_DIR, help="Validation artifact directory.")
    parser.add_argument("--snapshot-path", default=DEFAULT_SNAPSHOT_PATH, help="Validation snapshot JSON path.")
    parser.add_argument("--greeks-json", default=None, help="Optional frozen Greeks JSON for deterministic validation.")
    parser.add_argument(
        "--minimum-history-hours",
        type=float,
        default=24.0 * 90.0,
        help="Minimum raw trade coverage required for the history audit.",
    )
    parser.add_argument(
        "--validate-remote",
        action="store_true",
        help="Run live Deribit sample-window reconciliation after materialization.",
    )
    parser.add_argument(
        "--skip-backfill",
        action="store_true",
        help="Only run validation/materialization against the existing historical DB.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _validate_window(args.start, args.end)

    commands: list[list[str]] = []
    if not args.skip_backfill:
        commands.append(
            [
                sys.executable,
                "project/scripts/backfill_phase1.py",
                "--start",
                args.start,
                "--end",
                args.end,
                "--db-path",
                args.db_path,
                "--job-name",
                args.job_name,
            ]
        )

    validation_cmd = [
        sys.executable,
        "project/scripts/validate_dashboard_pipeline.py",
        "--db-path",
        args.db_path,
        "--artifacts-dir",
        args.artifacts_dir,
        "--snapshot-path",
        args.snapshot_path,
        "--minimum-history-hours",
        str(args.minimum_history_hours),
    ]
    if args.greeks_json:
        validation_cmd.extend(["--greeks-json", args.greeks_json])
    if args.validate_remote:
        validation_cmd.append("--validate-remote")
    commands.append(validation_cmd)

    for command in commands:
        completed = subprocess.run(command, cwd=Path(__file__).resolve().parents[2])
        if completed.returncode != 0:
            return completed.returncode

    print(
        json.dumps(
            {
                "status": "completed",
                "db_path": args.db_path,
                "job_name": args.job_name,
                "validation_report": str(Path(args.artifacts_dir) / "validation_report.json"),
                "snapshot_path": args.snapshot_path,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def _validate_window(start: str, end: str) -> None:
    start_dt = _parse_utc(start)
    end_dt = _parse_utc(end)
    if end_dt <= start_dt:
        raise SystemExit("--end must be greater than --start")


def _parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


if __name__ == "__main__":
    sys.exit(main())
