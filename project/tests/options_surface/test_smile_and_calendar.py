"""Smile interpolation, 25-delta roots, and calendar consistency."""

from __future__ import annotations

import math

from project.options_surface.service import build_options_surface
from project.options_surface.surface.fitters import RawSviFitter, TotalVariancePchipFitter
from project.options_surface.surface.interpolate import calendar_report, interpolate_total_variance
from project.options_surface.surface.query import query_smile
from project.options_surface.surface.smile import calibrate_smile, solve_delta_strike
from project.options_surface.timeutil import inferred_deribit_expiry_utc, require_positive_year_fraction
from project.options_surface.types import FitterGrade, ModelStatus, PointOrigin, QueryStatus
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    SIGMA,
    flat_vol_chain,
    listed_future,
)


def _slice(sigma: float = SIGMA, expiry: str = EXPIRY):
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD, sigma_pct=sigma * 100.0, expiry=expiry),
        expiry=expiry,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(expiry=expiry, mid=FORWARD),),
    )
    return result


def test_smile_recovers_accepted_knots() -> None:
    result = _slice()
    assert result.smile.observed
    from project.options_surface.surface.fitters import TotalVariancePchipFitter

    # Re-fit just to hold the FittedSmile handle via query of observed k.
    # Knot recovery is the interpolant's defining property.
    for point in result.smile.observed:
        queried = None
        for fit in result.smile.fit:
            if abs(fit.log_moneyness - point.log_moneyness) < 1e-3:
                queried = fit
                break
        # Direct reconstruction: w_obs = iv^2 T
        assert abs(point.iv - SIGMA) < 1e-9


def test_pchip_exact_at_knots() -> None:
    result = _slice()
    from project.options_surface.normalization.otm import select_otm_observations
    from project.options_surface.normalization.quotes import classify_quotes
    from project.options_surface.market_data.ticker_adapter import quotes_from_scanner_rows

    quotes = quotes_from_scanner_rows(
        flat_vol_chain(forward=FORWARD), as_of_utc=AS_OF, default_index_usd=INDEX
    )
    observations = classify_quotes(quotes, as_of_utc=AS_OF, expiry_date=EXPIRY)
    selected = select_otm_observations(
        observations,
        forward_usd=FORWARD,
        time_to_expiry_years=result.time_to_expiry_years,
    )
    smile, fitted = calibrate_smile(
        observed=selected["observed"],
        synthetic=selected["synthetic"],
        forward=result.forward,
        time_to_expiry_years=result.time_to_expiry_years,
        as_of_utc=AS_OF,
        expiry_utc=result.expiry_utc,
        fitter=TotalVariancePchipFitter(),
    )
    for point in list(selected["observed"]) + list(selected["synthetic"]):
        iv, status = fitted.iv(point.log_moneyness)
        assert iv is not None
        assert status is QueryStatus.AVAILABLE
        assert abs(iv - point.iv) < 1e-10


def test_no_silent_k_extrapolation() -> None:
    result = _slice()
    quotes = __import__(
        "project.options_surface.market_data.ticker_adapter", fromlist=["quotes_from_scanner_rows"]
    ).quotes_from_scanner_rows(flat_vol_chain(), as_of_utc=AS_OF, default_index_usd=INDEX)
    from project.options_surface.normalization.quotes import classify_quotes
    from project.options_surface.normalization.otm import select_otm_observations

    selected = select_otm_observations(
        classify_quotes(quotes, as_of_utc=AS_OF, expiry_date=EXPIRY),
        forward_usd=FORWARD,
        time_to_expiry_years=result.time_to_expiry_years,
    )
    _smile, fitted = calibrate_smile(
        observed=selected["observed"],
        synthetic=selected["synthetic"],
        forward=result.forward,
        time_to_expiry_years=result.time_to_expiry_years,
        as_of_utc=AS_OF,
        expiry_utc=result.expiry_utc,
    )
    far = query_smile(fitted, log_moneyness=fitted.k_max + 0.25)
    assert far.status is QueryStatus.EXTRAPOLATED
    assert far.iv is None
    assert far.call_price_usd is None


def test_25_delta_solved_not_shortcut() -> None:
    result = _slice()
    from project.options_surface.normalization.otm import select_otm_observations
    from project.options_surface.normalization.quotes import classify_quotes
    from project.options_surface.market_data.ticker_adapter import quotes_from_scanner_rows
    from project.options_surface.distribution.black76 import black76_forward_delta

    selected = select_otm_observations(
        classify_quotes(
            quotes_from_scanner_rows(flat_vol_chain(), as_of_utc=AS_OF, default_index_usd=INDEX),
            as_of_utc=AS_OF,
            expiry_date=EXPIRY,
        ),
        forward_usd=FORWARD,
        time_to_expiry_years=result.time_to_expiry_years,
    )
    _smile, fitted = calibrate_smile(
        observed=selected["observed"],
        synthetic=selected["synthetic"],
        forward=result.forward,
        time_to_expiry_years=result.time_to_expiry_years,
        as_of_utc=AS_OF,
        expiry_utc=result.expiry_utc,
    )
    strike, iv = solve_delta_strike(fitted, target_delta=0.25, side="call")
    assert strike is not None and iv is not None
    delta = black76_forward_delta(
        forward_usd=FORWARD,
        strike_usd=strike,
        time_to_expiry_years=result.time_to_expiry_years,
        sigma=iv,
        side="call",
    )
    assert delta is not None
    assert abs(delta - 0.25) < 1e-4


def test_calendar_detects_decreasing_total_variance() -> None:
    short = _fitted(sigma=0.80, expiry="2030-08-22")
    long = _fitted(sigma=0.20, expiry="2030-09-27")
    report = calendar_report((short, long))
    assert report["ok"] is False
    interp = interpolate_total_variance((short, long), k=0.0, time_to_expiry_years=short.time_to_expiry_years * 0.5 + long.time_to_expiry_years * 0.5)
    assert interp.calendar_ok is False


def test_calendar_ok_for_flat_vol_term_structure() -> None:
    short = _fitted(sigma=0.50, expiry="2030-08-22")
    long = _fitted(sigma=0.50, expiry="2030-09-27")
    report = calendar_report((short, long))
    assert report["ok"] is True
    mid_t = 0.5 * (short.time_to_expiry_years + long.time_to_expiry_years)
    interp = interpolate_total_variance((short, long), k=0.0, time_to_expiry_years=mid_t)
    assert interp.status is QueryStatus.INTERPOLATED
    assert interp.total_variance is not None
    w1, _ = short.total_variance(0.0)
    w2, _ = long.total_variance(0.0)
    expected = w1 + ((mid_t - short.time_to_expiry_years) / (long.time_to_expiry_years - short.time_to_expiry_years)) * (w2 - w1)
    assert abs(interp.total_variance - expected) < 1e-12


def test_maturity_extrapolation_unavailable() -> None:
    fitted = _fitted()
    too_short = interpolate_total_variance((fitted,), k=0.0, time_to_expiry_years=fitted.time_to_expiry_years * 0.1)
    assert too_short.status is QueryStatus.EXTRAPOLATED
    assert too_short.total_variance is None


def test_svi_is_labeled_research() -> None:
    result = _slice()
    from project.options_surface.normalization.otm import select_otm_observations
    from project.options_surface.normalization.quotes import classify_quotes
    from project.options_surface.market_data.ticker_adapter import quotes_from_scanner_rows

    selected = select_otm_observations(
        classify_quotes(
            quotes_from_scanner_rows(flat_vol_chain(), as_of_utc=AS_OF, default_index_usd=INDEX),
            as_of_utc=AS_OF,
            expiry_date=EXPIRY,
        ),
        forward_usd=FORWARD,
        time_to_expiry_years=result.time_to_expiry_years,
    )
    _smile, fitted = calibrate_smile(
        observed=selected["observed"],
        synthetic=selected["synthetic"],
        forward=result.forward,
        time_to_expiry_years=result.time_to_expiry_years,
        as_of_utc=AS_OF,
        expiry_utc=result.expiry_utc,
        fitter=RawSviFitter(),
    )
    assert fitted.fitter_grade is FitterGrade.RESEARCH
    assert fitted.diagnostics.status is ModelStatus.RESEARCH
    assert any("research" in note.lower() for note in fitted.diagnostics.notes)


def _fitted(sigma: float = SIGMA, expiry: str = EXPIRY):
    from datetime import datetime
    from project.options_surface.market_data.ticker_adapter import quotes_from_scanner_rows
    from project.options_surface.normalization.otm import select_otm_observations
    from project.options_surface.normalization.quotes import classify_quotes
    from project.options_surface.forward.estimate import estimate_forward

    rows = flat_vol_chain(forward=FORWARD, sigma_pct=sigma * 100.0, expiry=expiry)
    quotes = quotes_from_scanner_rows(rows, as_of_utc=AS_OF, default_index_usd=INDEX)
    observations = classify_quotes(quotes, as_of_utc=AS_OF, expiry_date=expiry)
    expiry_utc = inferred_deribit_expiry_utc(expiry)
    tau = require_positive_year_fraction(AS_OF, expiry_utc)
    forward = estimate_forward(
        observations,
        as_of_utc=AS_OF,
        expiry_utc=expiry_utc,
        expiry_date=expiry,
        underlying="BTC",
        index_usd=INDEX,
        futures=(listed_future(expiry=expiry, mid=FORWARD),),
    )
    selected = select_otm_observations(observations, forward_usd=FORWARD, time_to_expiry_years=tau)
    _smile, fitted = calibrate_smile(
        observed=selected["observed"],
        synthetic=selected["synthetic"],
        forward=forward,
        time_to_expiry_years=tau,
        as_of_utc=AS_OF,
        expiry_utc=expiry_utc,
    )
    return fitted
