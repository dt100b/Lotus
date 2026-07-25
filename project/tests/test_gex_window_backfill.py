"""Tests for real gex_window_history inventory-replay backfill helpers."""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

from ledger.models import NormalizedTradeEvent
from ledger.rules import production_ledger_policy
from pipeline.flow_regime import PERIOD_DELTA_HOURS, _build_period_deltas
from pipeline.gex_window_backfill import (
    _apply_event,
    _sample_grid,
    _velocity_from_samples,
    verify_samples_are_not_synthetic,
)


def _event(
    *,
    event_id: str,
    trade_seq: int,
    ts_ms: int,
    instrument: str,
    amount: str,
    taker_side: str,
    is_block: bool = False,
) -> NormalizedTradeEvent:
    return NormalizedTradeEvent(
        event_id=event_id,
        source_trade_id=event_id,
        trade_seq=trade_seq,
        ts_ms=ts_ms,
        venue="deribit",
        base_currency="BTC",
        kind="option",
        instrument_name=instrument,
        option_type="call",
        strike=Decimal("65000"),
        expiry_ts_ms=ts_ms + 30 * 86400 * 1000,
        contract_size=Decimal("1"),
        amount=Decimal(amount),
        price=Decimal("0.01"),
        taker_side=taker_side,
        is_block_trade=is_block,
        is_combo_trade=False,
        is_single_leg=True,
        normalization_version="phase2.v1",
    )


def test_apply_event_forward_and_reverse_roundtrip() -> None:
    policy = production_ledger_policy()
    positions: dict[str, Decimal] = {}
    buy = _event(
        event_id="a",
        trade_seq=1,
        ts_ms=1_000,
        instrument="BTC-31JUL26-65000-C",
        amount="2.5",
        taker_side="buy",
    )
    sell = _event(
        event_id="b",
        trade_seq=2,
        ts_ms=2_000,
        instrument="BTC-31JUL26-65000-C",
        amount="1.0",
        taker_side="sell",
    )
    _apply_event(positions, buy, policy, reverse=False)
    _apply_event(positions, sell, policy, reverse=False)
    # taker buy → dealer −2.5; taker sell → dealer +1.0 → net −1.5
    assert positions["BTC-31JUL26-65000-C"] == Decimal("-1.5")

    _apply_event(positions, sell, policy, reverse=True)
    _apply_event(positions, buy, policy, reverse=True)
    assert positions == {}


def test_block_trades_excluded_from_inventory() -> None:
    policy = production_ledger_policy()
    positions: dict[str, Decimal] = {}
    block = _event(
        event_id="blk",
        trade_seq=1,
        ts_ms=1_000,
        instrument="BTC-31JUL26-65000-C",
        amount="100",
        taker_side="buy",
        is_block=True,
    )
    _apply_event(positions, block, policy, reverse=False)
    assert positions == {}


def test_sample_grid_includes_start_and_aligns() -> None:
    # start just after an hour edge; interval 15m
    start = 1_800_000_000_100
    end = start + 2 * 3600 * 1000
    grid = _sample_grid(start_ms=start, end_ms=end, interval_min=15)
    assert grid[0] == start
    assert all(grid[i] < grid[i + 1] for i in range(len(grid) - 1))
    assert all(ts < end for ts in grid)


def test_period_deltas_from_varied_samples() -> None:
    hour = 3_600_000
    end = 1_800_000_000_000
    end = (end // hour) * hour
    samples = []
    # Distinct nets each hour so Δs are non-zero and non-synthetic-flat.
    for i in range(26):
        net = -10_000_000.0 + i * 50_000.0 + (i % 3) * 10_000.0
        strike_a = net * 0.6
        strike_b = net * 0.4
        # Vary mix slightly so shape check passes.
        if i % 2:
            strike_a, strike_b = strike_b, strike_a
        samples.append(
            {
                "ts_ms": end - (25 - i) * hour,
                "spot": 65000.0 + i,
                "net_gex": net,
                "by_strike": {"65000": strike_a, "70000": strike_b},
            }
        )
    check = verify_samples_are_not_synthetic(samples)
    assert check["ok"] is True

    periods = _build_period_deltas(samples, end)
    assert len(periods) == PERIOD_DELTA_HOURS
    non_null = [p for p in periods if p["delta_net_gex"] is not None]
    assert len(non_null) == PERIOD_DELTA_HOURS
    # At least one non-zero real Δ
    assert any(abs(p["delta_net_gex"]) > 1.0 for p in non_null)

    velocity = _velocity_from_samples(samples)
    assert len(velocity["period_deltas"]) == PERIOD_DELTA_HOURS
    assert velocity["windows"]["1h"]["delta_net_gex"] is not None


def test_synthetic_shape_detector_flags_scaled_ring() -> None:
    base = {65000.0: -4_000_000.0, 70000.0: -2_000_000.0}
    samples = []
    for i in range(10):
        scale = 1.0 + 0.01 * i
        samples.append(
            {
                "ts_ms": 1_800_000_000_000 + i * 900_000,
                "spot": 65000.0,
                "net_gex": sum(base.values()) * scale,
                "by_strike": {str(int(k)): v * scale for k, v in base.items()},
            }
        )
    check = verify_samples_are_not_synthetic(samples)
    assert check["ok"] is False
