from __future__ import annotations

from project.scripts.historical_backfill import (
    DEFAULT_DB_PATH,
    DEFAULT_END,
    DEFAULT_JOB_NAME,
    DEFAULT_START,
    parse_args,
)


def test_historical_backfill_defaults_target_90_day_history(monkeypatch) -> None:
    monkeypatch.setattr("sys.argv", ["historical_backfill.py", "--skip-backfill"])

    args = parse_args()

    assert args.start == DEFAULT_START
    assert args.end == DEFAULT_END
    assert args.db_path == DEFAULT_DB_PATH
    assert args.job_name == DEFAULT_JOB_NAME
    assert args.minimum_history_hours == 24.0 * 90.0
    assert args.skip_backfill is True
