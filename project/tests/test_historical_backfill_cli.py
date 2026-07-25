from __future__ import annotations

from datetime import UTC, datetime

from project.scripts.historical_backfill import (
    DEFAULT_DB_PATH,
    DEFAULT_END,
    DEFAULT_JOB_NAME,
    DEFAULT_MINIMUM_HISTORY_HOURS,
    DEFAULT_START,
    parse_args,
)


def test_historical_backfill_defaults_target_ytd_history(monkeypatch) -> None:
    monkeypatch.setattr("sys.argv", ["historical_backfill.py", "--skip-backfill"])

    args = parse_args()

    assert args.start == DEFAULT_START
    assert args.end == DEFAULT_END
    assert args.db_path == DEFAULT_DB_PATH
    assert args.job_name == DEFAULT_JOB_NAME
    assert args.minimum_history_hours == DEFAULT_MINIMUM_HISTORY_HOURS
    assert args.skip_backfill is True
    assert args.reset_empty_cursors is True

    start = datetime.fromisoformat(args.start.replace("Z", "+00:00"))
    end = datetime.fromisoformat(args.end.replace("Z", "+00:00"))
    assert start.tzinfo is not None
    assert end.tzinfo is not None
    assert start.year == end.astimezone(UTC).year
    assert start.month == 1 and start.day == 1
    assert start.hour == 0 and start.minute == 0 and start.second == 0
    assert DEFAULT_JOB_NAME == f"btc_options_history_ytd_{start.year}"
    # YTD span minus 24h slack (or at least 1h early in the year).
    ytd_hours = (end - start).total_seconds() / 3600.0
    assert abs(args.minimum_history_hours - max(ytd_hours - 24.0, 1.0)) < 1e-6


def test_historical_backfill_can_disable_empty_cursor_reset(monkeypatch) -> None:
    monkeypatch.setattr(
        "sys.argv",
        ["historical_backfill.py", "--skip-backfill", "--no-reset-empty-cursors"],
    )
    args = parse_args()
    assert args.reset_empty_cursors is False
