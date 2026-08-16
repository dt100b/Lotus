"""Mandatory Black-76 / Breeden–Litzenberger numerical tests."""

from __future__ import annotations

import math

import numpy as np
from scipy.integrate import trapezoid
from scipy.stats import lognorm, norm

from project.options_surface.distribution.black76 import (
    black76_call,
    black76_digital_call,
    lognormal_density,
)
from project.options_surface.distribution.density import extract_density
from project.options_surface.surface.arbitrage import diagnose_slice_arbitrage
from project.options_surface.timeutil import require_positive_year_fraction
from project.options_surface.types import ModelStatus
from project.tests.options_surface.support import AS_OF, EXPIRY, FORWARD, SIGMA

from project.options_surface.timeutil import inferred_deribit_expiry_utc


def _tau() -> float:
    return require_positive_year_fraction(AS_OF, inferred_deribit_expiry_utc(EXPIRY))


def _flat_iv(_strike: float) -> float:
    return SIGMA


def _density(grid: int = 401):
    return extract_density(
        iv_from_strike=_flat_iv,
        forward_usd=FORWARD,
        time_to_expiry_years=_tau(),
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        k_min=-1.2,
        k_max=1.2,
        grid_points=grid,
        compare_grid_points=201 if grid != 201 else 301,
    )


def test_flat_vol_density_recovers_lognormal() -> None:
    result = _density()
    strikes = np.asarray(result.strikes_usd)
    raw = np.asarray(result.raw_density)
    assert result.status in {ModelStatus.ACCEPTED, ModelStatus.DEGRADED}
    assert result.validation.mass is not None
    assert abs(result.validation.mass - 1.0) < 0.03
    assert result.validation.raw_negative_mass < 0.01
    assert result.validation.forward_moment is not None
    assert abs(result.validation.forward_moment - FORWARD) / FORWARD < 0.02
    analytical = np.asarray(
        [lognormal_density(float(k), forward_usd=FORWARD, time_to_expiry_years=_tau(), sigma=SIGMA) for k in strikes]
    )
    # Interior agreement: ignore the last few edge points.
    interior = slice(40, -40)
    rel = np.max(np.abs(raw[interior] - analytical[interior]) / np.maximum(analytical[interior], 1e-12))
    assert rel < 0.12


def test_flat_vol_quantiles_match_lognormal() -> None:
    result = _density()
    assert result.quantiles
    tau = _tau()
    # S ~ lognormal; ln S ~ N(ln F - 0.5 s^2 T, s^2 T)
    mu = math.log(FORWARD) - 0.5 * SIGMA**2 * tau
    scale = SIGMA * math.sqrt(tau)
    for key, level in (("p05", 0.05), ("p25", 0.25), ("p50", 0.50), ("p75", 0.75), ("p95", 0.95)):
        expected = math.exp(mu + scale * float(norm.ppf(level)))
        assert abs(result.quantiles[key] - expected) / expected < 0.03


def test_strike_monotonicity_and_convexity() -> None:
    tau = _tau()
    strikes = np.linspace(FORWARD * 0.4, FORWARD * 2.2, 81)
    calls = [
        black76_call(
            forward_usd=FORWARD,
            strike_usd=float(strike),
            time_to_expiry_years=tau,
            sigma=SIGMA,
        )
        for strike in strikes
    ]
    report = diagnose_slice_arbitrage(
        strikes_usd=strikes,
        call_prices=calls,
        total_variances=[SIGMA**2 * tau] * len(strikes),
        forward_usd=FORWARD,
        time_to_expiry_years=tau,
    )
    assert report.call_monotone
    assert report.call_convex
    assert report.butterfly_ok
    assert report.positive_variance
    for i in range(len(calls) - 1):
        assert calls[i + 1] <= calls[i] + 1e-10
    for i in range(1, len(calls) - 1):
        assert calls[i - 1] - 2.0 * calls[i] + calls[i + 1] >= -1e-8


def test_density_mass_and_forward_moment() -> None:
    result = _density()
    strikes = np.asarray(result.strikes_usd)
    raw = np.asarray(result.raw_density)
    mass = float(trapezoid(raw, strikes))
    moment = float(trapezoid(strikes * raw, strikes))
    assert abs(mass - 1.0) < 0.03
    assert abs(moment - FORWARD) / FORWARD < 0.02


def test_cdf_monotone_and_bounded() -> None:
    result = _density()
    cdf = np.asarray(result.cdf)
    assert cdf[0] < 0.05
    assert cdf[-1] > 0.95
    assert np.all(np.diff(cdf) >= -1e-8)
    assert float(np.min(cdf)) >= -1e-8
    assert float(np.max(cdf)) <= 1.0 + 1e-8


def test_digital_reconciliation_atm_and_wings() -> None:
    tau = _tau()
    result = _density()
    strikes = np.asarray(result.strikes_usd)
    raw = np.asarray(result.raw_density)
    pos = np.clip(raw, 0.0, None)
    area = float(trapezoid(pos, strikes))

    from project.options_surface.distribution.density import survival_probability

    def p_above(level: float) -> float:
        return survival_probability(strikes, raw, level)

    def spread_digital(level: float) -> float:
        h = 0.002 * FORWARD
        c_lo = black76_call(forward_usd=FORWARD, strike_usd=level - h, time_to_expiry_years=tau, sigma=SIGMA)
        c_hi = black76_call(forward_usd=FORWARD, strike_usd=level + h, time_to_expiry_years=tau, sigma=SIGMA)
        return (c_lo - c_hi) / (2.0 * h)

    levels = {
        "atm": FORWARD,
        "25d": _delta_strike(0.25, tau),
        "10d": _delta_strike(0.10, tau),
        "left_wing": FORWARD * math.exp(-0.6),
        "right_wing": FORWARD * math.exp(0.6),
    }
    for name, level in levels.items():
        err = abs(p_above(level) - spread_digital(level))
        assert err < 0.03, f"{name} digital error {err}"


def test_grid_convergence() -> None:
    coarse = _density(201)
    fine = _density(401)
    assert coarse.quantiles and fine.quantiles
    rel = abs(fine.quantiles["p50"] - coarse.quantiles["p50"]) / fine.quantiles["p50"]
    assert rel < 0.005
    assert fine.validation.grid_converged is True


def test_rejected_density_has_no_headline_quantiles() -> None:
    def bad_iv(strike: float) -> float:
        # Pathological: IV collapses then explodes so second derivative goes negative.
        k = math.log(strike / FORWARD)
        return max(0.05, 0.50 + 4.0 * k)

    result = extract_density(
        iv_from_strike=bad_iv,
        forward_usd=FORWARD,
        time_to_expiry_years=_tau(),
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        k_min=-0.4,
        k_max=0.4,
        grid_points=81,
        compare_grid_points=41,
    )
    if result.status is ModelStatus.REJECTED:
        assert result.quantiles == {}
        assert result.mean is None


def _delta_strike(call_delta: float, tau: float) -> float:
    # Flat-vol Black-76: N(d1) = delta ⇒ d1 = N^{-1}(delta)
    d1 = float(norm.ppf(call_delta))
    return FORWARD * math.exp(-d1 * SIGMA * math.sqrt(tau) + 0.5 * SIGMA**2 * tau)
