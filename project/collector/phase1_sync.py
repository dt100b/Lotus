from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from collector.config import Settings
from collector.deribit_client import DeribitPublicClient
from ledger.raw_store import RawStore


def parse_iso_to_ms(value: str) -> int:
    normalized = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


@dataclass(frozen=True)
class ValidationRow:
    window_start_ms: int
    window_end_ms: int
    local_count: int
    remote_count: int
    missing_count: int
    extra_count: int


class Phase1SyncService:
    INSTRUMENT_KINDS: tuple[str, ...] = ("option",)
    RAW_TRADE_KINDS: tuple[str, ...] = ("option",)

    def __init__(
        self,
        client: DeribitPublicClient,
        store: RawStore,
        settings: Settings,
    ) -> None:
        self.client = client
        self.store = store
        self.settings = settings

    def sync_instruments(self) -> int:
        merged: dict[str, dict[str, Any]] = {}

        for kind in self.INSTRUMENT_KINDS:
            for expired in (False, True):
                instruments = self.client.get_instruments(
                    currency="BTC",
                    kind=kind,
                    expired=expired,
                )
                for item in instruments:
                    instrument_name = item.get("instrument_name")
                    if instrument_name:
                        merged[str(instrument_name)] = item

        return self.store.upsert_instruments(merged.values())

    def backfill_trades(
        self,
        start_ms: int,
        end_ms: int,
        run_id: str,
        job_name: str,
    ) -> dict[str, Any]:
        summary = {
            "job_name": job_name,
            "chunks_total": 0,
            "chunks_completed": 0,
            "pages_fetched": 0,
            "trade_rows_inserted": 0,
        }

        self.store.upsert_backfill_job(
            job_name=job_name,
            window_start_ms=start_ms,
            window_end_ms=end_ms,
            status="running",
            last_run_id=run_id,
        )

        for chunk_start_ms, chunk_end_ms in self._iter_chunks(start_ms, end_ms):
            summary["chunks_total"] += 1

            for trade_kind in self.RAW_TRADE_KINDS:
                cursor = self.store.get_backfill_cursor(
                    job_name,
                    chunk_start_ms,
                    chunk_end_ms,
                    trade_kind,
                )

                if (
                    self.settings.resume_enabled
                    and cursor is not None
                    and str(cursor["status"]) == "completed"
                ):
                    continue

                continuation = None if cursor is None else cursor["continuation"]
                page_count = 0 if cursor is None else int(cursor["page_count"])
                fetched_rows = 0 if cursor is None else int(cursor["fetched_rows"])

                while True:
                    result = self.client.get_last_trades_by_currency_and_time(
                        currency="BTC",
                        kind=trade_kind,
                        start_timestamp=chunk_start_ms,
                        end_timestamp=chunk_end_ms,
                        count=self.settings.page_size,
                        sorting="asc",
                        continuation=continuation,
                        include_old=True,
                    )

                    trades = result.get("trades", [])
                    inserted = self.store.insert_trades(trades, source_run_id=run_id)

                    page_count += 1
                    fetched_rows += len(trades)
                    summary["pages_fetched"] += 1
                    summary["trade_rows_inserted"] += inserted

                    next_continuation = result.get("continuation")
                    has_more = bool(result.get("has_more", False))

                    if has_more and not next_continuation:
                        raise RuntimeError(
                            f"Deribit returned has_more=True without continuation "
                            f"for chunk=[{chunk_start_ms},{chunk_end_ms}] kind={trade_kind}"
                        )

                    if has_more:
                        self.store.upsert_backfill_cursor(
                            job_name=job_name,
                            chunk_start_ms=chunk_start_ms,
                            chunk_end_ms=chunk_end_ms,
                            trade_kind=trade_kind,
                            continuation=str(next_continuation),
                            status="running",
                            page_count=page_count,
                            fetched_rows=fetched_rows,
                        )
                        continuation = str(next_continuation)
                        continue

                    self.store.upsert_backfill_cursor(
                        job_name=job_name,
                        chunk_start_ms=chunk_start_ms,
                        chunk_end_ms=chunk_end_ms,
                        trade_kind=trade_kind,
                        continuation=None,
                        status="completed",
                        page_count=page_count,
                        fetched_rows=fetched_rows,
                    )
                    summary["chunks_completed"] += 1
                    break

        self.store.upsert_backfill_job(
            job_name=job_name,
            window_start_ms=start_ms,
            window_end_ms=end_ms,
            status="completed",
            last_run_id=run_id,
            summary=summary,
        )
        return summary

    def validate_sample_windows(self, start_ms: int, end_ms: int) -> list[ValidationRow]:
        if end_ms <= start_ms:
            return []

        span = end_ms - start_ms
        rows: list[ValidationRow] = []

        for width_ms in self.settings.validation_window_sizes_ms:
            if width_ms > span:
                continue

            anchors = [
                start_ms,
                start_ms + ((span - width_ms) // 2),
                end_ms - width_ms,
            ]

            seen: set[tuple[int, int]] = set()
            for anchor in anchors:
                window_start = int(anchor)
                window_end = int(anchor + width_ms)

                key = (window_start, window_end)
                if key in seen:
                    continue
                seen.add(key)

                remote_keys = self._collect_trade_keys(window_start, window_end)
                local_keys = self.store.get_trade_keys_in_window(window_start, window_end)

                rows.append(
                    ValidationRow(
                        window_start_ms=window_start,
                        window_end_ms=window_end,
                        local_count=len(local_keys),
                        remote_count=len(remote_keys),
                        missing_count=len(remote_keys - local_keys),
                        extra_count=len(local_keys - remote_keys),
                    )
                )

        return rows

    def _collect_trade_keys(self, start_ms: int, end_ms: int) -> set[tuple[str, str]]:
        keys: set[tuple[str, str]] = set()

        for trade_kind in self.RAW_TRADE_KINDS:
            continuation: str | None = None

            while True:
                result = self.client.get_last_trades_by_currency_and_time(
                    currency="BTC",
                    kind=trade_kind,
                    start_timestamp=start_ms,
                    end_timestamp=end_ms,
                    count=self.settings.page_size,
                    sorting="asc",
                    continuation=continuation,
                    include_old=True,
                )

                trades = result.get("trades", [])
                keys |= {
                    (str(trade["instrument_name"]), str(trade["trade_id"]))
                    for trade in trades
                    if "instrument_name" in trade and "trade_id" in trade
                }

                if not bool(result.get("has_more", False)):
                    break

                next_continuation = result.get("continuation")
                if not next_continuation:
                    raise RuntimeError(
                        f"Deribit returned has_more=True without continuation "
                        f"for validation window=[{start_ms},{end_ms}] kind={trade_kind}"
                    )
                continuation = str(next_continuation)

        return keys

    def _iter_chunks(self, start_ms: int, end_ms: int):
        chunk_size = self.settings.chunk_size_ms
        current = start_ms

        while current < end_ms:
            chunk_end = min(current + chunk_size - 1, end_ms)
            yield current, chunk_end
            current = chunk_end + 1
