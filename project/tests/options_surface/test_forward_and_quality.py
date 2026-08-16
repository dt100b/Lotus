"""Forward hierarchy and quote-quality reason-code tests."""

from __future__ import annotations

from datetime import timedelta

import pytest

from project.options_surface.forward.estimate import estimate_forward, inverse_option_forward
from project.options_surface.market_data.ticker_adapter import quotes_from_scanner_rows
from project.options_surface.normalization.quotes import classify_quotes
from project.options_surface.timeutil import inferred_deribit_expiry_utc
from project.options_surface.types import ForwardSource, RejectionReason, SourceQuality
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    flat_vol_chain,
    inverse_mids_for_forward,
    listed_future,
    option_row,
)


def _observations(rows, **kwargs):
    quotes = quotes_from_scanner_rows(rows, as_of_utc=AS_OF, default_index_usd=INDEX)
    return classify_quotes(quotes, as_of_utc=AS_OF, expiry_date=EXPIRY, **kwargs)


def test_inverse_parity_recovers_known_forward() -> None:
    call_mid, put_mid = inverse_mids_for_forward(100_000.0, 101_500.0)
    recovered = inverse_option_forward(100_000.0, call_mid, put_mid)
    assert recovered == pytest.approx(101_500.0)


def test_usd_spot_times_premium_is_not_used_as_parity() -> None:
    """Multiplying inverse premium by spot must not recover the inverse forward."""
    strike = 100_000.0
    true_f = 101_500.0
    call_mid, put_mid = inverse_mids_for_forward(strike, true_f)
    usd_style = strike + (call_mid * INDEX - put_mid * INDEX)
    recovered = inverse_option_forward(strike, call_mid, put_mid)
    assert recovered == pytest.approx(true_f)
    # Inverse coin parity and USD additive parity are different models.
    assert usd_style != pytest.approx(true_f, rel=1e-6)
    # Coin-parity C-P = 0.10 ⇒ F = K / 0.9. USD additive parity is K + 0.10·S.
    coin_f = inverse_option_forward(100_000.0, 0.20, 0.10)
    usd_additive = 100_000.0 + 0.10 * INDEX
    assert coin_f == pytest.approx(100_000.0 / 0.9)
    assert abs(usd_additive - float(coin_f)) > 1_000.0


def test_matching_future_preferred_over_parity() -> None:
    rows = flat_vol_chain(forward=FORWARD)
    observations = _observations(rows)
    result = estimate_forward(
        observations,
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        expiry_date=EXPIRY,
        underlying="BTC",
        index_usd=INDEX,
        futures=(listed_future(mid=102_000.0),),
    )
    assert result.source is ForwardSource.MATCHING_FUTURE
    assert result.source_quality is SourceQuality.HIGH
    assert result.forward_usd == pytest.approx(102_000.0)
    assert result.supporting_instruments
    assert result.parity_pair_count >= 2
    assert result.futures_option_difference is not None


def test_parity_fallback_when_future_missing() -> None:
    rows = flat_vol_chain(forward=FORWARD)
    observations = _observations(rows)
    result = estimate_forward(
        observations,
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        expiry_date=EXPIRY,
        underlying="BTC",
        index_usd=INDEX,
        futures=(),
    )
    assert result.source is ForwardSource.INVERSE_PUT_CALL_PARITY
    assert result.source_quality in {SourceQuality.MEDIUM, SourceQuality.LOW}
    assert result.parity_pair_count >= 2
    assert result.parity_dispersion is not None
    assert result.fallback_reason == "no_quality_matching_future"
    assert abs(result.forward_usd - FORWARD) / FORWARD < 0.01


def test_invalid_parity_fails_closed_to_venue_or_spot() -> None:
    rows = []
    for strike in (80_000.0, 120_000.0):
        rows.append(option_row(strike, "call", 50.0, bid=0.20, ask=0.21, underlying_price=None))
        rows.append(option_row(strike, "put", 50.0, bid=0.20, ask=0.21, underlying_price=None))
    observations = _observations(rows)
    result = estimate_forward(
        observations,
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        expiry_date=EXPIRY,
        underlying="BTC",
        index_usd=INDEX,
        futures=(),
    )
    assert result.source in {ForwardSource.SPOT_FALLBACK, ForwardSource.VENUE_UNDERLYING_PRICE}
    assert result.source_quality is SourceQuality.LOW
    assert result.fallback_reason
    assert "parity" in " ".join(result.validation_flags) or result.parity_pair_count < 2


def test_spot_fallback_metadata() -> None:
    rows = [option_row(100_000.0, "call", 50.0, underlying_price=None)]
    observations = _observations(rows)
    result = estimate_forward(
        observations,
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        expiry_date=EXPIRY,
        underlying="BTC",
        index_usd=INDEX,
        futures=(),
    )
    assert result.source is ForwardSource.SPOT_FALLBACK
    assert result.source_quality is SourceQuality.LOW
    assert result.forward_usd == INDEX
    assert result.fallback_reason


def test_quality_reason_codes() -> None:
    stale = option_row(100_000.0, "call", 50.0, quote_as_of=AS_OF - timedelta(seconds=90))
    crossed = option_row(101_000.0, "put", 50.0, bid=0.06, ask=0.04)
    one_sided = option_row(102_000.0, "call", 50.0, bid=0.0, ask=0.05)
    invalid_iv = option_row(103_000.0, "put", -5.0)
    missing = option_row(104_000.0, "call", 50.0)
    missing["bid_price"] = None
    malformed = {"expiry": EXPIRY, "strike": None, "option_type": "x", "mark_iv": 50.0}
    expired_state = option_row(105_000.0, "call", 50.0, state="closed")
    no_size = option_row(106_000.0, "put", 50.0, bid_size=None, ask_size=None)
    future_ts = option_row(107_000.0, "call", 50.0, quote_as_of=AS_OF + timedelta(seconds=30))
    duplicate = option_row(108_000.0, "call", 50.0)
    duplicate2 = option_row(108_000.0, "call", 51.0)
    out_of_range = option_row(109_000.0, "put", 900.0)
    good = option_row(100_500.0, "call", 50.0)

    rows = [
        stale,
        crossed,
        one_sided,
        invalid_iv,
        missing,
        malformed,
        expired_state,
        no_size,
        future_ts,
        duplicate,
        duplicate2,
        out_of_range,
        good,
    ]
    observations = _observations(rows)
    reasons = {item.rejection_reason for item in observations if item.rejection_reason}
    assert RejectionReason.STALE_QUOTE in reasons
    assert RejectionReason.CROSSED_PRICE in reasons
    assert RejectionReason.ZERO_BID in reasons
    assert RejectionReason.INVALID_IV in reasons or RejectionReason.OUT_OF_RANGE in reasons
    assert RejectionReason.MISSING_QUOTE in reasons
    assert RejectionReason.NON_OPEN in reasons
    assert RejectionReason.MISSING_SIZE in reasons
    assert RejectionReason.FUTURE_TIMESTAMP in reasons
    assert RejectionReason.DUPLICATE in reasons
    accepted = [item for item in observations if item.accepted]
    accepted_strikes = {item.quote.strike_usd for item in accepted}
    assert 100_500.0 in accepted_strikes
    assert any(item.rejection_reason is RejectionReason.DUPLICATE for item in observations)
