"""Per-expiry smile calibration and 25-delta root finding."""

from __future__ import annotations

import math
from typing import Sequence

from scipy.optimize import brentq

from project.options_surface.distribution.black76 import black76_forward_delta
from project.options_surface.surface.arbitrage import diagnose_slice_arbitrage
from project.options_surface.surface.fitters import (
    FittedSmile,
    SmileFitter,
    TotalVariancePchipFitter,
)
from project.options_surface.types import (
    ArbitrageReport,
    ForwardEstimate,
    ModelStatus,
    PointOrigin,
    SmileFitDiagnostics,
    SmilePoint,
    SmileSlice,
)

FIT_GRID = 81


def calibrate_smile(
    *,
    observed: Sequence[SmilePoint],
    synthetic: Sequence[SmilePoint],
    forward: ForwardEstimate,
    time_to_expiry_years: float,
    as_of_utc,
    expiry_utc,
    fitter: SmileFitter | None = None,
    rate: float = 0.0,
) -> tuple[SmileSlice, FittedSmile]:
    engine = fitter or TotalVariancePchipFitter()
    train = list(observed) + list(synthetic)
    fitted_model = engine.fit(
        train,
        time_to_expiry_years=time_to_expiry_years,
        forward_usd=float(forward.forward_usd or 0.0),
    )
    fit_points = _dense_fit_points(fitted_model, rate=rate)
    arb = _arbitrage_for_fit(fitted_model, rate=rate)
    status = fitted_model.diagnostics.status
    if status is ModelStatus.RESEARCH:
        notes = fitted_model.diagnostics.notes + arb.violations
        fitted_model = _with_notes(fitted_model, notes, ModelStatus.RESEARCH)
    elif status is not ModelStatus.REJECTED and not (
        arb.positive_variance and arb.call_monotone and arb.call_convex
    ):
        notes = fitted_model.diagnostics.notes + arb.violations
        fitted_model = _with_notes(fitted_model, notes, ModelStatus.DEGRADED)
        status = ModelStatus.DEGRADED
    slice_ = SmileSlice(
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        underlying=forward.underlying,
        forward=forward,
        time_to_expiry_years=time_to_expiry_years,
        observed=tuple(observed),
        synthetic=tuple(synthetic),
        fit=tuple(fit_points),
        diagnostics=fitted_model.diagnostics,
        arbitrage=arb,
    )
    return slice_, fitted_model


def solve_delta_strike(
    fitted: FittedSmile,
    *,
    target_delta: float,
    side: str,
    rate: float = 0.0,
) -> tuple[float | None, float | None]:
    """Numerically solve the model forward-delta equation for K. Returns (K, iv)."""
    if fitted.diagnostics.status is ModelStatus.REJECTED or not fitted.knot_k:
        return None, None
    forward = fitted.forward_usd
    t = fitted.time_to_expiry_years

    def delta_at(strike: float) -> float | None:
        if strike <= 0:
            return None
        k = math.log(strike / forward)
        iv, status = fitted.iv(k)
        if iv is None:
            return None
        return black76_forward_delta(
            forward_usd=forward,
            strike_usd=strike,
            time_to_expiry_years=t,
            rate=rate,
            sigma=iv,
            side=side,
        )

    lo = forward * math.exp(fitted.k_min)
    hi = forward * math.exp(fitted.k_max)
    if lo <= 0 or hi <= lo:
        return None, None
    d_lo = delta_at(lo)
    d_hi = delta_at(hi)
    if d_lo is None or d_hi is None:
        return None, None
    # Call delta decreases in K; put delta (negative) also increases toward 0 as K rises.
    if (d_lo - target_delta) * (d_hi - target_delta) > 0:
        return None, None

    def objective(strike: float) -> float:
        value = delta_at(strike)
        if value is None:
            raise ValueError("delta undefined")
        return value - target_delta

    try:
        strike = float(brentq(objective, lo, hi, xtol=1e-6, maxiter=80))
    except (ValueError, RuntimeError):
        return None, None
    iv, _status = fitted.iv(math.log(strike / forward))
    return strike, iv


def _dense_fit_points(fitted: FittedSmile, *, rate: float) -> list[SmilePoint]:
    if fitted.diagnostics.status is ModelStatus.REJECTED or not fitted.knot_k:
        return []
    points: list[SmilePoint] = []
    if fitted.k_max <= fitted.k_min:
        return points
    for i in range(FIT_GRID):
        k = fitted.k_min + (fitted.k_max - fitted.k_min) * i / (FIT_GRID - 1)
        iv, status = fitted.iv(k)
        if iv is None:
            continue
        strike = fitted.forward_usd * math.exp(k)
        side = "put" if k < 0 else "call"
        delta = black76_forward_delta(
            forward_usd=fitted.forward_usd,
            strike_usd=strike,
            time_to_expiry_years=fitted.time_to_expiry_years,
            rate=rate,
            sigma=iv,
            side=side,
        )
        origin = (
            PointOrigin.FITTED
            if status.value in {"available", "interpolated"}
            else PointOrigin.EXTRAPOLATED
        )
        points.append(
            SmilePoint(
                strike_usd=float(strike),
                log_moneyness=float(k),
                iv=float(iv),
                total_variance=float(iv * iv * fitted.time_to_expiry_years),
                origin=origin,
                option_side=side,
                classification="fit",
                bid_iv=None,
                ask_iv=None,
                mark_iv=None,
                quote_age_seconds=None,
                fit_weight=1.0,
                source=fitted.fitter_name,
                forward_delta=delta,
            )
        )
    return points


def _arbitrage_for_fit(fitted: FittedSmile, *, rate: float) -> ArbitrageReport:
    if not fitted.knot_k:
        return ArbitrageReport(
            positive_variance=False,
            call_monotone=False,
            call_convex=False,
            butterfly_ok=False,
            calendar_ok=None,
            min_total_variance=None,
            min_call_step=None,
            min_butterfly=None,
            min_calendar_dw=None,
            violations=("no_fit",),
        )
    n = 61
    ks = [
        fitted.k_min + (fitted.k_max - fitted.k_min) * i / (n - 1)
        for i in range(n)
    ]
    strikes = [fitted.forward_usd * math.exp(k) for k in ks]
    tw: list[float] = []
    for k in ks:
        w, _status = fitted.total_variance(k)
        tw.append(float("nan") if w is None else w)

    def iv_from_k(k: float) -> float | None:
        iv, _status = fitted.iv(k)
        return iv

    return diagnose_slice_arbitrage(
        strikes_usd=strikes,
        total_variances=tw,
        forward_usd=fitted.forward_usd,
        time_to_expiry_years=fitted.time_to_expiry_years,
        iv_from_k=iv_from_k,
        rate=rate,
    )


def _with_notes(fitted: FittedSmile, notes: tuple[str, ...], status: ModelStatus) -> FittedSmile:
    diagnostics = SmileFitDiagnostics(
        fitter_name=fitted.diagnostics.fitter_name,
        fitter_grade=fitted.diagnostics.fitter_grade,
        status=status,
        residual_rms=fitted.diagnostics.residual_rms,
        weighted_residual_rms=fitted.diagnostics.weighted_residual_rms,
        optimizer_status=fitted.diagnostics.optimizer_status,
        parameter_count=fitted.diagnostics.parameter_count,
        parameters=fitted.diagnostics.parameters,
        observation_count=fitted.diagnostics.observation_count,
        k_min=fitted.diagnostics.k_min,
        k_max=fitted.diagnostics.k_max,
        extrapolated=fitted.diagnostics.extrapolated,
        notes=notes,
    )
    return FittedSmile(
        fitter_name=fitted.fitter_name,
        fitter_grade=fitted.fitter_grade,
        diagnostics=diagnostics,
        k_min=fitted.k_min,
        k_max=fitted.k_max,
        time_to_expiry_years=fitted.time_to_expiry_years,
        forward_usd=fitted.forward_usd,
        knot_k=fitted.knot_k,
        knot_w=fitted.knot_w,
        parameters=fitted.parameters,
        _evaluate_w=fitted._evaluate_w,
    )
