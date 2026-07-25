from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Iterable


def _now_ms() -> int:
    return int(time.time() * 1000)


def _json_text(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


class RawStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA synchronous=NORMAL;")
        self.conn.execute("PRAGMA foreign_keys=ON;")

    def close(self) -> None:
        self.conn.close()

    def ensure_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ingest_runs (
              run_id TEXT PRIMARY KEY,
              phase_name TEXT NOT NULL,
              started_at_ms INTEGER NOT NULL,
              finished_at_ms INTEGER,
              window_start_ms INTEGER NOT NULL,
              window_end_ms INTEGER NOT NULL,
              status TEXT NOT NULL,
              summary_json TEXT
            );

            CREATE TABLE IF NOT EXISTS backfill_jobs (
              job_name TEXT PRIMARY KEY,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              window_start_ms INTEGER NOT NULL,
              window_end_ms INTEGER NOT NULL,
              status TEXT NOT NULL,
              last_run_id TEXT,
              summary_json TEXT
            );

            CREATE TABLE IF NOT EXISTS backfill_cursors (
              job_name TEXT NOT NULL,
              chunk_start_ms INTEGER NOT NULL,
              chunk_end_ms INTEGER NOT NULL,
              trade_kind TEXT NOT NULL,
              continuation TEXT,
              status TEXT NOT NULL,
              page_count INTEGER NOT NULL DEFAULT 0,
              fetched_rows INTEGER NOT NULL DEFAULT 0,
              updated_at_ms INTEGER NOT NULL,
              PRIMARY KEY (job_name, chunk_start_ms, chunk_end_ms, trade_kind),
              FOREIGN KEY (job_name) REFERENCES backfill_jobs(job_name)
            );

            CREATE TABLE IF NOT EXISTS raw_instruments (
              instrument_name TEXT PRIMARY KEY,
              collected_at_ms INTEGER NOT NULL,
              payload_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS raw_trades (
              instrument_name TEXT NOT NULL,
              trade_id TEXT NOT NULL,
              trade_seq INTEGER,
              timestamp_ms INTEGER NOT NULL,
              direction TEXT,
              block_trade_id TEXT,
              combo_trade_id TEXT,
              source_run_id TEXT NOT NULL,
              ingested_at_ms INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY (instrument_name, trade_id),
              FOREIGN KEY (source_run_id) REFERENCES ingest_runs(run_id)
            );

            CREATE INDEX IF NOT EXISTS idx_raw_trades_timestamp
              ON raw_trades(timestamp_ms);

            CREATE INDEX IF NOT EXISTS idx_raw_trades_instrument_seq
              ON raw_trades(instrument_name, trade_seq);
            """
        )
        self.conn.commit()

    def start_run(self, window_start_ms: int, window_end_ms: int) -> str:
        run_id = str(uuid.uuid4())
        self.conn.execute(
            """
            INSERT INTO ingest_runs (
              run_id,
              phase_name,
              started_at_ms,
              window_start_ms,
              window_end_ms,
              status
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                "phase1_raw",
                _now_ms(),
                window_start_ms,
                window_end_ms,
                "running",
            ),
        )
        self.conn.commit()
        return run_id

    def finish_run(self, run_id: str, status: str, summary: dict[str, Any] | None = None) -> None:
        self.conn.execute(
            """
            UPDATE ingest_runs
            SET finished_at_ms = ?, status = ?, summary_json = ?
            WHERE run_id = ?
            """,
            (_now_ms(), status, json.dumps(summary or {}), run_id),
        )
        self.conn.commit()

    def upsert_backfill_job(
        self,
        job_name: str,
        window_start_ms: int,
        window_end_ms: int,
        status: str,
        last_run_id: str | None = None,
        summary: dict[str, Any] | None = None,
    ) -> None:
        now = _now_ms()
        self.conn.execute(
            """
            INSERT INTO backfill_jobs (
              job_name, created_at_ms, updated_at_ms, window_start_ms, window_end_ms, status, last_run_id, summary_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_name) DO UPDATE SET
              updated_at_ms = excluded.updated_at_ms,
              window_start_ms = excluded.window_start_ms,
              window_end_ms = excluded.window_end_ms,
              status = excluded.status,
              last_run_id = excluded.last_run_id,
              summary_json = excluded.summary_json
            """,
            (
                job_name,
                now,
                now,
                window_start_ms,
                window_end_ms,
                status,
                last_run_id,
                json.dumps(summary or {}),
            ),
        )
        self.conn.commit()

    def get_backfill_cursor(
        self,
        job_name: str,
        chunk_start_ms: int,
        chunk_end_ms: int,
        trade_kind: str,
    ) -> sqlite3.Row | None:
        return self.conn.execute(
            """
            SELECT *
            FROM backfill_cursors
            WHERE job_name = ? AND chunk_start_ms = ? AND chunk_end_ms = ? AND trade_kind = ?
            """,
            (job_name, chunk_start_ms, chunk_end_ms, trade_kind),
        ).fetchone()

    def upsert_backfill_cursor(
        self,
        job_name: str,
        chunk_start_ms: int,
        chunk_end_ms: int,
        trade_kind: str,
        continuation: str | None,
        status: str,
        page_count: int,
        fetched_rows: int,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO backfill_cursors (
              job_name, chunk_start_ms, chunk_end_ms, trade_kind, continuation, status, page_count, fetched_rows, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_name, chunk_start_ms, chunk_end_ms, trade_kind) DO UPDATE SET
              continuation = excluded.continuation,
              status = excluded.status,
              page_count = excluded.page_count,
              fetched_rows = excluded.fetched_rows,
              updated_at_ms = excluded.updated_at_ms
            """,
            (
                job_name,
                chunk_start_ms,
                chunk_end_ms,
                trade_kind,
                continuation,
                status,
                page_count,
                fetched_rows,
                _now_ms(),
            ),
        )
        self.conn.commit()

    def reset_empty_completed_cursors(self, job_name: str) -> int:
        """
        Delete completed cursors that fetched zero rows so they can be re-run.

        Needed when a prior backfill against the main Deribit host marked older
        chunks complete with empty pages (public ~24h retention). Re-running
        against history.deribit.com must re-open those chunks.
        """
        cursor = self.conn.execute(
            """
            DELETE FROM backfill_cursors
            WHERE job_name = ?
              AND status = 'completed'
              AND fetched_rows = 0
            """,
            (job_name,),
        )
        self.conn.commit()
        return int(cursor.rowcount)

    def upsert_instruments(self, instruments: Iterable[dict[str, Any]]) -> int:
        rows = [
            (
                str(item["instrument_name"]),
                _now_ms(),
                _json_text(item),
            )
            for item in instruments
            if "instrument_name" in item
        ]

        before = self.conn.total_changes
        self.conn.executemany(
            """
            INSERT INTO raw_instruments (
              instrument_name,
              collected_at_ms,
              payload_json
            ) VALUES (?, ?, ?)
            ON CONFLICT(instrument_name) DO UPDATE SET
              collected_at_ms = excluded.collected_at_ms,
              payload_json = excluded.payload_json
            """,
            rows,
        )
        self.conn.commit()
        return self.conn.total_changes - before

    def insert_trades(self, trades: Iterable[dict[str, Any]], source_run_id: str) -> int:
        ingested_at_ms = _now_ms()
        rows = []

        for trade in trades:
            if "instrument_name" not in trade or "trade_id" not in trade or "timestamp" not in trade:
                continue

            rows.append(
                (
                    str(trade["instrument_name"]),
                    str(trade["trade_id"]),
                    int(trade["trade_seq"]) if trade.get("trade_seq") is not None else None,
                    int(trade["timestamp"]),
                    str(trade["direction"]) if trade.get("direction") is not None else None,
                    str(trade["block_trade_id"]) if trade.get("block_trade_id") is not None else None,
                    str(trade["combo_trade_id"]) if trade.get("combo_trade_id") is not None else None,
                    source_run_id,
                    ingested_at_ms,
                    _json_text(trade),
                )
            )

        before = self.conn.total_changes
        self.conn.executemany(
            """
            INSERT OR IGNORE INTO raw_trades (
              instrument_name,
              trade_id,
              trade_seq,
              timestamp_ms,
              direction,
              block_trade_id,
              combo_trade_id,
              source_run_id,
              ingested_at_ms,
              payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        self.conn.commit()
        return self.conn.total_changes - before

    def count_instruments(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) AS n FROM raw_instruments").fetchone()
        return int(row["n"])

    def count_trades(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) AS n FROM raw_trades").fetchone()
        return int(row["n"])

    def duplicate_trade_count(self) -> int:
        row = self.conn.execute(
            """
            SELECT COUNT(*) AS n
            FROM (
              SELECT instrument_name, trade_id, COUNT(*) AS c
              FROM raw_trades
              GROUP BY instrument_name, trade_id
              HAVING COUNT(*) > 1
            )
            """
        ).fetchone()
        return int(row["n"])

    def get_trade_keys_in_window(self, start_ms: int, end_ms: int) -> set[tuple[str, str]]:
        rows = self.conn.execute(
            """
            SELECT instrument_name, trade_id
            FROM raw_trades
            WHERE timestamp_ms >= ? AND timestamp_ms <= ?
            """,
            (start_ms, end_ms),
        ).fetchall()
        return {(str(row["instrument_name"]), str(row["trade_id"])) for row in rows}
