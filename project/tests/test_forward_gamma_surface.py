"""Unit tests for 0DTE forward gamma surface projection."""

from __future__ import annotations

import math

import pytest

from pipeline.forward_gamma_surface import (
    build_forward_gamma_surface,
    bs_delta,
    bs_gamma,
    bs_vanna,
    extract_0dte_legs,
    normalize_mark_iv,
    select_front_0dte_expiry,
    select_forward_expiry,
    settle_ms_from_expiry,
)


def test_normalize_mark_iv_percent_and_decimal() -> None:
    assert normalize_mark_iv(55.0) == 0.55
    assert normalize_mark_iv(0.55) == 0.55
    assert normalize_mark_iv(0) is None
    assert normalize_mark_iv(None) is None


def test_settle_ms_from_expiry() -> None:
    ms = settle_ms_from_expiry("2026-07-31")
    assert ms is not None
    # 08:00 UTC
    assert ms % 86_400_000 == 8 * 3600 * 1000


def test_bs_gamma_peaks_near_atm() -> None:
    spot = 100.0
    iv = 0.5
    tau = 1 / 365.25  # ~1d
    atm = bs_gamma(spot=spot, strike=100.0, t_years=tau, iv=iv)
    wing = bs_gamma(spot=spot, strike=130.0, t_years=tau, iv=iv)
    assert atm is not None and wing is not None
    assert atm > wing


def test_bs_vanna_matches_delta_volatility_finite_difference() -> None:
    params = {"spot": 100.0, "strike": 105.0, "t_years": 0.25}
    iv = 0.55
    bump = 1e-5
    analytic = bs_vanna(**params, iv=iv)
    up = bs_delta(**params, iv=iv + bump, option_type="call")
    down = bs_delta(**params, iv=iv - bump, option_type="call")
    assert analytic is not None and up is not None and down is not None
    numeric = (up - down) / (2 * bump)
    assert analytic == pytest.approx(numeric, rel=1e-7, abs=1e-9)


def test_forward_surface_grid_shape_and_monotonic_time() -> None:
    rows = [
        {
            "expiry": "2026-07-31",
            "strike": 65000.0,
            "call_gex": -2_000_000.0,
            "put_gex": 1_500_000.0,
            "call_mark_iv": 45.0,
            "put_mark_iv": 48.0,
            "mark_iv": 46.0,
        },
        {
            "expiry": "2026-07-31",
            "strike": 66000.0,
            "call_gex": 3_000_000.0,
            "put_gex": -500_000.0,
            "call_mark_iv": 40.0,
            "put_mark_iv": 42.0,
            "mark_iv": 41.0,
        },
        {
            "expiry": "2026-08-28",
            "strike": 65000.0,
            "call_gex": 9_000_000.0,
            "put_gex": -1_000_000.0,
            "mark_iv": 50.0,
        },
    ]
    # Mid-session before 2026-07-31 08:00 UTC settle.
    as_of_ms = 1_785_430_000_000  # ~2026-07-30 something
    surface = build_forward_gamma_surface(
        rows,
        spot=65500.0,
        as_of_ms=as_of_ms,
        front_expiry="2026-07-31",
        n_times=16,
        n_prices=32,
        price_window_pct=6.0,
    )
    assert surface.expiry == "2026-07-31"
    assert len(surface.times_ms) == 16
    assert len(surface.prices) == 32
    assert len(surface.values) == 16
    assert all(len(col) == 32 for col in surface.values)
    assert surface.times_ms[0] < surface.times_ms[-1]
    assert surface.prices[0] < surface.prices[-1]
    # Only 0DTE legs — monthly excluded.
    assert surface.meta["leg_count"] == 4
    # Finite values
    flat = [v for col in surface.values for v in col]
    assert all(math.isfinite(v) for v in flat)
    assert any(abs(v) > 0 for v in flat)


def test_extract_0dte_legs_skips_other_expiries() -> None:
    rows = [
        {
            "expiry": "2026-07-31",
            "strike": 65000.0,
            "call_gex": 1.0,
            "put_gex": 0.0,
            "mark_iv": 50.0,
        },
        {
            "expiry": "2026-08-01",
            "strike": 65000.0,
            "call_gex": 99.0,
            "put_gex": 0.0,
            "mark_iv": 50.0,
        },
    ]
    legs = extract_0dte_legs(rows, front_expiry="2026-07-31")
    assert len(legs) == 1
    assert legs[0].gex0 == 1.0


def test_select_front_0dte_nearest_unexpired() -> None:
    # as_of just after 2026-07-30 08:00 UTC → front should be 2026-07-31, not Aug 1.
    as_of = 1_785_430_000_000
    front = select_front_0dte_expiry(
        ["2026-08-01", "2026-07-31", "2026-08-28"],
        now_ms=as_of,
    )
    assert front == "2026-07-31"


def test_select_forward_expiry_scopes_are_single_clean_cliffs() -> None:
    as_of = settle_ms_from_expiry("2026-08-02")
    assert as_of is not None
    as_of -= 60_000
    expiries = [
        "2026-08-02",
        "2026-08-03",
        "2026-08-07",
        "2026-08-14",
        "2026-08-28",
        "2026-09-25",
    ]
    assert select_forward_expiry(expiries, now_ms=as_of, scope="0dte") == "2026-08-02"
    assert select_forward_expiry(expiries, now_ms=as_of, scope="eow") == "2026-08-07"
    assert select_forward_expiry(expiries, now_ms=as_of, scope="eom") == "2026-08-28"


def test_build_picks_nearest_live_when_front_stale() -> None:
    rows = [
        {
            "expiry": "2026-07-30",  # already settled relative to as_of below
            "strike": 65000.0,
            "call_gex": -1_000_000.0,
            "put_gex": 500_000.0,
            "call_mark_iv": 45.0,
            "put_mark_iv": 48.0,
        },
        {
            "expiry": "2026-07-31",
            "strike": 65000.0,
            "call_gex": -2_000_000.0,
            "put_gex": 1_500_000.0,
            "call_mark_iv": 45.0,
            "put_mark_iv": 48.0,
        },
        {
            "expiry": "2026-08-01",
            "strike": 65000.0,
            "call_gex": -9_000_000.0,
            "put_gex": 1_000_000.0,
            "call_mark_iv": 40.0,
            "put_mark_iv": 42.0,
        },
    ]
    # After 2026-07-30 08:00 UTC settle; before 2026-07-31 08:00.
    as_of_ms = settle_ms_from_expiry("2026-07-30")
    assert as_of_ms is not None
    as_of_ms += 60_000
    surface = build_forward_gamma_surface(
        rows,
        spot=65500.0,
        as_of_ms=as_of_ms,
        front_expiry="2026-07-30",  # stale — must roll to 07-31
        n_times=12,
        n_prices=16,
    )
    assert surface.expiry == "2026-07-31"
    assert surface.meta.get("tau0_hours", 99) < 24


def test_empty_when_settled() -> None:
    rows = [
        {
            "expiry": "2020-01-01",
            "strike": 10000.0,
            "call_gex": 1.0,
            "put_gex": 0.0,
            "mark_iv": 50.0,
        }
    ]
    surface = build_forward_gamma_surface(
        rows,
        spot=10000.0,
        as_of_ms=1_700_000_000_000,
        front_expiry="2020-01-01",
    )
    assert surface.times_ms == []
    assert "settled" in surface.meta["note"].lower() or surface.meta["leg_count"] == 0


def test_all_forward_metrics_are_finite_and_identified() -> None:
    rows = [
        {
            "expiry": "2026-07-31",
            "strike": 65000.0,
            "call_gex": 2_000_000.0,
            "put_gex": -500_000.0,
            "call_mark_iv": 40.0,
            "put_mark_iv": 42.0,
        }
    ]
    as_of_ms = settle_ms_from_expiry("2026-07-31")
    assert as_of_ms is not None
    as_of_ms -= 8 * 3600_000

    for metric in ("gamma", "delta", "delta_change", "charm", "vanna"):
        surface = build_forward_gamma_surface(
            rows,
            spot=65000.0,
            as_of_ms=as_of_ms,
            front_expiry="2026-07-31",
            n_times=12,
            n_prices=33,
            metric=metric,
        )
        flat = [value for col in surface.values for value in col]
        assert flat and all(math.isfinite(value) for value in flat)
        assert surface.meta["metric"] == metric
        assert surface.meta["positioning_source"] == "flow"
        assert surface.meta["unit"]

        if metric == "delta_change":
            spot_idx = min(
                range(len(surface.prices)),
                key=lambda idx: abs(surface.prices[idx] - surface.spot),
            )
            assert surface.values[0][spot_idx] == pytest.approx(0.0, abs=1e-7)


def test_iv_shift_changes_field_but_not_recovered_flow_position() -> None:
    rows = [
        {
            "expiry": "2026-07-31",
            "strike": 65000.0,
            "call_gex": 2_000_000.0,
            "put_gex": 0.0,
            "call_mark_iv": 40.0,
        }
    ]
    as_of_ms = settle_ms_from_expiry("2026-07-31")
    assert as_of_ms is not None
    as_of_ms -= 8 * 3600_000
    base = build_forward_gamma_surface(
        rows,
        spot=65000.0,
        as_of_ms=as_of_ms,
        front_expiry="2026-07-31",
        n_times=8,
        n_prices=33,
        iv_shift=0.0,
    )
    shocked = build_forward_gamma_surface(
        rows,
        spot=65000.0,
        as_of_ms=as_of_ms,
        front_expiry="2026-07-31",
        n_times=8,
        n_prices=33,
        iv_shift=1.0,
    )
    spot_idx = min(
        range(len(base.prices)), key=lambda idx: abs(base.prices[idx] - base.spot)
    )
    assert base.values[0][spot_idx] == pytest.approx(2_000_000.0, rel=1e-9)
    assert shocked.values[0][spot_idx] != pytest.approx(base.values[0][spot_idx])
    assert shocked.meta["iv_shift"] == 1.0


def test_direct_flow_positions_are_preferred_over_gex_inversion() -> None:
    rows = [
        {
            "expiry": "2026-07-31",
            "strike": 65000.0,
            # Deliberately inconsistent with the direct position.  The v3
            # projection must use the ledger position when supplied.
            "call_gex": 1.0,
            "put_gex": 0.0,
            "call_position_units": 125.0,
            "call_flow_iv": 40.0,
        }
    ]
    settle_ms = settle_ms_from_expiry("2026-07-31")
    assert settle_ms is not None
    surface = build_forward_gamma_surface(
        rows,
        spot=65000.0,
        as_of_ms=settle_ms - 8 * 3600_000,
        front_expiry="2026-07-31",
        n_times=12,
        n_prices=33,
    )
    spot_idx = min(
        range(len(surface.prices)),
        key=lambda idx: abs(surface.prices[idx] - surface.spot),
    )
    assert abs(surface.values[0][spot_idx]) > 1_000.0
    assert surface.meta["position_recovery"] == "direct_flow_positions"
    assert surface.meta["direct_position_leg_count"] == 1
    assert surface.meta["reference_gex_coverage"] == pytest.approx(1.0)


def test_forward_time_grid_has_more_resolution_near_settle() -> None:
    rows = [
        {
            "expiry": "2026-07-31",
            "strike": 65000.0,
            "call_gex": 2_000_000.0,
            "put_gex": 0.0,
            "call_mark_iv": 40.0,
        }
    ]
    settle_ms = settle_ms_from_expiry("2026-07-31")
    assert settle_ms is not None
    surface = build_forward_gamma_surface(
        rows,
        spot=65000.0,
        as_of_ms=settle_ms - 8 * 3600_000,
        front_expiry="2026-07-31",
        n_times=24,
        n_prices=33,
    )
    gaps = [b - a for a, b in zip(surface.times_ms, surface.times_ms[1:])]
    assert all(gap > 0 for gap in gaps)
    assert gaps[-1] < gaps[0]
