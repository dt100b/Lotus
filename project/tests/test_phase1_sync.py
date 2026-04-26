from collector.config import Settings
from collector.phase1_sync import Phase1SyncService
from ledger.raw_store import RawStore


class FakeClient:
    def __init__(self, trades, instruments=None):
        self._trades = sorted(trades, key=lambda t: (t["timestamp"], t["trade_seq"]))
        self._instruments = instruments or [
            {"instrument_name": "BTC-30JUN26-100000-C", "kind": "option"},
            {"instrument_name": "BTC-30JUN26-100000-P", "kind": "option"},
        ]

    def get_instruments(self, *, currency="BTC", kind="option", expired=False):
        return [row for row in self._instruments if row.get("kind") == kind]

    def get_last_trades_by_currency_and_time(
        self,
        *,
        currency="BTC",
        kind=None,
        start_timestamp,
        end_timestamp,
        count,
        sorting="asc",
        continuation=None,
        include_old=True,
    ):
        window = [
            trade
            for trade in self._trades
            if start_timestamp <= trade["timestamp"] <= end_timestamp
            and (kind is None or trade.get("kind") == kind)
        ]

        offset = int(continuation) if continuation is not None else 0
        page = window[offset : offset + count]
        next_offset = offset + len(page)
        has_more = next_offset < len(window)

        result = {
            "trades": page,
            "has_more": has_more,
        }
        if has_more:
            result["continuation"] = str(next_offset)
        return result


def test_phase1_paginates_and_resumes(tmp_path):
    trades = [
        {
            "instrument_name": "BTC-30JUN26-100000-C",
            "trade_id": f"t{i}",
            "trade_seq": i,
            "timestamp": 1000 + i,
            "direction": "buy" if i % 2 else "sell",
            "kind": "option",
        }
        for i in range(1, 8)
    ]

    settings = Settings().with_overrides(
        db_path=tmp_path / "phase1.sqlite3",
        page_size=2,
        chunk_size_ms=20,
        resume_enabled=True,
        validation_window_sizes_ms=(3,),
    )

    store = RawStore(settings.db_path)
    store.ensure_schema()

    service = Phase1SyncService(FakeClient(trades), store, settings)
    run_id = store.start_run(1001, 1007)

    store.upsert_backfill_job(
        job_name="btc_options_resume_test",
        window_start_ms=1001,
        window_end_ms=1007,
        status="running",
        last_run_id=run_id,
    )
    store.upsert_backfill_cursor(
        job_name="btc_options_resume_test",
        chunk_start_ms=1001,
        chunk_end_ms=1007,
        trade_kind="option",
        continuation="2",
        status="running",
        page_count=1,
        fetched_rows=2,
    )
    store.insert_trades(trades[:2], source_run_id=run_id)

    backfill = service.backfill_trades(
        start_ms=1001,
        end_ms=1007,
        run_id=run_id,
        job_name="btc_options_resume_test",
    )

    assert backfill["pages_fetched"] >= 3
    assert backfill["trade_rows_inserted"] == 5
    assert store.count_trades() == 7
    assert store.duplicate_trade_count() == 0

    validations = service.validate_sample_windows(1001, 1007)
    assert validations
    assert all(row.missing_count == 0 for row in validations)
    assert all(row.extra_count == 0 for row in validations)

    store.close()
