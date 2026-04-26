from __future__ import annotations

import argparse
import logging
from pathlib import Path
import sys
import time

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from collector.deribit_client import DeribitClient
from collector.trades_backfill import collect_all_btc_option_trades

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Deribit BTC option Phase 1 smoke backfill.")
    parser.add_argument("--minutes", type=int, default=30, help="Recent lookback window in minutes")
    parser.add_argument("--page-size", type=int, default=200, help="Deribit page size (max 1000)")
    parser.add_argument("--max-pages", type=int, default=5, help="Maximum pages to fetch")
    args = parser.parse_args()

    now_ms = int(time.time() * 1000)
    start_ms = now_ms - (args.minutes * 60 * 1000)

    with DeribitClient() as client:
        instruments = client.get_instruments(currency="BTC", kind="option", expired=False)
        baseline = client.get_last_trades_by_currency(
            currency="BTC",
            kind="option",
            count=50,
            sorting="desc",
        )
        baseline_trades = baseline["trades"]
        baseline_has_more = bool(baseline["has_more"])
        print(
            "Diagnostic #1 (no time window):",
            f"trades={len(baseline_trades)}",
            f"has_more={baseline_has_more}",
        )

        if baseline_trades:
            ts_values = [int(trade["timestamp"]) for trade in baseline_trades if "timestamp" in trade]
            sample_instruments = []
            seen_instruments: set[str] = set()
            for trade in baseline_trades:
                name = str(trade.get("instrument_name", ""))
                if name and name not in seen_instruments:
                    sample_instruments.append(name)
                    seen_instruments.add(name)
                if len(sample_instruments) >= 5:
                    break
            print(
                "Diagnostic #1 details:",
                f"min_ts={min(ts_values) if ts_values else None}",
                f"max_ts={max(ts_values) if ts_values else None}",
                f"first_trade_id={baseline_trades[0].get('trade_id')}",
                f"last_trade_id={baseline_trades[-1].get('trade_id')}",
                f"sample_instruments={sample_instruments}",
            )
        else:
            print("Diagnostic #1 details: no trades returned without timestamps.")
            any_kind = client.get_last_trades_by_currency(
                currency="BTC",
                kind="any",
                count=50,
                sorting="desc",
            )
            historical_option = client.get_last_trades_by_currency(
                currency="BTC",
                kind="option",
                count=50,
                sorting="desc",
                historical=True,
                include_old=True,
            )
            print(
                "Diagnostic #1b (fallback checks):",
                f"kind_any_trades={len(any_kind['trades'])}",
                f"kind_any_has_more={bool(any_kind['has_more'])}",
                f"historical_option_trades={len(historical_option['trades'])}",
                f"historical_option_has_more={bool(historical_option['has_more'])}",
            )

        trades, cursor = collect_all_btc_option_trades(
            client,
            start_timestamp=start_ms,
            end_timestamp=now_ms,
            page_size=args.page_size,
            sorting="asc",
            max_pages=args.max_pages,
            debug=True,
        )

    required_trade_fields = {"trade_id", "trade_seq", "instrument_name", "timestamp", "direction", "amount", "price"}
    missing_any = 0
    for trade in trades:
        missing = required_trade_fields - set(trade.keys())
        if missing:
            missing_any += 1

    print(
        "Backfill smoke summary:",
        f"instruments={len(instruments)}",
        f"window_start_ms={start_ms}",
        f"window_end_ms={now_ms}",
        f"trades={len(trades)}",
        f"trades_with_missing_required_fields={missing_any}",
        f"last_trade_id={cursor.last_trade_id}",
    )


if __name__ == "__main__":
    main()
