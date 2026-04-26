from decimal import Decimal

from normalizer.instruments import InstrumentRegistry, normalize_instrument, parse_deribit_option_instrument_name


def test_parse_deribit_listed_btc_option_name():
    parsed = parse_deribit_option_instrument_name("BTC-28JUN24-70000-C")

    assert parsed is not None
    assert parsed.underlying == "BTC"
    assert parsed.expiry_label == "28JUN24"
    assert parsed.strike == Decimal("70000")
    assert parsed.option_type == "call"


def test_normalize_instrument_prefers_parser_for_listed_option():
    instrument = normalize_instrument(
        {
            "instrument_name": "BTC-28JUN24-70000-P",
            "base_currency": "BTC",
            "tick_size": "0.0005",
            "contract_size": "1",
        }
    )

    assert instrument.kind == "option"
    assert instrument.underlying == "BTC"
    assert instrument.option_type == "put"
    assert instrument.strike == Decimal("70000")
    assert instrument.expiry_ts_ms is not None


def test_registry_builds_lookup_by_instrument_name():
    registry = InstrumentRegistry.build(
        [
            {"instrument_name": "BTC-28JUN24-70000-C", "base_currency": "BTC"},
            {"instrument_name": "BTC-28JUN24-70000-P", "base_currency": "BTC"},
        ]
    )

    assert registry.get("BTC-28JUN24-70000-C") is not None
    assert registry.get("BTC-28JUN24-70000-P") is not None
