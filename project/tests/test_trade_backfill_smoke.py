from __future__ import annotations

import os
import time

import pytest

from collector.deribit_client import DeribitClient
from collector.trades_backfill import collect_all_btc_option_trades


def _run_live_smoke_enabled() -> bool:
    return os.getenv("RUN_DERIBIT_SMOKE", "0").strip() == "1"


@pytest.mark.skipif(not _run_live_smoke_enabled(), reason="Set RUN_DERIBIT_SMOKE=1 to run live Deribit smoke")
def test_trade_backfill_smoke_live() -> None:
    now_ms = int(time.time() * 1000)
    start_ms = now_ms - (30 * 60 * 1000)

    with DeribitClient() as client:
        instruments = client.get_instruments(currency="BTC", kind="option", expired=False)
        trades, cursor = collect_all_btc_option_trades(
            client,
            start_timestamp=start_ms,
            end_timestamp=now_ms,
            page_size=200,
            sorting="asc",
            max_pages=5,
        )

    assert instruments, "Expected at least one BTC option instrument"
    assert trades, "Expected at least one BTC option trade in the recent window"

    required_trade_fields = {
        "trade_id",
        "trade_seq",
        "instrument_name",
        "timestamp",
        "direction",
        "amount",
        "contracts",
        "price",
        "mark_price",
        "iv",
        "index_price",
    }
    for trade in trades[:20]:
        missing = required_trade_fields - set(trade.keys())
        assert not missing, f"Trade missing required fields: {sorted(missing)}"

    print(
        f"Smoke summary: instruments={len(instruments)} trades={len(trades)} "
        f"last_trade_id={cursor.last_trade_id}"
    )
