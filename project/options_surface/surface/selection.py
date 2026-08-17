"""Transparent serving-candidate selection.

constrained_svi is the only density-serving candidate in this pass.
tv_pchip and svi_raw are evaluated for diagnostics and cannot be
selected, even if they happen to pass serving gates.
"""

from __future__ import annotations

import math
from typing import Sequence

from project.options_surface.surface.arbitrage import diagnose_slice_arbitrage
from project.options_surface.surface.constrained_svi import (
    SERVING_GRID,
    ConstrainedSviFitter,
    SmileFitResult,
    residual_budget,
)
from project.options_surface.surface.fitters import (
    FittedSmile,
    RawSviFitter,
    SmileFitter,
    TotalVariancePchipFitter,
    _usable_points,
)
from project.options_surface.types import (
    CandidateComparison,
    FitterGrade,
    ModelStatus,
    PointResidual,
    ResidualSummary,
    SmilePoint,
)

SELECTION_NO_FALLBACK = "constrained_svi_not_eligible_no_pchip_fallback"
SELECTION_SELECTED = "selected_constrained_svi_diagnostic_candidate"
SELECTION_EXPLICIT = "explicit_fitter_override"


def select_serving_candidate(
    points: Sequence[SmilePoint],
    *,
    time_to_expiry_years: float,
    forward_usd: float,
    sparse: bool,
    serving_fitter: SmileFitter | None = None,
) -> tuple[SmileFitter, str, tuple[CandidateComparison, ...], SmileFitResult | None]:
    """Return (fitter_to_calibrate, selection_reason, comparison, constrained_result).

    The returned fitter is always the serving candidate that the orchestrator
    should calibrate. It is never silently swapped to PCHIP.
    """
    constrained = ConstrainedSviFitter()
    constrained_result = constrained.fit_result(
        points,
        time_to_expiry_years=time_to_expiry_years,
        forward_usd=forward_usd,
    )
    pchip = TotalVariancePchipFitter().fit(
        points,
        time_to_expiry_years=time_to_expiry_years,
        forward_usd=forward_usd,
    )
    raw_svi = RawSviFitter().fit(
        points,
        time_to_expiry_years=time_to_expiry_years,
        forward_usd=forward_usd,
    )
    pchip_row = compare_fitted(
        pchip,
        points=points,
        time_to_expiry_years=time_to_expiry_years,
        forward_usd=forward_usd,
        selected=False,
        extra_reasons=("diagnostic_baseline_not_selectable",),
    )
    svi_row = compare_fitted(
        raw_svi,
        points=points,
        time_to_expiry_years=time_to_expiry_years,
        forward_usd=forward_usd,
        selected=False,
        extra_reasons=("research_not_selectable",),
    )
    eligible = _constrained_eligible(constrained_result, sparse=sparse)
    constrained_row = _compare_constrained(
        constrained_result,
        selected=eligible and serving_fitter is None,
        sparse=sparse,
    )
    if serving_fitter is not None:
        reason = SELECTION_EXPLICIT
        selected_name = serving_fitter.name
        comparison = _mark_selected(
            (constrained_row, pchip_row, svi_row),
            selected_name,
        )
        return serving_fitter, reason, comparison, constrained_result
    if eligible:
        comparison = (constrained_row, pchip_row, svi_row)
        return constrained, SELECTION_SELECTED, comparison, constrained_result
    comparison = (
        _compare_constrained(constrained_result, selected=False, sparse=sparse),
        pchip_row,
        svi_row,
    )
    return constrained, SELECTION_NO_FALLBACK, comparison, constrained_result


def compare_fitted(
    fitted: FittedSmile,
    *,
    points: Sequence[SmilePoint],
    time_to_expiry_years: float,
    forward_usd: float,
    selected: bool,
    extra_reasons: tuple[str, ...] = (),
) -> CandidateComparison:
    serving = evaluate_fitted_call_curve(
        fitted,
        forward_usd=forward_usd,
        time_to_expiry_years=time_to_expiry_years,
    )
    residual = residuals_for_fitted(fitted, points, time_to_expiry_years)
    budget_ok = None
    if residual.point_residuals:
        atm_iv, _status = fitted.iv(0.0)
        spreads = _half_spreads(points)
        weights = [item.weight for item in residual.point_residuals]
        from project.options_surface.surface.constrained_svi import ConstrainedSviConfig

        budget_ok, _budget, _rms = residual_budget(
            residuals=residual.point_residuals,
            atm_iv=atm_iv,
            half_spreads=spreads,
            weights=weights,
            cfg=ConstrainedSviConfig(),
        )
    reasons = list(fitted.diagnostics.notes)
    if serving["violations"]:
        reasons.extend(str(item) for item in serving["violations"])
    reasons.extend(extra_reasons)
    return CandidateComparison(
        fitter_name=fitted.fitter_name,
        fitter_grade=fitted.fitter_grade,
        status=fitted.diagnostics.status,
        converged=fitted.diagnostics.status is not ModelStatus.REJECTED,
        residual_rms=fitted.diagnostics.residual_rms,
        weighted_residual_rms=fitted.diagnostics.weighted_residual_rms,
        max_abs_residual=residual.summary.max_abs,
        k_min=fitted.diagnostics.k_min,
        k_max=fitted.diagnostics.k_max,
        call_monotone=serving["call_monotone"] if fitted.knot_k else None,
        call_convex=serving["call_convex"] if fitted.knot_k else None,
        min_butterfly=serving["min_butterfly"] if isinstance(serving["min_butterfly"], (int, float)) else None,
        density_status=None,
        residual_budget_ok=budget_ok,
        selected=selected,
        reason_codes=tuple(dict.fromkeys(reasons)),
        notes=fitted.diagnostics.notes,
        eligible_for_density=False,
    )


def evaluate_fitted_call_curve(
    fitted: FittedSmile,
    *,
    forward_usd: float,
    time_to_expiry_years: float,
    grid_points: int = SERVING_GRID,
    rate: float = 0.0,
) -> dict[str, object]:
    if not fitted.knot_k or fitted.k_max <= fitted.k_min or forward_usd <= 0:
        return {
            "call_monotone": False,
            "call_convex": False,
            "min_butterfly": None,
            "min_call_step": None,
            "worst_convexity_strike": None,
            "grid_points": int(grid_points),
            "violations": ("no_fit",),
        }
    strike_lo = float(forward_usd) * math.exp(float(fitted.k_min))
    strike_hi = float(forward_usd) * math.exp(float(fitted.k_max))
    step = (strike_hi - strike_lo) / max(int(grid_points) - 1, 1)
    strikes = [strike_lo + step * i for i in range(int(grid_points))]
    prices: list[float] = []
    for strike in strikes:
        price = fitted.call_price(strike, rate=rate)
        prices.append(float("nan") if price is None else price)
    report = diagnose_slice_arbitrage(
        strikes_usd=strikes,
        call_prices=prices,
        forward_usd=float(forward_usd),
        time_to_expiry_years=float(time_to_expiry_years),
        rate=rate,
    )
    return {
        "call_monotone": report.call_monotone,
        "call_convex": report.call_convex,
        "min_butterfly": report.min_butterfly,
        "min_call_step": report.min_call_step,
        "worst_convexity_strike": report.worst_convexity_strike,
        "grid_points": int(grid_points),
        "violations": report.violations,
    }


def residuals_for_fitted(
    fitted: FittedSmile,
    points: Sequence[SmilePoint],
    time_to_expiry_years: float,
) -> "FittedResidualPack":
    usable = _usable_points(points)
    rows: list[PointResidual] = []
    abs_vals: list[float] = []
    abs_ks: list[float] = []
    for point in usable:
        pred_w, status = fitted.total_variance(point.log_moneyness)
        pred_iv, _iv_status = fitted.iv(point.log_moneyness)
        if pred_w is None or status.value == "extrapolated":
            residual_w = None
            residual_iv = None
        else:
            residual_w = point.total_variance - pred_w
            residual_iv = point.iv - pred_iv if pred_iv is not None else None
            abs_vals.append(abs(residual_w))
            abs_ks.append(point.log_moneyness)
        rows.append(
            PointResidual(
                strike_usd=point.strike_usd,
                log_moneyness=point.log_moneyness,
                weight=point.fit_weight,
                observed_w=point.total_variance,
                fitted_w=pred_w,
                residual_w=residual_w,
                observed_iv=point.iv,
                fitted_iv=pred_iv,
                residual_iv=residual_iv,
            )
        )
    max_abs = max(abs_vals) if abs_vals else None
    max_k = abs_ks[int(abs_vals.index(max_abs))] if abs_vals and max_abs is not None else None
    _ = time_to_expiry_years
    return FittedResidualPack(
        point_residuals=tuple(rows),
        summary=ResidualSummary(
            rms=fitted.diagnostics.residual_rms,
            weighted_rms=fitted.diagnostics.weighted_residual_rms,
            max_abs=max_abs,
            max_abs_k=max_k,
            max_abs_iv=None,
            weighted_iv_rms=None,
            huber_loss=None,
            residual_budget=None,
            residual_budget_ok=None,
        ),
    )


class FittedResidualPack:
    def __init__(self, point_residuals: tuple[PointResidual, ...], summary: ResidualSummary) -> None:
        self.point_residuals = point_residuals
        self.summary = summary


def _constrained_eligible(result: SmileFitResult, *, sparse: bool) -> bool:
    if sparse:
        return False
    if result.model_status is ModelStatus.REJECTED or not result.smile.knot_k:
        return False
    if not result.optimizer.converged and result.served_call_convex is not True:
        return False
    if result.served_call_monotone is not True or result.served_call_convex is not True:
        return False
    if result.residual_budget_ok is False:
        return False
    return True


def _compare_constrained(
    result: SmileFitResult,
    *,
    selected: bool,
    sparse: bool,
) -> CandidateComparison:
    reasons = list(result.failure_reasons)
    if sparse:
        reasons.append("insufficient_or_sparse_observations")
    eligible = _constrained_eligible(result, sparse=sparse)
    return CandidateComparison(
        fitter_name=result.smile.fitter_name,
        fitter_grade=result.smile.fitter_grade,
        status=result.model_status,
        converged=result.optimizer.converged,
        residual_rms=result.residual.rms,
        weighted_residual_rms=result.residual.weighted_rms,
        max_abs_residual=result.residual.max_abs,
        k_min=result.smile.diagnostics.k_min,
        k_max=result.smile.diagnostics.k_max,
        call_monotone=result.served_call_monotone,
        call_convex=result.served_call_convex,
        min_butterfly=result.served_min_butterfly,
        density_status=None,
        residual_budget_ok=result.residual_budget_ok,
        selected=selected,
        reason_codes=tuple(dict.fromkeys(reasons)),
        notes=result.smile.diagnostics.notes,
        eligible_for_density=eligible,
    )


def _mark_selected(
    rows: tuple[CandidateComparison, ...],
    selected_name: str,
) -> tuple[CandidateComparison, ...]:
    out = []
    for row in rows:
        out.append(
            CandidateComparison(
                fitter_name=row.fitter_name,
                fitter_grade=row.fitter_grade,
                status=row.status,
                converged=row.converged,
                residual_rms=row.residual_rms,
                weighted_residual_rms=row.weighted_residual_rms,
                max_abs_residual=row.max_abs_residual,
                k_min=row.k_min,
                k_max=row.k_max,
                call_monotone=row.call_monotone,
                call_convex=row.call_convex,
                min_butterfly=row.min_butterfly,
                density_status=row.density_status,
                residual_budget_ok=row.residual_budget_ok,
                selected=row.fitter_name == selected_name,
                reason_codes=row.reason_codes,
                notes=row.notes,
                eligible_for_density=row.eligible_for_density and row.fitter_name == selected_name,
            )
        )
    return tuple(out)


def _half_spreads(points: Sequence[SmilePoint]) -> list[float]:
    spreads: list[float] = []
    for point in _usable_points(points):
        if point.bid_iv is not None and point.ask_iv is not None:
            spreads.append(max(0.5 * (point.ask_iv - point.bid_iv), 0.0))
        else:
            spreads.append(0.02)
    return spreads


def attach_density_status(
    rows: tuple[CandidateComparison, ...],
    *,
    served_name: str,
    density_status: ModelStatus | None,
) -> tuple[CandidateComparison, ...]:
    out = []
    for row in rows:
        out.append(
            CandidateComparison(
                fitter_name=row.fitter_name,
                fitter_grade=row.fitter_grade,
                status=row.status,
                converged=row.converged,
                residual_rms=row.residual_rms,
                weighted_residual_rms=row.weighted_residual_rms,
                max_abs_residual=row.max_abs_residual,
                k_min=row.k_min,
                k_max=row.k_max,
                call_monotone=row.call_monotone,
                call_convex=row.call_convex,
                min_butterfly=row.min_butterfly,
                density_status=density_status if row.fitter_name == served_name else row.density_status,
                residual_budget_ok=row.residual_budget_ok,
                selected=row.selected,
                reason_codes=row.reason_codes,
                notes=row.notes,
                eligible_for_density=row.eligible_for_density,
            )
        )
    return tuple(out)
