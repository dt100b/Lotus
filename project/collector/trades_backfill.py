from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import Any

from collector.deribit_client import DeribitClient

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class BackfillCursor:
    start_id: str | None = None
    last_trade_id: str | None = None
    last_timestamp: int | None = None


@dataclass(frozen=True)
class BackfillResult:
    raw_trades: list[dict[str, Any]]
    has_more: bool
    next_cursor: BackfillCursor

    @property
    def derived_option_trades(self) -> list[dict[str, Any]]:
        # Keep combos/block trades in raw ingestion; derived stream remains options-only.
        return [
            trade
            for trade in self.raw_trades
            if trade.get("combo_id") is None and trade.get("block_trade_id") is None
        ]


def backfill_btc_option_trades(
    client: DeribitClient,
    *,
    start_timestamp: int | None = None,
    end_timestamp: int | None = None,
    cursor: BackfillCursor | None = None,
    page_size: int = 1000,
    sorting: str = "asc",
    debug: bool = False,
    page_index: int = 0,
) -> BackfillResult:
    active_cursor = cursor or BackfillCursor()
    request_params = {
        "currency": "BTC",
        "kind": "option",
        "start_timestamp": start_timestamp,
        "end_timestamp": end_timestamp,
        "start_id": active_cursor.start_id,
        "count": page_size,
        "sorting": sorting,
    }
    if debug:
        logger.info("[backfill] page=%s request=%s", page_index, request_params)

    page = client.get_last_trades_by_currency(
        currency="BTC",
        kind="option",
        start_timestamp=start_timestamp,
        end_timestamp=end_timestamp,
        start_id=active_cursor.start_id,
        count=page_size,
        sorting=sorting,
    )
    page_trades = page["trades"]
    page_has_more = bool(page["has_more"])
    if debug:
        _log_trade_page_summary(page_trades, page_has_more, page_index)

    next_cursor = active_cursor
    if page_trades:
        last_trade = page_trades[-1]
        last_trade_id = str(last_trade["trade_id"])
        next_cursor = BackfillCursor(
            start_id=last_trade_id,
            last_trade_id=last_trade_id,
            last_timestamp=int(last_trade["timestamp"]),
        )

    return BackfillResult(
        raw_trades=page_trades,
        has_more=page_has_more,
        next_cursor=next_cursor,
    )


def collect_all_btc_option_trades(
    client: DeribitClient,
    *,
    start_timestamp: int | None = None,
    end_timestamp: int | None = None,
    start_cursor: BackfillCursor | None = None,
    page_size: int = 1000,
    sorting: str = "asc",
    max_pages: int = 10_000,
    debug: bool = False,
) -> tuple[list[dict[str, Any]], BackfillCursor]:
    all_trades: list[dict[str, Any]] = []
    cursor = start_cursor or BackfillCursor()
    pages = 0
    seen_trade_keys: set[tuple[str, str]] = set()

    while pages < max_pages:
        prior_start_id = cursor.start_id
        result = backfill_btc_option_trades(
            client,
            start_timestamp=start_timestamp,
            end_timestamp=end_timestamp,
            cursor=cursor,
            page_size=page_size,
            sorting=sorting,
            debug=debug,
            page_index=pages,
        )
        duplicate_count = 0
        duplicate_examples: list[tuple[str, str]] = []
        for trade in result.raw_trades:
            key = (str(trade.get("instrument_name", "")), str(trade.get("trade_id", "")))
            if key in seen_trade_keys:
                duplicate_count += 1
                if len(duplicate_examples) < 3:
                    duplicate_examples.append(key)
            seen_trade_keys.add(key)

        if debug and duplicate_count:
            logger.warning(
                "[backfill] page=%s duplicate_trades=%s examples=%s",
                pages,
                duplicate_count,
                duplicate_examples,
            )

        all_trades.extend(result.raw_trades)
        cursor = result.next_cursor
        pages += 1
        if debug and result.has_more and prior_start_id == cursor.start_id and result.raw_trades:
            logger.warning(
                "[backfill] cursor did not advance (start_id=%s); stopping to avoid loop",
                cursor.start_id,
            )
            break
        if not result.has_more or not result.raw_trades:
            break
    else:
        raise RuntimeError("Backfill stopped due to max_pages safety limit")

    return all_trades, cursor


def _log_trade_page_summary(
    trades: list[dict[str, Any]],
    has_more: bool,
    page_index: int,
) -> None:
    if not trades:
        logger.info(
            "[backfill] page=%s response_trade_count=0 has_more=%s",
            page_index,
            has_more,
        )
        return

    timestamps = [int(trade["timestamp"]) for trade in trades if "timestamp" in trade]
    trade_ids = [str(trade["trade_id"]) for trade in trades if "trade_id" in trade]
    instruments: list[str] = []
    seen: set[str] = set()
    for trade in trades:
        name = str(trade.get("instrument_name", ""))
        if name and name not in seen:
            instruments.append(name)
            seen.add(name)
        if len(instruments) >= 5:
            break

    min_ts = min(timestamps) if timestamps else None
    max_ts = max(timestamps) if timestamps else None
    first_trade_id = trade_ids[0] if trade_ids else None
    last_trade_id = trade_ids[-1] if trade_ids else None
    logger.info(
        "[backfill] page=%s response_trade_count=%s has_more=%s min_ts=%s max_ts=%s first_trade_id=%s last_trade_id=%s sample_instruments=%s",
        page_index,
        len(trades),
        has_more,
        min_ts,
        max_ts,
        first_trade_id,
        last_trade_id,
        instruments,
    )
