from collector.config import Settings
from collector.phase1_sync import Phase1SyncService
from ledger.raw_store import RawStore


class FakeClient:
    def __init__(self, trades, instruments=None, *, base_url="https://www.deribit.com/api/v2"):
        self.base_url = base_url
        self._trades = sorted(trades, key=lambda t: (t["timestamp"], t["trade_seq"]))
        self._instruments = instruments or [
            {"instrument_name": "BTC-30JUN26-100000-C", "kind": "option"},
            {"instrument_name": "BTC-30JUN26-100000-P", "kind": "option"},
        ]
        self.trade_calls: list[dict] = []
        self.instrument_calls = 0

    def get_instruments(self, *, currency="BTC", kind="option", expired=False):
        self.instrument_calls += 1
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
        self.trade_calls.append(
            {
                "start_timestamp": start_timestamp,
                "end_timestamp": end_timestamp,
                "count": count,
                "continuation": continuation,
            }
        )
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


class FakeHistoryClient:
    """Simulates history.deribit.com: has_more without continuation."""

    def __init__(
        self,
        trades,
        *,
        base_url="https://history.deribit.com/api/v2",
        instruments=None,
    ):
        self.base_url = base_url
        self._trades = sorted(trades, key=lambda t: (t["timestamp"], t["trade_seq"]))
        self._instruments = instruments or []
        self.trade_calls: list[dict] = []
        self.instrument_calls = 0

    def get_instruments(self, *, currency="BTC", kind="option", expired=False):
        self.instrument_calls += 1
        return [
            row
            for row in self._instruments
            if row.get("kind") == kind and bool(row.get("is_expired", False)) == expired
        ]

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
        assert continuation is None, "history host should not receive native continuation"
        self.trade_calls.append(
            {
                "start_timestamp": start_timestamp,
                "end_timestamp": end_timestamp,
                "count": count,
            }
        )
        window = [
            trade
            for trade in self._trades
            if start_timestamp <= trade["timestamp"] <= end_timestamp
            and (kind is None or trade.get("kind") == kind)
        ]
        page = window[:count]
        has_more = len(window) > count
        return {"trades": page, "has_more": has_more}


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


def test_phase1_routes_trades_to_history_client(tmp_path):
    trades = [
        {
            "instrument_name": "BTC-30JUN26-100000-C",
            "trade_id": f"t{i}",
            "trade_seq": i,
            "timestamp": 1000 + i,
            "direction": "buy",
            "kind": "option",
        }
        for i in range(1, 6)
    ]
    live = FakeClient([], base_url="https://www.deribit.com/api/v2")
    history = FakeHistoryClient(trades)

    settings = Settings().with_overrides(
        db_path=tmp_path / "phase1.sqlite3",
        page_size=2,
        history_page_size=2,
        chunk_size_ms=100,
        resume_enabled=True,
    )
    store = RawStore(settings.db_path)
    store.ensure_schema()
    service = Phase1SyncService(live, store, settings, history_client=history)
    run_id = store.start_run(1001, 1005)

    summary = service.backfill_trades(1001, 1005, run_id, "history_route_test")

    assert summary["trade_host"] == "https://history.deribit.com/api/v2"
    assert summary["trade_page_size"] == 2
    assert summary["trade_rows_inserted"] == 5
    assert store.count_trades() == 5
    assert live.trade_calls == []
    assert history.trade_calls  # all trade pages hit history
    # Instruments hit live and history when history_client is present
    service.sync_instruments()
    assert live.instrument_calls == 2  # expired True/False for option
    assert history.instrument_calls == 2
    store.close()


def test_sync_instruments_merges_history_expired_catalog(tmp_path):
    live = FakeClient(
        [],
        instruments=[{"instrument_name": "BTC-30JUN26-100000-C", "kind": "option"}],
    )
    history = FakeHistoryClient(
        [],
        instruments=[
            {
                "instrument_name": "BTC-1JAN26-87000-P",
                "kind": "option",
                "is_expired": True,
            },
            {
                "instrument_name": "BTC-30JUN26-100000-C",
                "kind": "option",
                "is_expired": False,
            },
        ],
    )
    settings = Settings().with_overrides(db_path=tmp_path / "phase1.sqlite3")
    store = RawStore(settings.db_path)
    store.ensure_schema()
    service = Phase1SyncService(live, store, settings, history_client=history)

    upserted = service.sync_instruments()
    assert upserted == 2
    assert store.count_instruments() == 2
    store.close()


def test_phase1_timestamp_advance_pagination_without_continuation(tmp_path):
    trades = [
        {
            "instrument_name": "BTC-30JUN26-100000-C",
            "trade_id": f"t{i}",
            "trade_seq": i,
            "timestamp": 1000 + i * 10,
            "direction": "buy",
            "kind": "option",
        }
        for i in range(1, 8)
    ]
    history = FakeHistoryClient(trades)
    live = FakeClient([])

    settings = Settings().with_overrides(
        db_path=tmp_path / "phase1.sqlite3",
        history_page_size=3,
        chunk_size_ms=10_000,
        resume_enabled=True,
    )
    store = RawStore(settings.db_path)
    store.ensure_schema()
    service = Phase1SyncService(live, store, settings, history_client=history)
    run_id = store.start_run(1010, 1070)

    summary = service.backfill_trades(1010, 1070, run_id, "ts_advance_test")

    assert summary["trade_rows_inserted"] == 7
    assert store.count_trades() == 7
    assert summary["pages_fetched"] >= 3
    # Subsequent pages should advance start_timestamp via synthetic ts: tokens
    starts = [call["start_timestamp"] for call in history.trade_calls]
    assert starts[0] == 1010
    assert starts == sorted(starts)
    assert len(set(starts)) == len(starts)  # strictly advancing pages
    store.close()
