from __future__ import annotations

import json
import sqlite3
from decimal import Decimal
from pathlib import Path

from ledger.models import NormalizedTradeEvent
from ledger.replay import LedgerReplayer
from ledger.rules import LedgerPolicy
from pipeline.dashboard_snapshot import materialize_dashboard_snapshot
from pipeline.inventory_checkpoint import (
    filter_events_after_cursors,
    load_checkpoint,
    load_positions_from_inventory_csv,
    measure_checkpoint_inventory_lag,
    merge_instrument_cursors,
    positions_sha256,
)


def _event(**overrides: object) -> NormalizedTradeEvent:
    payload = {
        "event_id": "evt-1",
        "source_trade_id": "raw-1",
        "trade_seq": 1,
        "ts_ms": 1_700_000_000_000,
        "venue": "deribit",
        "base_currency": "BTC",
        "kind": "option",
        "instrument_name": "BTC-31DEC26-90000-C",
        "option_type": "call",
        "strike": "90000",
        "expiry_ts_ms": 1_798_675_200_000,
        "contract_size": "1",
        "amount": "1",
        "price": "0.05",
        "taker_side": "buy",
        "is_block_trade": False,
        "is_combo_trade": False,
        "is_single_leg": True,
        "normalization_version": "phase2.v1",
    }
    payload.update(overrides)
    return NormalizedTradeEvent.from_dict(payload)


def test_incremental_replay_matches_full_positions() -> None:
    first = [
        _event(event_id="a1", source_trade_id="a1", trade_seq=1, amount="2", taker_side="buy"),
        _event(event_id="a2", source_trade_id="a2", trade_seq=2, amount="1", taker_side="sell"),
    ]
    second = [
        _event(
            event_id="b1",
            source_trade_id="b1",
            trade_seq=3,
            amount="4",
            taker_side="sell",
            instrument_name="BTC-31DEC26-95000-P",
            option_type="put",
            strike="95000",
        ),
        _event(event_id="a3", source_trade_id="a3", trade_seq=3, amount="1", taker_side="buy"),
    ]

    policy = LedgerPolicy(snapshot_every=100, methodology_version="phase3.test")
    full = LedgerReplayer(policy).replay(first + second, retain_deltas=False)
    partial = LedgerReplayer(policy).replay(first, retain_deltas=False)
    incremental = LedgerReplayer(policy).replay(
        second,
        retain_deltas=False,
        initial_positions=dict(partial.snapshots[-1].positions),
        prior_input_event_count=partial.manifest["input_event_count"],
        prior_applied_event_count=partial.manifest["applied_event_count"],
        prior_excluded_event_count=partial.manifest["excluded_event_count"],
        prior_final_trade_seq=partial.snapshots[-1].last_trade_seq,
        prior_final_ts_ms=partial.snapshots[-1].ts_ms,
    )

    assert incremental.snapshots[-1].positions == full.snapshots[-1].positions
    assert incremental.manifest["input_event_count"] == full.manifest["input_event_count"]
    assert incremental.manifest["applied_event_count"] == full.manifest["applied_event_count"]
    assert incremental.manifest["incremental"] is True


def test_cursor_filter_drops_already_applied_seqs() -> None:
    events = [
        {"instrument_name": "BTC-A", "trade_seq": 1},
        {"instrument_name": "BTC-A", "trade_seq": 2},
        {"instrument_name": "BTC-B", "trade_seq": 5},
    ]
    cursors = {"BTC-A": 1}
    kept = filter_events_after_cursors(events, cursors)
    assert kept == [
        {"instrument_name": "BTC-A", "trade_seq": 2},
        {"instrument_name": "BTC-B", "trade_seq": 5},
    ]
    merged = merge_instrument_cursors(cursors, kept)
    assert merged == {"BTC-A": 2, "BTC-B": 5}


def _seed_phase1_db(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE raw_instruments (
          instrument_name TEXT PRIMARY KEY,
          collected_at_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE raw_trades (
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
          PRIMARY KEY (instrument_name, trade_id)
        );
        """
    )

    instruments = [
        {
            "instrument_name": "BTC-31DEC26-90000-C",
            "kind": "option",
            "option_type": "call",
            "strike": 90000,
            "base_currency": "BTC",
            "contract_size": 1,
            "tick_size": 0.0001,
            "is_active": True,
        },
        {
            "instrument_name": "BTC-31DEC26-95000-P",
            "kind": "option",
            "option_type": "put",
            "strike": 95000,
            "base_currency": "BTC",
            "contract_size": 1,
            "tick_size": 0.0001,
            "is_active": True,
        },
    ]
    for inst in instruments:
        conn.execute(
            "INSERT INTO raw_instruments VALUES (?, ?, ?)",
            (inst["instrument_name"], 1, json.dumps(inst)),
        )

    trades = [
        {
            "trade_id": "t1",
            "trade_seq": 1,
            "timestamp": 1_700_000_000_000,
            "instrument_name": "BTC-31DEC26-90000-C",
            "direction": "buy",
            "amount": 2,
            "price": 0.05,
        },
        {
            "trade_id": "t2",
            "trade_seq": 2,
            "timestamp": 1_700_000_000_100,
            "instrument_name": "BTC-31DEC26-90000-C",
            "direction": "sell",
            "amount": 1,
            "price": 0.04,
        },
        {
            "trade_id": "t3",
            "trade_seq": 1,
            "timestamp": 1_700_000_000_200,
            "instrument_name": "BTC-31DEC26-95000-P",
            "direction": "sell",
            "amount": 3,
            "price": 0.03,
        },
    ]
    for trade in trades:
        conn.execute(
            """
            INSERT INTO raw_trades (
              instrument_name, trade_id, trade_seq, timestamp_ms, direction,
              block_trade_id, combo_trade_id, source_run_id, ingested_at_ms, payload_json
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'run', 1, ?)
            """,
            (
                trade["instrument_name"],
                trade["trade_id"],
                trade["trade_seq"],
                trade["timestamp"],
                trade["direction"],
                json.dumps(trade),
            ),
        )
    conn.commit()
    conn.close()


def _greeks_fixture(path: Path) -> None:
    payload = [
        {
            "instrument_name": "BTC-31DEC26-90000-C",
            "gamma": 0.0001,
            "spot_price": 90000.0,
            "snapshot_ts": 1_700_000_100_000,
            "open_interest": 10.0,
            "mark_iv": 0.5,
        },
        {
            "instrument_name": "BTC-31DEC26-95000-P",
            "gamma": 0.0002,
            "spot_price": 90000.0,
            "snapshot_ts": 1_700_000_100_000,
            "open_interest": 8.0,
            "mark_iv": 0.6,
        },
    ]
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_materialize_auto_incremental_matches_full(tmp_path: Path) -> None:
    db_path = tmp_path / "phase1.sqlite3"
    artifacts = tmp_path / "artifacts"
    snapshot = tmp_path / "latest.json"
    greeks = tmp_path / "greeks.json"
    _seed_phase1_db(db_path)
    _greeks_fixture(greeks)

    full = materialize_dashboard_snapshot(
        db_path=db_path,
        artifacts_dir=artifacts,
        snapshot_path=snapshot,
        greeks_json=greeks,
        mode="full",
        lightweight=True,
        fail_on_empty=False,
        strict_instrument_lookup=False,
    )
    assert full.materialize_mode == "full"
    assert (artifacts / "inventory_checkpoint.json").exists()
    full_payload = json.loads(snapshot.read_text(encoding="utf-8"))

    # Second cycle with no new trades should be incremental and preserve book.
    again = materialize_dashboard_snapshot(
        db_path=db_path,
        artifacts_dir=artifacts,
        snapshot_path=snapshot,
        greeks_json=greeks,
        mode="auto",
        lightweight=True,
        fail_on_empty=False,
        strict_instrument_lookup=False,
    )
    assert again.materialize_mode == "incremental"
    assert again.incremental_new_trades == 0
    again_payload = json.loads(snapshot.read_text(encoding="utf-8"))
    assert again_payload["rows"] == full_payload["rows"]

    # Append a new trade and ensure incremental moves inventory/GEX.
    conn = sqlite3.connect(db_path)
    trade = {
        "trade_id": "t4",
        "trade_seq": 3,
        "timestamp": 1_700_000_000_500,
        "instrument_name": "BTC-31DEC26-90000-C",
        "direction": "buy",
        "amount": 5,
        "price": 0.06,
    }
    conn.execute(
        """
        INSERT INTO raw_trades (
          instrument_name, trade_id, trade_seq, timestamp_ms, direction,
          block_trade_id, combo_trade_id, source_run_id, ingested_at_ms, payload_json
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'run', 1, ?)
        """,
        (
            trade["instrument_name"],
            trade["trade_id"],
            trade["trade_seq"],
            trade["timestamp"],
            trade["direction"],
            json.dumps(trade),
        ),
    )
    conn.commit()
    conn.close()

    third = materialize_dashboard_snapshot(
        db_path=db_path,
        artifacts_dir=artifacts,
        snapshot_path=snapshot,
        greeks_json=greeks,
        mode="auto",
        lightweight=True,
        fail_on_empty=False,
        strict_instrument_lookup=False,
    )
    assert third.materialize_mode == "incremental"
    assert third.incremental_new_trades == 1

    full_after = materialize_dashboard_snapshot(
        db_path=db_path,
        artifacts_dir=tmp_path / "artifacts_full",
        snapshot_path=tmp_path / "latest_full.json",
        greeks_json=greeks,
        mode="full",
        lightweight=True,
        fail_on_empty=False,
        strict_instrument_lookup=False,
    )
    inc_payload = json.loads(snapshot.read_text(encoding="utf-8"))
    full_payload2 = json.loads(Path(full_after.phase5_snapshot_path).read_text(encoding="utf-8"))
    assert inc_payload["rows"] == full_payload2["rows"]

    ckpt = load_checkpoint(artifacts / "inventory_checkpoint.json")
    assert ckpt is not None
    assert ckpt.raw_trade_count == 4

    # Post-materialize rewrite: checkpoint must match serving inventory CSV.
    inv_positions = load_positions_from_inventory_csv(artifacts / "inventory_snapshot.csv")
    assert ckpt.positions == inv_positions
    assert ckpt.positions_sha256 == positions_sha256(inv_positions)
    lag = measure_checkpoint_inventory_lag(artifacts)
    assert lag.delta_count == 0
    assert lag.positions_sha_match is True
    assert full.checkpoint_lag_count == 0
    assert third.checkpoint_lag_count == 0
