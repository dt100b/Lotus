from ledger.raw_store import RawStore


def test_raw_store_deduplicates_on_instrument_and_trade_id(tmp_path):
    store = RawStore(tmp_path / "phase1.sqlite3")
    store.ensure_schema()
    run_id = store.start_run(0, 10)

    trade = {
        "instrument_name": "BTC-30JUN26-100000-C",
        "trade_id": "trade-1",
        "trade_seq": 101,
        "timestamp": 1_700_000_000_000,
        "direction": "buy",
    }

    first = store.insert_trades([trade], source_run_id=run_id)
    second = store.insert_trades([trade], source_run_id=run_id)

    assert first == 1
    assert second == 0
    assert store.count_trades() == 1
    assert store.duplicate_trade_count() == 0

    store.close()


def test_backfill_cursor_persists_resume_state(tmp_path):
    store = RawStore(tmp_path / "phase1.sqlite3")
    store.ensure_schema()

    store.upsert_backfill_job(
        job_name="btc_options_test",
        window_start_ms=1000,
        window_end_ms=5000,
        status="running",
        last_run_id="run-1",
    )

    store.upsert_backfill_cursor(
        job_name="btc_options_test",
        chunk_start_ms=1000,
        chunk_end_ms=1999,
        trade_kind="option",
        continuation="token-2",
        status="running",
        page_count=2,
        fetched_rows=2000,
    )

    row = store.get_backfill_cursor(
        job_name="btc_options_test",
        chunk_start_ms=1000,
        chunk_end_ms=1999,
        trade_kind="option",
    )

    assert row is not None
    assert row["continuation"] == "token-2"
    assert row["status"] == "running"
    assert row["page_count"] == 2
    assert row["fetched_rows"] == 2000

    store.close()


def test_reset_empty_completed_cursors(tmp_path):
    store = RawStore(tmp_path / "phase1.sqlite3")
    store.ensure_schema()

    store.upsert_backfill_job(
        job_name="btc_options_test",
        window_start_ms=1000,
        window_end_ms=5000,
        status="completed",
    )
    store.upsert_backfill_cursor(
        job_name="btc_options_test",
        chunk_start_ms=1000,
        chunk_end_ms=1999,
        trade_kind="option",
        continuation=None,
        status="completed",
        page_count=1,
        fetched_rows=0,
    )
    store.upsert_backfill_cursor(
        job_name="btc_options_test",
        chunk_start_ms=2000,
        chunk_end_ms=2999,
        trade_kind="option",
        continuation=None,
        status="completed",
        page_count=3,
        fetched_rows=150,
    )

    removed = store.reset_empty_completed_cursors("btc_options_test")
    assert removed == 1
    assert store.get_backfill_cursor("btc_options_test", 1000, 1999, "option") is None
    kept = store.get_backfill_cursor("btc_options_test", 2000, 2999, "option")
    assert kept is not None
    assert kept["fetched_rows"] == 150

    store.close()
