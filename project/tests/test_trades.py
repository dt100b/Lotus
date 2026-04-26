import pytest

from normalizer.instruments import InstrumentRegistry
from normalizer.trades import normalize_trade


def test_normalize_trade_keeps_audit_fields_and_is_eligible_when_single_leg_btc_option():
    registry = InstrumentRegistry.build(
        [{"instrument_name": "BTC-28JUN24-70000-C", "base_currency": "BTC"}]
    )

    raw_trade = {
        "trade_id": "123",
        "trade_seq": 456,
        "timestamp": 1717000000000,
        "instrument_name": "BTC-28JUN24-70000-C",
        "direction": "buy",
        "amount": "2",
        "price": "0.055",
        "index_price": "68000",
        "mark_price": "0.054",
        "iv": "0.62",
        "liquidation": False,
    }

    event = normalize_trade(raw_trade, registry)

    assert event.trade_id == "123"
    assert event.trade_seq == 456
    assert event.taker_side == "buy"
    assert event.instrument_kind == "option"
    assert event.excluded_from_v1_derived is False
    assert event.exclusion_reasons == ()
    assert event.raw_payload == raw_trade
    assert len(event.raw_payload_sha256) == 64


def test_block_trade_is_preserved_but_excluded():
    registry = InstrumentRegistry.build(
        [{"instrument_name": "BTC-28JUN24-70000-C", "base_currency": "BTC"}]
    )

    raw_trade = {
        "trade_id": "124",
        "timestamp": 1717000000001,
        "instrument_name": "BTC-28JUN24-70000-C",
        "direction": "sell",
        "amount": "1",
        "price": "0.05",
        "block_trade_id": "blk-1",
    }

    event = normalize_trade(raw_trade, registry)

    assert event.is_block is True
    assert event.excluded_from_v1_derived is True
    assert "block" in event.exclusion_reasons


def test_combo_like_trade_is_preserved_but_excluded():
    raw_trade = {
        "trade_id": "125",
        "timestamp": 1717000000002,
        "instrument_name": "BTC-COMBO-X",
        "direction": "buy",
        "amount": "1",
        "price": "0.01",
        "combo_id": "combo-1",
    }

    event = normalize_trade(raw_trade, InstrumentRegistry.build([]), strict_instrument_lookup=False)

    assert event.is_combo is True
    assert event.excluded_from_v1_derived is True
    assert event.instrument_kind == "unresolved"
    assert "missing_instrument_metadata" in event.exclusion_reasons
    assert "combo" in event.exclusion_reasons
    assert "non_single_option" in event.exclusion_reasons


def test_unknown_instrument_hard_fails_in_strict_mode():
    raw_trade = {
        "trade_id": "126",
        "timestamp": 1717000000003,
        "instrument_name": "BTC-UNKNOWN-THING",
        "direction": "buy",
        "amount": "1",
        "price": "0.02",
    }

    with pytest.raises(KeyError):
        normalize_trade(raw_trade, InstrumentRegistry.build([]), strict_instrument_lookup=True)


def test_unknown_instrument_non_strict_is_unresolved_and_never_eligible():
    raw_trade = {
        "trade_id": "127",
        "timestamp": 1717000000004,
        "instrument_name": "BTC-UNKNOWN-THING",
        "direction": "sell",
        "amount": "1",
        "price": "0.03",
    }

    event = normalize_trade(raw_trade, InstrumentRegistry.build([]), strict_instrument_lookup=False)

    assert event.instrument_kind == "unresolved"
    assert event.instrument_key == "UNRESOLVED:BTC-UNKNOWN-THING"
    assert event.excluded_from_v1_derived is True
    assert "missing_instrument_metadata" in event.exclusion_reasons
