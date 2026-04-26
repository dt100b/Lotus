from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

import _bootstrap  # noqa: F401


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect counts and time ranges in a Phase 1 SQLite database.")
    parser.add_argument(
        "--db-path",
        default="project/data/phase1.sqlite3",
        help="Path to the Phase 1 SQLite database.",
    )
    return parser.parse_args()


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def main() -> None:
    args = parse_args()
    db_path = Path(args.db_path)
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    conn = sqlite3.connect(db_path)
    summary: dict[str, object] = {"db_path": str(db_path)}

    try:
        for table in ("raw_instruments", "raw_trades", "ingest_runs", "backfill_jobs", "backfill_cursors"):
            if _table_exists(conn, table):
                summary[f"{table}_count"] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

        if _table_exists(conn, "raw_trades"):
            summary["raw_trade_min_timestamp_ms"] = conn.execute(
                "SELECT MIN(timestamp_ms) FROM raw_trades"
            ).fetchone()[0]
            summary["raw_trade_max_timestamp_ms"] = conn.execute(
                "SELECT MAX(timestamp_ms) FROM raw_trades"
            ).fetchone()[0]

        if _table_exists(conn, "ingest_runs"):
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT run_id, status, window_start_ms, window_end_ms, started_at_ms, finished_at_ms
                FROM ingest_runs
                ORDER BY started_at_ms DESC
                LIMIT 5
                """
            ).fetchall()
            summary["recent_ingest_runs"] = [dict(row) for row in rows]
    finally:
        conn.close()

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
