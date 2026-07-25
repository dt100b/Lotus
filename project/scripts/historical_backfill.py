from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import _bootstrap  # noqa: F401


def _utc_now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def _ytd_start(end: datetime) -> datetime:
    """UTC midnight on 1 January of the end date's calendar year."""
    return datetime(end.year, 1, 1, tzinfo=UTC)


_DEFAULT_END_DT = _utc_now()
_DEFAULT_START_DT = _ytd_start(_DEFAULT_END_DT)
_DEFAULT_YTD_HOURS = max((_DEFAULT_END_DT - _DEFAULT_START_DT).total_seconds() / 3600.0, 1.0)
# One-day slack: coverage is measured from first/last raw trade timestamps, not the request window.
_DEFAULT_MINIMUM_HISTORY_HOURS = max(_DEFAULT_YTD_HOURS - 24.0, 1.0)

DEFAULT_START = _DEFAULT_START_DT.isoformat().replace("+00:00", "Z")
DEFAULT_END = _DEFAULT_END_DT.isoformat().replace("+00:00", "Z")
DEFAULT_DB_PATH = "project/data/phase1_history.sqlite3"
DEFAULT_ARTIFACTS_DIR = "project/runtime/history_validation"
DEFAULT_SNAPSHOT_PATH = "project/runtime/history_validation/latest_gex_snapshot.json"
DEFAULT_JOB_NAME = f"btc_options_history_ytd_{_DEFAULT_START_DT:%Y}"
DEFAULT_MINIMUM_HISTORY_HOURS = _DEFAULT_MINIMUM_HISTORY_HOURS


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the production-depth BTC options historical backfill and validation workflow. "
            "Defaults to year-to-date (YTD) depth via history.deribit.com — the minimum ship bar."
        )
    )
    parser.add_argument(
        "--start",
        default=DEFAULT_START,
        help="UTC ISO-8601 backfill start (default: 1 Jan UTC of the current year).",
    )
    parser.add_argument("--end", default=DEFAULT_END, help="UTC ISO-8601 backfill end (default: now UTC).")
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH, help="Historical SQLite database path.")
    parser.add_argument("--job-name", default=DEFAULT_JOB_NAME, help="Stable resumable backfill job name.")
    parser.add_argument("--artifacts-dir", default=DEFAULT_ARTIFACTS_DIR, help="Validation artifact directory.")
    parser.add_argument("--snapshot-path", default=DEFAULT_SNAPSHOT_PATH, help="Validation snapshot JSON path.")
    parser.add_argument("--greeks-json", default=None, help="Optional frozen Greeks JSON for deterministic validation.")
    parser.add_argument(
        "--minimum-history-hours",
        type=float,
        default=DEFAULT_MINIMUM_HISTORY_HOURS,
        help=(
            "Minimum raw trade coverage required for the history audit "
            "(default: YTD span minus 24h slack)."
        ),
    )
    parser.add_argument(
        "--validate-remote",
        action="store_true",
        help="Run sample-window reconciliation against the trade host after materialization.",
    )
    parser.add_argument(
        "--skip-backfill",
        action="store_true",
        help="Only run validation/materialization against the existing historical DB.",
    )
    parser.add_argument(
        "--reset-empty-cursors",
        action="store_true",
        default=True,
        help=(
            "Reset completed empty cursors before backfill (default: on). "
            "Helps re-fetch chunks previously completed empty against the main host."
        ),
    )
    parser.add_argument(
        "--no-reset-empty-cursors",
        action="store_false",
        dest="reset_empty_cursors",
        help="Do not reset empty completed cursors before backfill.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _validate_window(args.start, args.end)

    commands: list[list[str]] = []
    if not args.skip_backfill:
        backfill_cmd = [
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
        if args.reset_empty_cursors:
            backfill_cmd.append("--reset-empty-cursors")
        commands.append(backfill_cmd)

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
                "start": args.start,
                "end": args.end,
                "minimum_history_hours": args.minimum_history_hours,
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
