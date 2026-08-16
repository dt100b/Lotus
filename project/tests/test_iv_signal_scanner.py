"""Offline release-gate tests for the quick-view IV signal scanner."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
import numpy as np
import pytest
from scipy.integrate import simpson

import project.api.main as api_main
from project.api.main import app, get_repository
from project.api.repository import (
    IV_SIGNAL_STANDARD_REFRESH_SECONDS,
    IV_SIGNAL_ZERO_DTE_REFRESH_SECONDS,
    SnapshotRepository,
    _build_iv_signal_eligibility,
)
from pipeline.deribit_iv_chain import (
    DERIBIT_BOOK_SUMMARY_URL,
    DeribitIvChainProvider,
    DeribitTickerIvChainProvider,
    IvChainProviderError,
    IvChainSnapshot,
)
from project.pipeline.deribit_ticker_stream import (
    ConnectionState,
    DeribitTickerQuote,
    TickerStreamSnapshot,
)
from project.pipeline.iv_signal_scanner import (
    BAND_DELTA_MULT,
    DENSE_POINTS,
    SMOOTHING_IV,
    _build_pdf_with_quality,
    bs_call_price,
    bs_put_price,
    build_canonical_smile,
    build_pdf,
    canonical_wing_ivs,
    compute_signals,
    confirm_published_verdict,
    deribit_settlement,
    inverse_option_forward,
    normalize_expiry_iv_curve,
    scan_expiry_rows,
)


EXPIRY = "2030-08-16"
AS_OF_DT = datetime(2030, 8, 15, 12, tzinfo=UTC)


def _quote(
    strike: float,
    side: str,
    mark_iv: object,
    *,
    expiry: str = EXPIRY,
    bid: object = 0.048,
    ask: object = 0.052,
    quote_as_of: object = AS_OF_DT,
    open_interest: object = None,
    delta: object = None,
) -> dict[str, Any]:
    try:
        numeric_iv = float(mark_iv)
    except (TypeError, ValueError):
        numeric_iv = 50.0
    row = {
        "expiry": expiry,
        "strike": strike,
        "option_type": side,
        "mark_iv": mark_iv,
        "bid_price": bid,
        "ask_price": ask,
        "bid_size": 1.0,
        "ask_size": 1.0,
        "bid_iv": max(numeric_iv - 1.0, 0.01),
        "ask_iv": max(numeric_iv + 1.0, 0.02),
        "state": "open",
        "quote_as_of": quote_as_of,
    }
    if open_interest is not None:
        row["open_interest"] = open_interest
    if delta is not None:
        row["delta"] = delta
    return row


def _paired_rows(
    strikes: list[float] | None = None,
    ivs: list[float] | None = None,
) -> list[dict[str, Any]]:
    strikes = strikes or [80, 85, 90, 95, 100, 105, 110, 120]
    ivs = ivs or [62, 58, 54, 51, 50, 49, 50, 53]
    return [
        _quote(strike, side, iv)
        for strike, iv in zip(strikes, ivs, strict=True)
        for side in ("call", "put")
    ]


def _dense_smile_rows(
    *,
    expiry: str = EXPIRY,
    spot: float = 100.0,
    put_iv: float | None = None,
    call_iv: float | None = None,
    step: float = 2.0,
) -> list[dict[str, Any]]:
    """Build a compact paired smile.

    ``put_iv`` / ``call_iv`` set a one-sided level versus a 50 vol ATM.
    Put-rich means higher IV on strikes below the forward (OTM puts).
    """
    strikes = [round(value, 4) for value in np.arange(84.0, 116.0 + step / 2.0, step)]
    rows: list[dict[str, Any]] = []
    for strike in strikes:
        if strike < spot and put_iv is not None:
            iv = put_iv
        elif strike > spot and call_iv is not None:
            iv = call_iv
        else:
            iv = 50.0
        rows.append(_quote(strike, "call", iv, expiry=expiry))
        rows.append(_quote(strike, "put", iv, expiry=expiry))
    return rows


class StubProvider:
    def __init__(self, snapshot: IvChainSnapshot) -> None:
        self.snapshot = snapshot
        self.calls = 0

    def fetch(self) -> IvChainSnapshot:
        self.calls += 1
        return self.snapshot


class FailingProvider:
    def fetch(self) -> IvChainSnapshot:
        raise IvChainProviderError("offline fixture failure")


class LifecycleProvider:
    def __init__(self) -> None:
        self.starts = 0
        self.stops = 0

    def start(self) -> bool:
        self.starts += 1
        return True

    def close(self) -> bool:
        self.stops += 1
        return True


class FakeTickerStream:
    channel_mode = "incremental"
    channel_interval = "100ms"

    def __init__(self, snapshot: TickerStreamSnapshot) -> None:
        self.snapshot_value = snapshot
        self.starts = 0
        self.stops = 0

    def start(self) -> bool:
        self.starts += 1
        return True

    def stop(self) -> bool:
        self.stops += 1
        return True

    def active_instrument_names(self) -> tuple[str, ...]:
        return self.snapshot_value.active_instrument_names

    def wait_until_ready(self, *args: Any, **kwargs: Any) -> bool:
        return self.snapshot_value.healthy

    def wait_for_snapshot(self, *args: Any, **kwargs: Any) -> TickerStreamSnapshot:
        return self.snapshot_value


def _snapshot(
    *,
    rows: list[dict[str, Any]] | None = None,
    as_of: datetime = AS_OF_DT,
    spot: float = 100.0,
    verified: bool = True,
) -> IvChainSnapshot:
    snapshot_rows = _paired_rows() if rows is None else rows
    expected = len(snapshot_rows)
    return IvChainSnapshot(
        as_of=as_of,
        spot=spot,
        rows=snapshot_rows,
        source="deribit_ticker_ws_incremental" if verified else "offline_fixture",
        verified_live_quotes=verified,
        feed={
            "source": "deribit_ticker_ws_incremental",
            "transport": "websocket",
            "channel_interval": "incremental",
            "status": "READY",
            "connected": True,
            "warmup_complete": True,
            "universe_is_current": True,
            "expected_expiry_instruments": expected,
            "subscribed_expiry_instruments": expected,
            "initialized_expiry_instruments": expected,
            "fresh_expiry_instruments": expected,
            "completeness_ratio": 1.0,
            "last_message_at": as_of,
            "reconnect_count": 0,
            "connection_generation": 1,
        },
    )


def test_black_scholes_and_density_preserve_supplied_numerics() -> None:
    assert bs_call_price(100.0, 100.0, 1.0, 0.05, 0.20) == pytest.approx(
        10.45058357, rel=1e-8
    )
    assert DENSE_POINTS == 100
    assert SMOOTHING_IV == 1.0
    assert BAND_DELTA_MULT == 8

    strikes = np.asarray([80, 85, 90, 95, 100, 105, 110, 120], dtype=float)
    ivs = np.asarray([0.62, 0.58, 0.54, 0.51, 0.50, 0.49, 0.50, 0.53])
    dense, raw, smooth = build_pdf(100.0, strikes, ivs, 20 / (365 * 24))

    assert len(dense) == len(raw) == len(smooth) == 100
    assert dense[[0, -1]].tolist() == [80.0, 120.0]
    assert simpson(raw, x=dense) == pytest.approx(1.0, rel=1e-9, abs=1e-9)
    assert np.all(np.isfinite(smooth))


def test_canonical_otm_selection_atm_merge_fallback_and_rejections() -> None:
    rows = [
        _quote(80, "call", 70),
        _quote(80, "put", 60),
        _quote(90, "call", 55),  # preferred put missing -> deterministic fallback
        _quote(100, "call", 49),
        _quote(100, "put", 51),
        _quote(110, "call", 48),
        _quote(110, "put", 65),
        _quote(120, "call", 50),
        _quote(120, "put", 70),
        _quote(130, "call", 0),
        _quote(132, "call", 50, bid=0.0, ask=0.02),
        _quote(135, "call", 50, bid=None),
        _quote(140, "call", 50, bid=0.03, ask=0.02),
        _quote(145, "call", 50, quote_as_of=AS_OF_DT - timedelta(seconds=31)),
    ]

    result = normalize_expiry_iv_curve(
        rows,
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    points = {point["strike"]: point for point in result["iv_curve"]}

    assert points[80]["iv"] == pytest.approx(0.60)
    assert points[80]["source"] == "put_otm_mark_iv"
    assert points[90]["iv"] == pytest.approx(0.55)
    assert points[90]["source"] == "call_opposite_fallback"
    assert points[100]["iv"] == pytest.approx(0.50)
    assert points[100]["source"] == "atm_call_put_merge"
    assert points[110]["iv"] == pytest.approx(0.48)
    assert points[110]["source"] == "call_otm_mark_iv"

    selection = result["selection"]
    assert selection["policy"] == "otm_mark_iv_v1"
    assert selection["preferred_side_selections"] == 3
    assert selection["opposite_side_fallbacks"] == 1
    assert selection["atm_merged_selections"] == 1
    assert selection["rejected_invalid_iv_rows"] == 1
    assert selection["rejected_zero_bid_rows"] == 1
    assert selection["rejected_missing_quote_rows"] == 1
    assert selection["rejected_crossed_quote_rows"] == 1
    assert selection["rejected_stale_quote_rows"] == 1
    assert 132 not in points
    assert all(point["iv"] > 0 for point in result["iv_curve"])
    assert result["coverage"]["spot_bracketed"] is True


def test_synthetic_atm_anchor_interpolates_in_log_moneyness() -> None:
    rows = _paired_rows(
        strikes=[80, 95, 105, 120],
        ivs=[60, 52, 48, 55],
    )
    result = normalize_expiry_iv_curve(
        rows,
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )

    anchor = next(point for point in result["iv_curve"] if point["synthetic"])
    x_lower = np.log(95 / 100)
    x_upper = np.log(105 / 100)
    weight = -x_lower / (x_upper - x_lower)
    expected_iv = 0.52 + weight * (0.48 - 0.52)
    assert anchor["strike"] == 100.0
    assert anchor["iv"] == pytest.approx(expected_iv)
    assert anchor["source"] == "atm_log_moneyness_interpolation"
    assert result["selection"]["synthetic_anchor_added"] is True
    assert result["selection"]["selected_market_strikes"] == 4
    assert result["coverage"]["unique_strikes"] == 5


def test_ticker_policy_validates_state_size_and_iv_market() -> None:
    rows = _paired_rows(strikes=[80, 90, 100, 110, 120], ivs=[55, 52, 50, 49, 51])
    rows.extend(
        [
            {**_quote(130, "call", 50), "state": "halted"},
            {**_quote(135, "call", 50), "bid_size": 0},
            {**_quote(140, "call", 50), "bid_iv": 55, "ask_iv": 50},
            {**_quote(145, "call", 60), "bid_iv": 49, "ask_iv": 51},
        ]
    )

    result = normalize_expiry_iv_curve(
        rows,
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
        source="deribit_ticker_ws_incremental",
    )

    selection = result["selection"]
    assert selection["policy"] == "otm_ticker_mark_iv_v4"
    assert selection["iv_basis"] == "mark_iv"
    assert selection["rejected_non_open_rows"] == 1
    assert selection["rejected_missing_size_rows"] == 1
    assert selection["rejected_invalid_iv_market_rows"] == 2
    assert selection["median_selected_iv_spread_percentage_points"] == pytest.approx(2.0)
    assert selection["max_selected_iv_spread_percentage_points"] == pytest.approx(2.0)

    sparse = scan_expiry_rows(
        _paired_rows(strikes=[80, 95, 105, 120], ivs=[60, 52, 48, 55]),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
        source="deribit_ticker_ws_incremental",
    )
    assert sparse["verdict"] == "NO_TRADE"
    assert (
        "insufficient verified ticker IV coverage"
        in sparse["suppression_reasons"]
    )


def test_ticker_density_filters_exclude_zero_bid_and_keep_atm_oi() -> None:
    rows = _paired_rows()
    rows.extend(
        [
            _quote(70, "put", 80, bid=0.0, ask=0.02, open_interest=40),
            _quote(100, "call", 50, open_interest=1),
            _quote(100, "put", 50, open_interest=1),
        ]
    )
    result = normalize_expiry_iv_curve(
        rows,
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
        source="deribit_ticker_ws_incremental",
    )
    strikes = {point["strike"] for point in result["iv_curve"]}
    assert 70 not in strikes
    assert 100 in strikes
    assert result["selection"]["rejected_zero_bid_rows"] == 1
    assert all(point["iv"] > 0 for point in result["iv_curve"])


def test_ticker_density_filters_screen_wings_not_core() -> None:
    long_expiry = "2030-12-15"
    strikes = [
        50, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 160,
    ]
    ivs = [
        90, 80, 75, 70, 65, 60, 56, 54, 51, 50, 49, 52, 55, 58, 62, 66, 70, 75, 95,
    ]
    rows = [
        _quote(
            strike,
            side,
            iv,
            expiry=long_expiry,
            open_interest=(
                0 if strike == 80
                else 1 if strike == 100
                else 40
            ),
            delta=(
                (0.02 if side == "call" else -0.02)
                if strike in {50, 160}
                else None
            ),
        )
        for strike, iv in zip(strikes, ivs, strict=True)
        for side in ("call", "put")
    ]
    # Venue delta keeps this wing eligible for the OI screen, but 3 contracts
    # is below the long-dated far-wing floor.  A modest ATM OI must survive.
    rows.extend(
        [
            _quote(
                45,
                "put",
                100,
                expiry=long_expiry,
                open_interest=3,
                delta=-0.08,
            ),
            _quote(
                170,
                "call",
                110,
                expiry=long_expiry,
                bid=0.001,
                ask=0.02,
                open_interest=80,
                delta=0.08,
            ),
        ]
    )

    result = normalize_expiry_iv_curve(
        rows,
        expiry=long_expiry,
        spot=100.0,
        as_of=AS_OF_DT,
        source="deribit_ticker_ws_incremental",
    )
    points = {point["strike"] for point in result["iv_curve"]}
    selection = result["selection"]

    assert 100 in points
    assert 45 not in points
    assert 80 not in points
    assert 170 not in points
    assert 50 not in points
    assert 160 not in points
    assert selection["policy"] == "otm_ticker_mark_iv_v4"
    assert selection["rejected_low_open_interest_rows"] >= 2
    assert selection["rejected_wide_spread_rows"] >= 1
    assert selection["rejected_low_delta_rows"] >= 1
    assert selection["coverage_corridor"] is not None
    assert selection["delta_cutoff"] == pytest.approx(0.05)
    assert result["coverage"]["spot_bracketed"] is True
    assert result["coverage"]["hard_valid_strikes"] > result["selection"]["selected_market_strikes"]
    assert result["coverage"]["hard_valid_coverage_ratio"] > result["coverage"]["iv_coverage_ratio"]

    eligible = scan_expiry_rows(
        rows,
        expiry=long_expiry,
        spot=100.0,
        as_of=AS_OF_DT,
        source="deribit_ticker_ws_incremental",
    )
    assert eligible["coverage"]["tenor_min_strikes"] == 16
    assert eligible["coverage"]["tenor_min_side_strikes"] == 5


def test_symmetric_smile_fires_no_directional_driver() -> None:
    scan = scan_expiry_rows(
        _dense_smile_rows(),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    assert scan["signals"]["skew"]["signal"] == "NO_TRADE"
    assert scan["signals"]["tails"]["signal"] == "NO_TRADE"
    assert scan["signals"]["peak"]["signal"] == "NO_TRADE"
    assert scan["model_verdict"] == "NO_TRADE"


def test_elevated_put_wing_preserves_left_tail_ordering() -> None:
    put_rich = scan_expiry_rows(
        _dense_smile_rows(put_iv=90.0, call_iv=50.0),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    flat = scan_expiry_rows(
        _dense_smile_rows(),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    _assert_wing_chain(put_rich, side="left")
    assert put_rich["rnd"]["p_left_5"] > flat["rnd"]["p_left_5"]
    assert put_rich["rnd"]["p_left_5"] > put_rich["rnd"]["p_right_5"]
    assert put_rich["rnd"]["wing_ordering"] == "left"
    assert put_rich["rnd"]["wing_signal"] == "SHORT"
    assert put_rich["rnd"]["sigma_move"] > 0
    assert "sigma_ordering" in put_rich["rnd"]


def test_elevated_call_wing_preserves_right_tail_ordering() -> None:
    call_rich = scan_expiry_rows(
        _dense_smile_rows(put_iv=50.0, call_iv=90.0),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    flat = scan_expiry_rows(
        _dense_smile_rows(),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    _assert_wing_chain(call_rich, side="right")
    assert call_rich["rnd"]["p_right_5"] > flat["rnd"]["p_right_5"]
    assert call_rich["rnd"]["p_right_5"] > call_rich["rnd"]["p_left_5"]
    assert call_rich["rnd"]["wing_ordering"] == "right"
    assert call_rich["rnd"]["wing_signal"] == "LONG"


def _assert_wing_chain(scan: dict[str, Any], *, side: str) -> None:
    forward = float(scan["selection"]["otm_reference"])
    left_iv, right_iv = canonical_wing_ivs(scan["iv_curve"], forward=forward)
    assert left_iv is not None and right_iv is not None
    time_to_expiry = float(scan["time_to_expiry_years"])
    spot = 100.0
    put90 = bs_put_price(spot, 90.0, time_to_expiry, 0.0, left_iv)
    put90_flat = bs_put_price(spot, 90.0, time_to_expiry, 0.0, 0.50)
    call110 = bs_call_price(spot, 110.0, time_to_expiry, 0.0, right_iv)
    call110_flat = bs_call_price(spot, 110.0, time_to_expiry, 0.0, 0.50)
    rnd = scan["rnd"]
    assert rnd["mean"] == pytest.approx(forward, rel=0.02, abs=1.0)
    assert rnd["normalization_integral"] == pytest.approx(1.0, abs=0.05)
    if side == "left":
        assert left_iv > right_iv
        assert put90 > put90_flat
        assert rnd["p_left_5"] > rnd["p_right_5"]
        assert rnd["percentile_05"] < forward * 0.96
    else:
        assert right_iv > left_iv
        assert call110 > call110_flat
        assert rnd["p_right_5"] > rnd["p_left_5"]
        assert rnd["percentile_95"] > forward * 1.04


def test_zero_bid_wing_is_excluded_and_cannot_spike_density() -> None:
    rows = _dense_smile_rows()
    rows.append(_quote(60, "put", 5.0, bid=0.0, ask=0.02))
    scan = scan_expiry_rows(
        rows,
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
        source="deribit_ticker_ws_incremental",
    )
    strikes = [point["strike"] for point in scan["iv_curve"]]
    assert 60 not in strikes
    assert scan["selection"]["rejected_zero_bid_rows"] >= 1
    assert all(point["iv"] > 0 for point in scan["iv_curve"])
    assert scan["density"][0]["strike"] > 60


def test_canonical_smile_uses_pdf_fit_and_interpolated_25d_metrics() -> None:
    rows = _dense_smile_rows()
    scan = scan_expiry_rows(
        rows,
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
        source="deribit_ticker_ws_incremental",
    )
    smile = scan["smile"]
    pdf_strikes = [point["strike"] for point in scan["density"]]
    assert len(smile["fit"]) == DENSE_POINTS
    assert smile["fit"][0]["strike"] == pytest.approx(pdf_strikes[0])
    assert smile["fit"][-1]["strike"] == pytest.approx(pdf_strikes[-1])
    accepted_strikes = {point["strike"] for point in smile["points"] if not point["synthetic"]}
    curve_strikes = {point["strike"] for point in scan["iv_curve"] if not point["synthetic"]}
    assert accepted_strikes == curve_strikes
    assert all(point["classification"] in {"preferred", "fallback", "synthetic"} for point in smile["points"])
    assert smile["metrics"]["delta_axis_available"] is True
    assert smile["metrics"]["atm_iv"] is not None
    assert smile["metrics"]["rr_25"] is not None
    assert smile["metrics"]["bf_25"] is not None

    rebuilt = build_canonical_smile(
        scan["iv_curve"],
        forward=scan["rnd"]["forward"],
        time_to_expiry_years=scan["time_to_expiry_years"],
    )
    assert rebuilt["metrics"]["rr_25"] == pytest.approx(smile["metrics"]["rr_25"])
    assert rebuilt["metrics"]["bf_25"] == pytest.approx(smile["metrics"]["bf_25"])
    assert rebuilt["metrics"]["iv_25_call"] == pytest.approx(smile["metrics"]["iv_25_call"])
    assert rebuilt["metrics"]["iv_25_put"] == pytest.approx(smile["metrics"]["iv_25_put"])


def test_flat_canonical_smile_has_near_zero_risk_reversal_and_butterfly() -> None:
    strikes = [80, 85, 90, 95, 100, 105, 110, 115, 120]
    rows = _paired_rows(strikes=strikes, ivs=[50] * len(strikes))
    smile = build_canonical_smile(
        [
            {
                "strike": float(strike),
                "iv": 0.50,
                "iv_percent": 50.0,
                "source": "put_otm_mark_iv" if strike < 100 else "call_otm_mark_iv",
                "option_side": "put" if strike < 100 else "call",
                "synthetic": False,
                "quote_age_seconds": 1.0,
                "mark_iv": 0.50,
            }
            for strike in strikes
        ],
        forward=100.0,
        time_to_expiry_years=30 / 365,
    )
    assert smile["metrics"]["rr_25"] == pytest.approx(0.0, abs=0.15)
    assert smile["metrics"]["bf_25"] == pytest.approx(0.0, abs=0.15)
    assert smile["metrics"]["delta_axis_available"] is True


def test_smile_is_empty_when_the_accepted_set_is_too_thin() -> None:
    smile = build_canonical_smile(
        [
            {
                "strike": 100.0,
                "iv": 0.5,
                "iv_percent": 50.0,
                "source": "atm_call_put_merge",
                "option_side": "merged",
                "synthetic": False,
                "quote_age_seconds": 1.0,
            }
        ],
        forward=100.0,
        time_to_expiry_years=0.05,
    )
    assert smile["points"] == []
    assert smile["fit"] == []
    assert smile["metrics"]["rr_25"] is None
    assert smile["metrics"]["delta_axis_available"] is False


def test_sparse_center_forces_low_quality_and_suppresses_verdict() -> None:
    rows = _paired_rows(strikes=[70, 75, 80, 120, 125, 130], ivs=[70, 62, 56, 56, 62, 70])
    scan = scan_expiry_rows(
        rows,
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    assert scan["coverage"]["center_gap_exceeded"] is True
    assert scan["curve_quality"]["level"] == "LOW"
    assert scan["curve_quality"]["sparse_center"] is True
    assert scan["verdict"] == "NO_TRADE"
    assert "LOW curve quality" in scan["suppression_reasons"]


def test_wide_spread_wing_is_excluded() -> None:
    rows = _dense_smile_rows()
    rows.append(
        _quote(
            70,
            "put",
            90.0,
            bid=0.001,
            ask=0.03,
            open_interest=40,
            delta=-0.08,
        )
    )
    result = normalize_expiry_iv_curve(
        rows,
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
        source="deribit_ticker_ws_incremental",
    )
    assert result["selection"]["rejected_wide_spread_rows"] >= 1
    assert 70 not in {point["strike"] for point in result["iv_curve"]}


def test_call_put_parity_forward_flips_otm_source() -> None:
    assert inverse_option_forward(100.0, 0.06, 0.04) == pytest.approx(100.0 / 0.98)
    rows = _dense_smile_rows()
    by_key = {(row["strike"], row["option_type"]): row for row in rows}
    for row in by_key.values():
        if row["option_type"] == "call":
            row.update(bid_price=0.062, ask_price=0.068)
        else:
            row.update(bid_price=0.028, ask_price=0.034)
    by_key[(100.0, "call")].update(bid_price=0.057, ask_price=0.063)
    by_key[(100.0, "put")].update(bid_price=0.037, ask_price=0.043)
    result = normalize_expiry_iv_curve(
        list(by_key.values()),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
        source="deribit_ticker_ws_incremental",
    )
    expected_forward = 100.0 / (1.0 - 0.02)
    assert result["selection"]["forward_source"] == "parity_pairs"
    assert result["selection"]["implied_forward"] == pytest.approx(expected_forward, rel=1e-4)
    points = {point["strike"]: point for point in result["iv_curve"] if not point["synthetic"]}
    assert 102.0 in points
    assert points[102.0]["source"] == "put_otm_mark_iv"
    assert points[102.0]["option_side"] == "put"


def test_small_quote_perturbation_holds_label_until_hysteresis() -> None:
    base = scan_expiry_rows(
        _dense_smile_rows(put_iv=90.0, call_iv=50.0),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    held = scan_expiry_rows(
        _dense_smile_rows(put_iv=88.0, call_iv=51.0),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
        previous_signals=base["signals"],
    )
    assert held["signals"]["skew"]["signal"] == base["signals"]["skew"]["signal"]
    assert held["signals"]["tails"]["signal"] == base["signals"]["tails"]["signal"]
    assert held["model_verdict"] == base["model_verdict"]
    first = confirm_published_verdict(raw="LONG")
    assert first["published_verdict"] == "LONG"
    assert first["forming"] is False
    pending = confirm_published_verdict(
        raw="SHORT",
        history=first["history"],
        previous_published="LONG",
    )
    assert pending["published_verdict"] == "LONG"
    assert pending["forming"] is True
    confirmed = confirm_published_verdict(
        raw="SHORT",
        history=pending["history"],
        previous_published="LONG",
    )
    assert confirmed["published_verdict"] == "SHORT"
    assert confirmed["forming"] is False
    zero_dte = confirm_published_verdict(
        raw="SHORT",
        history=["LONG"],
        previous_published="LONG",
        immediate=True,
    )
    assert zero_dte["published_verdict"] == "SHORT"
    assert zero_dte["forming"] is False


def test_curve_quality_reports_negative_mass_and_low_gate() -> None:
    strikes = np.asarray([80, 85, 90, 95, 100, 105, 110, 120], dtype=float)
    smooth_ivs = np.asarray([0.62, 0.58, 0.54, 0.51, 0.50, 0.49, 0.50, 0.53])
    wiggly_ivs = np.asarray([0.20, 1.50, 0.20, 1.50, 0.20, 1.50, 0.20, 0.20])
    caution_ivs = np.asarray(
        [
            0.7523199249444905,
            0.6134385370539548,
            0.19695305810276675,
            0.37746912732467197,
            0.477259536785615,
            0.893739140940609,
            0.6863519961476167,
            0.6779743995493824,
        ]
    )

    high = _build_pdf_with_quality(
        100.0, strikes, smooth_ivs, 20 / (365 * 24)
    )[3]
    low = _build_pdf_with_quality(
        100.0, strikes, wiggly_ivs, 20 / (365 * 24)
    )[3]
    caution = _build_pdf_with_quality(
        100.0, strikes, caution_ivs, 20 / (365 * 24)
    )[3]
    assert high["level"] == "HIGH"
    assert high["negative_area"] <= 1e-8
    assert 1e-8 < caution["negative_area"] <= 0.01
    assert caution["level"] == "CAUTION"
    assert caution["signal_eligible"] is True
    assert low["level"] == "LOW"
    assert low["negative_area"] > 0.01
    assert low["positive_area"] > 1.0
    assert low["negative_grid_fraction"] > 0.0
    assert low["clipping_required"] is True

    scan = scan_expiry_rows(
        _paired_rows(ivs=[20, 150, 20, 150, 20, 150, 20, 20]),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    assert scan["model_verdict"] == "LONG"
    assert scan["verdict"] == "NO_TRADE"
    assert scan["suppression_reasons"] == ["LOW curve quality"]


def test_active_votes_require_unanimity_and_ignore_inactive_votes() -> None:
    strikes = np.asarray([80.0, 90.0, 100.0, 110.0, 120.0])
    density = np.asarray([0.005, 0.005, 0.0, 0.03, 0.03])

    conflict = compute_signals(
        100.0,
        strikes,
        density,
        np.asarray([1.0, 0.0, 0.0, 0.0, 0.0]),
    )
    assert conflict["skew"]["signal"] == "LONG"
    assert conflict["tails"]["signal"] == "LONG"
    assert conflict["peak"]["signal"] == "SHORT"
    assert conflict["band"]["signal"] == "LONG"
    assert conflict["verdict"] == "NO_TRADE"

    unanimous_active = compute_signals(
        100.0,
        strikes,
        density,
        np.asarray([0.0, 0.0, 1.0, 0.0, 0.0]),
    )
    assert unanimous_active["peak"]["signal"] == "NO_TRADE"
    assert unanimous_active["verdict"] == "LONG"


def _zero_dte_eligibility_scan() -> dict[str, Any]:
    curve = []
    for strike in (90.0, 95.0, 97.5, 98.5, 99.0, 101.0, 101.5, 102.5, 105.0, 110.0):
        curve.append(
            {
                "strike": strike,
                "source": (
                    "put_otm_mark_iv" if strike < 100.0 else "call_otm_mark_iv"
                ),
                "synthetic": False,
            }
        )
    return {
        "settlement_at": datetime(2030, 8, 15, 8, tzinfo=UTC),
        "model_verdict": "LONG",
        "signals": {
            "skew": {"signal": "LONG"},
            "tails": {"signal": "LONG"},
            "peak": {"signal": "NO_TRADE"},
            "band": {"signal": "NO_TRADE"},
        },
        "iv_curve": curve,
        "selection": {"selected_market_strikes": 10, "otm_reference": 100.0},
        "coverage": {"spot_bracketed": True, "iv_coverage_ratio": 0.5},
        "curve_quality": {"level": "HIGH"},
    }


def test_zero_dte_eligibility_is_strict_and_fail_closed() -> None:
    scan = _zero_dte_eligibility_scan()
    eligible, reasons = _build_iv_signal_eligibility(
        scan=scan,
        as_of=datetime(2030, 8, 15, 3, 59, 59, tzinfo=UTC),
        spot=100.0,
        snapshot_age_seconds=5.0,
        has_base_suppression=False,
    )
    assert reasons == []
    assert eligible.is_zero_dte is True
    assert eligible.zero_dte_eligible is True
    assert eligible.directional_eligible is True
    assert eligible.recommended_refresh_seconds == IV_SIGNAL_ZERO_DTE_REFRESH_SECONDS
    assert eligible.active_signal_count == 2
    assert eligible.aligned_signal_count == 2
    assert eligible.lower_canonical_strikes == 3
    assert eligible.upper_canonical_strikes == 3

    exactly_four_hours, reasons = _build_iv_signal_eligibility(
        scan=scan,
        as_of=datetime(2030, 8, 15, 4, tzinfo=UTC),
        spot=100.0,
        snapshot_age_seconds=5.0,
        has_base_suppression=False,
    )
    assert exactly_four_hours.zero_dte_eligible is False
    assert exactly_four_hours.requirements.settlement_window is False
    assert "0DTE requires more than 4 hours to settlement" in reasons

    for mutation, expected_reason in (
        (
            lambda value: value["curve_quality"].update(level="CAUTION"),
            "0DTE requires HIGH curve quality",
        ),
        (
            lambda value: value["signals"]["tails"].update(signal="NO_TRADE"),
            "0DTE requires at least two aligned signals",
        ),
        (
            lambda value: value["iv_curve"][2].update(source="call_opposite_fallback"),
            "0DTE requires strong two-sided strike coverage around spot",
        ),
    ):
        candidate = _zero_dte_eligibility_scan()
        mutation(candidate)
        result, candidate_reasons = _build_iv_signal_eligibility(
            scan=candidate,
            as_of=datetime(2030, 8, 15, 3, 59, 59, tzinfo=UTC),
            spot=100.0,
            snapshot_age_seconds=5.0,
            has_base_suppression=False,
        )
        assert result.zero_dte_eligible is False
        assert expected_reason in candidate_reasons

    stale, reasons = _build_iv_signal_eligibility(
        scan=scan,
        as_of=datetime(2030, 8, 15, 3, 59, 59, tzinfo=UTC),
        spot=100.0,
        snapshot_age_seconds=10.01,
        has_base_suppression=False,
    )
    assert stale.zero_dte_eligible is False
    assert "0DTE requires quotes no more than 10 seconds old" in reasons


def test_longer_dated_eligibility_preserves_existing_model_policy() -> None:
    scan = _zero_dte_eligibility_scan()
    scan["settlement_at"] = datetime(2030, 8, 16, 8, tzinfo=UTC)
    scan["signals"]["tails"]["signal"] = "NO_TRADE"
    result, reasons = _build_iv_signal_eligibility(
        scan=scan,
        as_of=datetime(2030, 8, 15, 12, tzinfo=UTC),
        spot=100.0,
        snapshot_age_seconds=20.0,
        has_base_suppression=False,
    )
    assert reasons == []
    assert result.is_zero_dte is False
    assert result.directional_eligible is True
    assert result.zero_dte_eligible is False
    assert result.recommended_refresh_seconds == IV_SIGNAL_STANDARD_REFRESH_SECONDS


def test_repository_suppresses_direct_zero_dte_request_that_fails_alignment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expiry = "2030-08-15"
    chain_as_of = datetime(2030, 8, 15, 3, 55, tzinfo=UTC)
    strikes = [90.0, 95.0, 97.5, 98.5, 99.0, 101.0, 101.5, 102.5, 105.0, 110.0]
    ivs = [80.0, 70.0, 60.0, 57.0, 55.0, 45.0, 40.0, 35.0, 30.0, 25.0]
    rows = [
        _quote(
            strike,
            side,
            iv,
            expiry=expiry,
            quote_as_of=chain_as_of,
            delta=(
                (0.15 if side == "call" else -0.15)
                if strike in {90.0, 110.0}
                else None
            ),
        )
        for strike, iv in zip(strikes, ivs, strict=True)
        for side in ("call", "put")
    ]
    repository = SnapshotRepository(
        tmp_path / "unused.json",
        iv_chain_provider=StubProvider(
            _snapshot(rows=rows, as_of=chain_as_of, spot=100.0)
        ),
    )
    monkeypatch.setattr(
        SnapshotRepository,
        "_utc_now",
        staticmethod(lambda: chain_as_of + timedelta(seconds=5)),
    )

    result = repository.get_iv_signal_scan(expiry=expiry)

    assert result.model_verdict == "NO_TRADE"
    assert result.verdict == "NO_TRADE"
    assert result.eligibility.directional_eligible is False
    assert result.eligibility.zero_dte_eligible is False
    assert result.eligibility.requirements.signal_alignment is False


def test_exact_deribit_settlement_and_input_rejections() -> None:
    assert deribit_settlement(EXPIRY) == datetime(2030, 8, 16, 8, tzinfo=UTC)
    with pytest.raises(ValueError, match="ALL"):
        deribit_settlement("ALL")

    non_whole_hour_as_of = datetime(2030, 8, 15, 12, 34, 56, tzinfo=UTC)
    exact = scan_expiry_rows(
        [
            {**row, "quote_as_of": non_whole_hour_as_of}
            for row in _paired_rows()
        ],
        expiry=EXPIRY,
        spot=100.0,
        as_of=non_whole_hour_as_of,
    )
    expected_seconds = 19 * 3600 + 25 * 60 + 4
    assert exact["time_to_expiry_years"] == pytest.approx(
        expected_seconds / (365 * 24 * 3600)
    )

    with pytest.raises(ValueError, match="expired"):
        scan_expiry_rows(
            _paired_rows(),
            expiry=EXPIRY,
            spot=100.0,
            as_of=datetime(2030, 8, 16, 8, tzinfo=UTC),
        )

    with pytest.raises(ValueError, match="at least 4"):
        scan_expiry_rows(
            _paired_rows(strikes=[90, 100, 110], ivs=[50, 50, 50]),
            expiry=EXPIRY,
            spot=100.0,
            as_of=AS_OF_DT,
        )


def test_provider_uses_one_full_chain_call_and_short_cache() -> None:
    calls: list[dict[str, Any]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            result = []
            for strike in [80, 90, 100, 110]:
                for suffix in ("C", "P"):
                    result.append(
                        {
                            "instrument_name": f"BTC-16AUG30-{strike}-{suffix}",
                            "mark_iv": 50.0,
                            "bid_price": 0.01,
                            "ask_price": 0.02,
                            "creation_timestamp": int(AS_OF_DT.timestamp() * 1000),
                            "estimated_delivery_price": 100.0,
                            "underlying_price": 100.2,
                        }
                    )
            return {
                "jsonrpc": "2.0",
                "usOut": int(AS_OF_DT.timestamp() * 1_000_000),
                "result": result,
            }

    def fake_get(url: str, **kwargs: Any) -> FakeResponse:
        calls.append({"url": url, **kwargs})
        return FakeResponse()

    provider = DeribitIvChainProvider(
        http_get=fake_get,
        clock=lambda: AS_OF_DT,
        cache_seconds=10,
    )
    first = provider.fetch()
    second = provider.fetch()

    assert first is second
    assert len(calls) == 1
    assert calls[0]["url"] == DERIBIT_BOOK_SUMMARY_URL
    assert calls[0]["params"] == {"currency": "BTC", "kind": "option"}
    assert first.as_of == AS_OF_DT
    assert first.spot == 100.0
    assert len(first.rows) == 8
    assert {row["option_type"] for row in first.rows} == {"call", "put"}


def test_ticker_chain_adapter_uses_venue_timestamps_and_feed_health() -> None:
    names = tuple(
        f"BTC-16AUG30-{strike}-{suffix}"
        for strike in (80, 90, 100, 110)
        for suffix in ("C", "P")
    )
    quotes = tuple(
        DeribitTickerQuote(
            instrument_name=name,
            quote_as_of=AS_OF_DT,
            state="open",
            is_open=True,
            best_bid_price=0.01,
            best_bid_amount=1.0,
            best_ask_price=0.02,
            best_ask_amount=2.0,
            bid_iv=49.0,
            ask_iv=51.0,
            mark_iv=50.0,
            mark_price=0.015,
            index_price=100.0,
            underlying_price=100.0,
            estimated_delivery_price=100.0,
            open_interest=10.0,
            delta=None,
        )
        for name in names
    )
    snapshot = TickerStreamSnapshot(
        as_of=AS_OF_DT,
        quotes=quotes,
        source="deribit_ticker_ws",
        connection_state=ConnectionState.CONNECTED,
        connected=True,
        healthy=True,
        warmup_complete=True,
        connection_generation=3,
        universe_current=True,
        active_instrument_names=names,
        active_instrument_count=len(names),
        requested_instrument_count=len(names),
        subscribed_instrument_count=len(names),
        initialized_quote_count=len(names),
        retained_quote_count=0,
        fresh_quote_count=len(names),
        stale_quote_count=0,
        missing_quote_count=0,
        oldest_quote_age_seconds=1.0,
        last_message_at=AS_OF_DT,
        reconnect_count=2,
        last_error=None,
    )
    stream = FakeTickerStream(snapshot)
    provider = DeribitTickerIvChainProvider(
        stream=stream,  # type: ignore[arg-type]
        clock=lambda: AS_OF_DT + timedelta(seconds=1),
        warmup_timeout_seconds=0,
    )

    chain = provider.fetch(EXPIRY)

    assert chain.as_of == AS_OF_DT + timedelta(seconds=1)
    assert chain.source == "deribit_ticker_ws_incremental"
    assert chain.verified_live_quotes is True
    assert len(chain.rows) == 8
    assert chain.rows[0]["bid_size"] == 1.0
    assert chain.rows[0]["ask_size"] == 2.0
    assert chain.feed is not None
    assert chain.feed["status"] == "READY"
    assert chain.feed["connection_generation"] == 3


def test_fastapi_lifespan_owns_ticker_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = LifecycleProvider()
    repository = SnapshotRepository(
        tmp_path / "unused.json",
        iv_chain_provider=provider,  # type: ignore[arg-type]
    )
    monkeypatch.setattr(api_main, "_repository", repository)

    with TestClient(api_main.app):
        assert provider.starts == 1
        assert provider.stops == 0

    assert provider.stops == 1


def test_repository_uses_live_chain_clock_and_gates_stale_or_unverified(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = StubProvider(_snapshot())
    repository = SnapshotRepository(
        tmp_path / "unused-gex-snapshot.json",
        iv_chain_provider=provider,
    )
    monkeypatch.setattr(
        SnapshotRepository,
        "_utc_now",
        staticmethod(lambda: AS_OF_DT + timedelta(seconds=5)),
    )

    result = repository.get_iv_signal_scan(
        expiry=EXPIRY,
        tail_threshold=0.04,
        band_width=0.05,
        signal_delta=0.02,
        freshness_threshold_seconds=120,
    )
    assert result.as_of == AS_OF_DT + timedelta(seconds=5)
    assert result.time_to_expiry_years == pytest.approx(
        (20 * 3600 - 5) / (365 * 24 * 3600)
    )
    assert result.selection.source == "deribit_ticker_ws_incremental"
    assert result.selection.verified_live_quotes is True
    assert result.freshness.snapshot_age_seconds == pytest.approx(5.0)
    assert result.freshness.is_fresh is True
    assert provider.calls == 1

    stale_repository = SnapshotRepository(
        tmp_path / "unused.json",
        iv_chain_provider=StubProvider(_snapshot()),
    )
    stale = stale_repository.get_iv_signal_scan(
        expiry=EXPIRY,
        freshness_threshold_seconds=3,
    )
    assert stale.model_verdict == "NO_TRADE"
    assert stale.verdict == "NO_TRADE"
    assert stale.freshness.is_fresh is False

    unverified = scan_expiry_rows(
        _paired_rows(),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
        source="offline_fixture",
        verified_live_quotes=False,
    )
    assert unverified["verdict"] == "NO_TRADE"
    assert "unverified IV input source" in unverified["suppression_reasons"]

    non_bracketed = scan_expiry_rows(
        _paired_rows(strikes=[110, 120, 130, 140], ivs=[50, 50, 50, 50]),
        expiry=EXPIRY,
        spot=100.0,
        as_of=AS_OF_DT,
    )
    assert non_bracketed["coverage"]["spot_bracketed"] is False
    assert non_bracketed["verdict"] == "NO_TRADE"
    assert (
        "verified strikes do not bracket spot"
        in non_bracketed["suppression_reasons"]
    )


def test_api_contract_and_provider_error_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository = SnapshotRepository(
        tmp_path / "unused.json",
        iv_chain_provider=StubProvider(_snapshot()),
    )
    monkeypatch.setattr(
        SnapshotRepository,
        "_utc_now",
        staticmethod(lambda: AS_OF_DT + timedelta(seconds=5)),
    )
    app.dependency_overrides[get_repository] = lambda: repository
    client = TestClient(app)
    try:
        response = client.get(
            "/api/v1/iv-signal-scan",
            params={
                "expiry": EXPIRY,
                "tail_threshold": 0.04,
                "band_width": 0.05,
                "signal_delta": 0.02,
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["as_of"] == "2030-08-15T12:00:05Z"
        assert body["settlement_at"] == "2030-08-16T08:00:00Z"
        assert body["parameters"] == {
            "tail_threshold": 0.04,
            "band_width": 0.05,
            "signal_delta": 0.02,
        }
        assert len(body["density"]) >= 4
        assert len(body["iv_curve"]) >= 4
        assert "smile" in body
        assert body["verdict"] == "NO_TRADE"
        assert body["model_verdict"] == "NO_TRADE"
        assert body["eligibility"]["directional_eligible"] is False
        assert body["selection"]["source"] == "deribit_ticker_ws_incremental"
        assert body["feed"]["status"] == "READY"
        assert body["feed"]["transport"] == "websocket"
        assert body["curve_quality"]["level"] in {"HIGH", "CAUTION", "LOW"}
        assert set(body["signals"]) == {"skew", "tails", "peak", "band"}
        assert "model_verdict" in body
        assert "suppression_reasons" in body
        assert body["deprecated"] is True

        assert client.get(
            "/api/v1/iv-signal-scan", params={"expiry": "2030-08-17"}
        ).status_code == 404
        assert client.get(
            "/api/v1/iv-signal-scan", params={"expiry": "ALL"}
        ).status_code == 422
    finally:
        app.dependency_overrides.clear()

    unavailable = SnapshotRepository(
        tmp_path / "unused.json",
        iv_chain_provider=FailingProvider(),
    )
    app.dependency_overrides[get_repository] = lambda: unavailable
    try:
        response = TestClient(app).get(
            "/api/v1/iv-signal-scan", params={"expiry": EXPIRY}
        )
        assert response.status_code == 503
        assert "offline fixture failure" in response.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_api_maps_thin_live_book_to_service_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository = SnapshotRepository(
        tmp_path / "unused.json",
        iv_chain_provider=StubProvider(
            _snapshot(rows=_paired_rows(strikes=[90, 100, 110], ivs=[50, 50, 50]))
        ),
    )
    monkeypatch.setattr(
        SnapshotRepository,
        "_utc_now",
        staticmethod(lambda: AS_OF_DT + timedelta(seconds=5)),
    )
    app.dependency_overrides[get_repository] = lambda: repository
    try:
        response = TestClient(app).get(
            "/api/v1/iv-signal-scan",
            params={"expiry": EXPIRY, "tail_threshold": 0.02},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["verdict"] == "NO_TRADE"
        assert body["model_status"] == "rejected" or body["curve_quality"]["level"] == "LOW"
    finally:
        app.dependency_overrides.clear()
