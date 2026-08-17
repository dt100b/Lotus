"""Constrained raw-SVI serving candidate.

Fits a consensus total-variance smile. It is a diagnostic candidate, not a
production-promoted model. Optimizer convergence is not a no-arbitrage
certificate; serving still requires the uniform-K Black-76 gates.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import math
from typing import Sequence

import numpy as np
from scipy.optimize import least_squares, minimize

from project.options_surface.distribution.black76 import black76_call
from project.options_surface.surface.arbitrage import diagnose_slice_arbitrage
from project.options_surface.surface.fitters import (
    MIN_FIT_POINTS,
    FittedSmile,
    _usable_points,
)
from project.options_surface.surface.svi import (
    G_TOL,
    LEE_SLACK,
    W_MIN,
    diagnose_svi_slice,
    parameter_bounds,
    project_theta,
    ssvi_to_raw,
    svi_d2w,
    svi_g,
    svi_min_total_variance,
    svi_w,
)
from project.options_surface.types import (
    FitterGrade,
    ModelStatus,
    OptimizerDiagnostics,
    PointResidual,
    ResidualSummary,
    SmileFitDiagnostics,
    SmilePoint,
)

SERVING_GRID = 401
CONSTRAINT_GRID = 21
DEFAULT_RATE = 0.0


@dataclass(frozen=True, slots=True)
class ConstrainedSviConfig:
    min_points: int = MIN_FIT_POINTS
    huber_delta_frac_atm_w: float = 0.15
    huber_delta_floor: float = 1e-6
    lambda_curvature: float = 1e-6
    lambda_ridge: float = 1e-4
    ridge_b0: float = 0.05
    constraint_grid: int = CONSTRAINT_GRID
    serving_grid: int = SERVING_GRID
    slsqp_maxiter: int = 200
    residual_iv_rms_floor: float = 0.02
    residual_iv_spread_mult: float = 2.5
    residual_iv_atm_frac: float = 0.08
    residual_iv_max_high_weight: float = 0.06


@dataclass(frozen=True, slots=True)
class SmileFitResult:
    """Typed fitter output. Never silently substituted with another model."""

    smile: FittedSmile
    residual: ResidualSummary
    optimizer: OptimizerDiagnostics
    served_call_monotone: bool | None
    served_call_convex: bool | None
    served_min_butterfly: float | None
    served_worst_convexity_strike: float | None
    served_density_grid: int | None
    failure_reasons: tuple[str, ...]
    model_grade: FitterGrade
    model_status: ModelStatus
    point_residuals: tuple[PointResidual, ...] = ()
    residual_budget_ok: bool | None = None

    def total_variance(self, k: float):
        return self.smile.total_variance(k)

    def iv(self, k: float):
        return self.smile.iv(k)

    def call_price(self, strike_usd: float, forward: float | None = None, T: float | None = None):
        _ = (forward, T)
        return self.smile.call_price(strike_usd)

    def delta(self, strike_usd: float, option_type: str):
        return self.smile.delta(strike_usd, option_type)

    @property
    def parameters(self) -> dict[str, float]:
        return dict(self.smile.parameters)

    @property
    def k_min(self) -> float:
        return self.smile.k_min

    @property
    def k_max(self) -> float:
        return self.smile.k_max


class ConstrainedSviFitter:
    """Quality-weighted constrained raw SVI. Grade: diagnostic_candidate."""

    name = "constrained_svi"
    grade = FitterGrade.DIAGNOSTIC_CANDIDATE

    def __init__(self, config: ConstrainedSviConfig | None = None) -> None:
        self.config = config or ConstrainedSviConfig()

    def fit(
        self,
        points: Sequence[SmilePoint],
        *,
        time_to_expiry_years: float,
        forward_usd: float,
        config: ConstrainedSviConfig | None = None,
    ) -> FittedSmile:
        return self.fit_result(
            points,
            time_to_expiry_years=time_to_expiry_years,
            forward_usd=forward_usd,
            config=config,
        ).smile

    def fit_result(
        self,
        points: Sequence[SmilePoint],
        *,
        time_to_expiry_years: float,
        forward_usd: float,
        config: ConstrainedSviConfig | None = None,
    ) -> SmileFitResult:
        cfg = config or self.config
        usable = _usable_points(points)
        if len(usable) < cfg.min_points:
            return _failed_result(
                self,
                points=usable,
                time_to_expiry_years=time_to_expiry_years,
                forward_usd=forward_usd,
                reasons=("insufficient_observations",),
            )
        k = np.asarray([point.log_moneyness for point in usable], dtype=float)
        w = np.asarray([point.total_variance for point in usable], dtype=float)
        weights = np.asarray([max(point.fit_weight, 1e-6) for point in usable], dtype=float)
        unique_k, unique_idx = np.unique(k, return_index=True)
        if len(unique_k) < cfg.min_points:
            return _failed_result(
                self,
                points=usable,
                time_to_expiry_years=time_to_expiry_years,
                forward_usd=forward_usd,
                reasons=("duplicate_log_moneyness",),
            )
        k = unique_k
        w = w[unique_idx]
        weights = weights[unique_idx]
        usable = [usable[int(i)] for i in unique_idx]
        k_min = float(k.min())
        k_max = float(k.max())
        atm_w = _atm_total_variance(k, w, weights)
        delta = max(cfg.huber_delta_floor, cfg.huber_delta_frac_atm_w * atm_w)
        starts = _deterministic_starts(k, w, weights, atm_w, k_min, k_max)
        best_any: _StartRecord | None = None
        best_eligible: _StartRecord | None = None
        start_notes: list[str] = []
        nfev = 0
        for index, seed in enumerate(starts):
            refined, info = _refine_start(
                seed,
                k=k,
                w=w,
                weights=weights,
                delta=delta,
                atm_w=atm_w,
                k_min=k_min,
                k_max=k_max,
                cfg=cfg,
            )
            nfev += int(info.get("nfev") or 0)
            start_notes.append(f"start{index}:{info['status']}")
            if refined is None:
                continue
            serving = evaluate_served_call_curve(
                refined,
                forward_usd=float(forward_usd),
                time_to_expiry_years=float(time_to_expiry_years),
                k_min=k_min,
                k_max=k_max,
                grid_points=cfg.serving_grid,
            )
            slice_diag = diagnose_svi_slice(
                refined, k_min=k_min, k_max=k_max, grid_points=41
            )
            score = _objective(refined, k, w, weights, delta, atm_w, k_min, k_max, cfg)
            record = _StartRecord(
                index=index,
                theta=refined,
                score=score,
                serving=serving,
                slice_diag=slice_diag,
                status=str(info["status"]),
                converged=bool(info.get("converged")),
            )
            if best_any is None or record.score < best_any.score:
                best_any = record
            if _start_eligible(record):
                if best_eligible is None or record.score < best_eligible.score:
                    best_eligible = record
        chosen = best_eligible or best_any
        if chosen is None:
            return _failed_result(
                self,
                points=usable,
                time_to_expiry_years=time_to_expiry_years,
                forward_usd=forward_usd,
                reasons=("optimizer_failed",),
                start_notes=tuple(start_notes),
            )
        return _pack_result(
            fitter=self,
            usable=usable,
            k=k,
            w=w,
            weights=weights,
            theta=chosen.theta,
            time_to_expiry_years=float(time_to_expiry_years),
            forward_usd=float(forward_usd),
            k_min=k_min,
            k_max=k_max,
            cfg=cfg,
            chosen=chosen,
            nfev=nfev,
            start_notes=tuple(start_notes),
            n_starts=len(starts),
            eligible=best_eligible is not None and chosen is best_eligible,
        )


@dataclass(frozen=True, slots=True)
class _StartRecord:
    index: int
    theta: np.ndarray
    score: float
    serving: dict[str, object]
    slice_diag: dict[str, float | bool | None]
    status: str
    converged: bool


def evaluate_served_call_curve(
    theta: Sequence[float],
    *,
    forward_usd: float,
    time_to_expiry_years: float,
    k_min: float,
    k_max: float,
    grid_points: int = SERVING_GRID,
    rate: float = DEFAULT_RATE,
) -> dict[str, object]:
    """Black-76 call monotone/convex on the density-serving uniform-K grid."""
    if grid_points < 3 or k_max <= k_min or forward_usd <= 0 or time_to_expiry_years <= 0:
        return {
            "call_monotone": False,
            "call_convex": False,
            "min_butterfly": None,
            "min_call_step": None,
            "worst_convexity_strike": None,
            "grid_points": int(grid_points),
            "violations": ("insufficient_call_grid",),
        }
    strike_lo = float(forward_usd) * math.exp(float(k_min))
    strike_hi = float(forward_usd) * math.exp(float(k_max))
    strikes = np.linspace(strike_lo, strike_hi, int(grid_points))
    prices: list[float] = []
    for strike in strikes:
        k = math.log(float(strike) / float(forward_usd))
        total = float(np.asarray(svi_w(k, theta)).reshape(-1)[0])
        if not math.isfinite(total) or total < 0.0 or time_to_expiry_years <= 0:
            prices.append(float("nan"))
            continue
        sigma = math.sqrt(total / time_to_expiry_years)
        prices.append(
            black76_call(
                forward_usd=float(forward_usd),
                strike_usd=float(strike),
                time_to_expiry_years=float(time_to_expiry_years),
                rate=rate,
                sigma=sigma,
            )
        )
    report = diagnose_slice_arbitrage(
        strikes_usd=[float(strike) for strike in strikes],
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


def residual_budget(
    *,
    residuals: Sequence[PointResidual],
    atm_iv: float | None,
    half_spreads: Sequence[float],
    weights: Sequence[float],
    cfg: ConstrainedSviConfig,
) -> tuple[bool, float, float | None]:
    if not residuals:
        return False, cfg.residual_iv_rms_floor, None
    weight_arr = np.asarray(list(weights), dtype=float)
    median_w = float(np.median(weight_arr)) if len(weight_arr) else 0.0
    high = [
        item
        for item, weight in zip(residuals, weight_arr, strict=True)
        if weight >= median_w and item.residual_iv is not None
    ]
    if not high:
        high = [item for item in residuals if item.residual_iv is not None]
    if not high:
        return False, cfg.residual_iv_rms_floor, None
    errors = np.asarray([abs(float(item.residual_iv)) for item in high], dtype=float)
    high_weights = np.asarray(
        [
            weight
            for item, weight in zip(residuals, weight_arr, strict=True)
            if item in high
        ],
        dtype=float,
    )
    if len(high_weights) != len(errors):
        high_weights = np.ones(len(errors), dtype=float)
    iv_rms = float(np.sqrt(np.average(errors**2, weights=np.maximum(high_weights, 1e-12))))
    spreads = np.asarray(list(half_spreads), dtype=float)
    if len(spreads) == len(weight_arr) and np.any(np.isfinite(spreads)):
        finite = np.isfinite(spreads)
        spread_ref = float(np.average(spreads[finite], weights=np.maximum(weight_arr[finite], 1e-12)))
    else:
        spread_ref = 0.02
    budget = max(
        cfg.residual_iv_rms_floor,
        cfg.residual_iv_spread_mult * spread_ref,
        cfg.residual_iv_atm_frac * (atm_iv or 0.0),
    )
    max_abs = float(np.max(errors))
    ok = bool(iv_rms <= budget and max_abs <= cfg.residual_iv_max_high_weight)
    return ok, budget, iv_rms


def _deterministic_starts(
    k: np.ndarray,
    w: np.ndarray,
    weights: np.ndarray,
    atm_w: float,
    k_min: float,
    k_max: float,
) -> list[np.ndarray]:
    starts: list[np.ndarray] = []
    zeliade = _zeliade_starts(k, w, weights, k_min, k_max)
    starts.extend(zeliade[:3])
    span = max(k_max - k_min, 1e-3)
    starts.append(
        project_theta(
            [max(atm_w, W_MIN), 0.05, 0.0, 0.0, max(0.1, 0.25 * span)],
            k_min=k_min,
            k_max=k_max,
        )
    )
    slope = _near_atm_slope_start(k, w, weights, atm_w, k_min, k_max)
    if slope is not None:
        starts.append(slope)
    ssvi = _ssvi_start(k, w, weights, atm_w, k_min, k_max)
    if ssvi is not None:
        starts.append(ssvi)
    # Deduplicate near-identical seeds while preserving order.
    unique: list[np.ndarray] = []
    for seed in starts:
        if any(float(np.max(np.abs(seed - seen))) < 1e-8 for seen in unique):
            continue
        unique.append(seed)
    return unique


def _zeliade_starts(
    k: np.ndarray,
    w: np.ndarray,
    weights: np.ndarray,
    k_min: float,
    k_max: float,
) -> list[np.ndarray]:
    order = np.argsort(k)
    k_sorted = k[order]
    w_sorted = w[order]
    wt_sorted = weights[order]
    cdf = np.cumsum(wt_sorted)
    if float(cdf[-1]) <= 0:
        return []
    cdf = cdf / float(cdf[-1])
    quantiles = (0.10, 0.25, 0.40, 0.50, 0.60, 0.75, 0.90)
    m_grid = [float(np.interp(q, cdf, k_sorted)) for q in quantiles]
    span = max(k_max - k_min, 1e-3)
    sigma_grid = [max(1e-3, scale * span) for scale in (0.08, 0.16, 0.28, 0.42, 0.60)]
    scored: list[tuple[float, np.ndarray]] = []
    for m in m_grid:
        for sigma in sigma_grid:
            theta = _zeliade_inner(k_sorted, w_sorted, wt_sorted, m, sigma)
            if theta is None:
                continue
            theta = project_theta(theta, k_min=k_min, k_max=k_max)
            pred = svi_w(k_sorted, theta)
            resid = pred - w_sorted
            score = float(np.average(resid**2, weights=wt_sorted))
            scored.append((score, theta))
    scored.sort(key=lambda item: item[0])
    return [item[1] for item in scored]


def _zeliade_inner(
    k: np.ndarray,
    w: np.ndarray,
    weights: np.ndarray,
    m: float,
    sigma: float,
) -> np.ndarray | None:
    x = k - m
    dist = np.sqrt(x * x + sigma * sigma)
    design = np.column_stack((np.ones_like(x), x, dist))
    scale = np.sqrt(np.maximum(weights, 1e-12))
    try:
        coef, *_ = np.linalg.lstsq(design * scale[:, None], w * scale, rcond=None)
    except np.linalg.LinAlgError:
        return None
    a, d, c = (float(coef[0]), float(coef[1]), float(coef[2]))
    c = max(c, 1e-8)
    if abs(d) > 0.999 * c:
        d = math.copysign(0.999 * c, d)
    if a + c * sigma < W_MIN:
        a = W_MIN - c * sigma
    b = math.hypot(d, c)
    rho = d / b if b > 0 else 0.0
    return np.asarray([a, b, rho, m, sigma], dtype=float)


def _near_atm_slope_start(
    k: np.ndarray,
    w: np.ndarray,
    weights: np.ndarray,
    atm_w: float,
    k_min: float,
    k_max: float,
) -> np.ndarray | None:
    mask = np.abs(k) <= 0.05
    if int(np.count_nonzero(mask)) < 3:
        mask = np.ones(len(k), dtype=bool)
    try:
        coef = np.polyfit(k[mask], w[mask], deg=1, w=weights[mask])
    except (np.linalg.LinAlgError, ValueError):
        return None
    slope = float(coef[0])
    b = min(max(abs(slope) * 2.0, 0.01), 1.0)
    rho = float(np.clip(slope / b if b else 0.0, -0.8, 0.8))
    return project_theta(
        [max(atm_w, W_MIN), b, rho, 0.0, max(0.08, 0.2 * (k_max - k_min))],
        k_min=k_min,
        k_max=k_max,
    )


def _ssvi_start(
    k: np.ndarray,
    w: np.ndarray,
    weights: np.ndarray,
    atm_w: float,
    k_min: float,
    k_max: float,
) -> np.ndarray | None:
    theta0 = np.asarray([max(atm_w, W_MIN), 1.5, 0.0], dtype=float)

    def residual(params: np.ndarray) -> np.ndarray:
        theta_atm, phi, rho = params
        raw = ssvi_to_raw(theta_atm, phi, rho)
        return np.sqrt(weights) * (svi_w(k, raw) - w)

    try:
        result = least_squares(
            residual,
            theta0,
            bounds=(
                np.asarray([W_MIN, 1e-4, -0.999], dtype=float),
                np.asarray([4.0, 50.0, 0.999], dtype=float),
            ),
            max_nfev=80,
        )
    except (ValueError, RuntimeError):
        return None
    theta_atm, phi, rho = result.x
    if theta_atm * phi * (1.0 + abs(rho)) > 4.0 - LEE_SLACK:
        phi = max((4.0 - LEE_SLACK) / (theta_atm * (1.0 + abs(rho))), 1e-4)
    return project_theta(ssvi_to_raw(theta_atm, phi, rho), k_min=k_min, k_max=k_max)


def _refine_start(
    seed: np.ndarray,
    *,
    k: np.ndarray,
    w: np.ndarray,
    weights: np.ndarray,
    delta: float,
    atm_w: float,
    k_min: float,
    k_max: float,
    cfg: ConstrainedSviConfig,
) -> tuple[np.ndarray | None, dict[str, object]]:
    lower, upper = parameter_bounds(k_min, k_max)
    x0 = project_theta(seed, k_min=k_min, k_max=k_max)

    def residual(theta: np.ndarray) -> np.ndarray:
        return np.sqrt(weights) * (svi_w(k, theta) - w)

    try:
        ls = least_squares(
            residual,
            x0,
            bounds=(lower, upper),
            loss="huber",
            f_scale=max(delta, 1e-12),
            max_nfev=120,
        )
        theta = project_theta(ls.x, k_min=k_min, k_max=k_max)
        nfev = int(ls.nfev)
        status = "ls_converged" if ls.success else "ls_not_converged"
        converged = bool(ls.success)
    except (ValueError, RuntimeError):
        theta = x0
        nfev = 0
        status = "ls_failed"
        converged = False
    slice_diag = diagnose_svi_slice(theta, k_min=k_min, k_max=k_max, grid_points=41)
    needs_projection = (
        not bool(slice_diag["positive_variance"])
        or not bool(slice_diag["butterfly_ok"])
        or float(slice_diag["lee_headroom"] or 0.0) < 0.0
        or svi_min_total_variance(theta) < W_MIN
    )
    if needs_projection:
        projected, proj_info = _project_constraints(
            theta, k=k, w=w, weights=weights, delta=delta, atm_w=atm_w,
            k_min=k_min, k_max=k_max, cfg=cfg,
        )
        nfev += int(proj_info.get("nfev") or 0)
        if projected is not None:
            theta = projected
            status = f"{status}+{proj_info['status']}"
            converged = converged or bool(proj_info.get("converged"))
        else:
            status = f"{status}+projection_failed"
    if not np.all(np.isfinite(theta)):
        return None, {"status": "non_finite", "nfev": nfev, "converged": False}
    return theta, {"status": status, "nfev": nfev, "converged": converged}


def _project_constraints(
    seed: np.ndarray,
    *,
    k: np.ndarray,
    w: np.ndarray,
    weights: np.ndarray,
    delta: float,
    atm_w: float,
    k_min: float,
    k_max: float,
    cfg: ConstrainedSviConfig,
) -> tuple[np.ndarray | None, dict[str, object]]:
    lower, upper = parameter_bounds(k_min, k_max)
    ks = np.linspace(k_min, k_max, max(int(cfg.constraint_grid), 7))
    bounds = list(zip(lower.tolist(), upper.tolist(), strict=True))

    def objective(theta: np.ndarray) -> float:
        return _objective(theta, k, w, weights, delta, atm_w, k_min, k_max, cfg)

    constraints = (
        {"type": "ineq", "fun": lambda th: svi_min_total_variance(th) - W_MIN},
        {
            "type": "ineq",
            "fun": lambda th: (4.0 - LEE_SLACK) - th[1] * (1.0 + abs(th[2])),
        },
        {"type": "ineq", "fun": lambda th: np.asarray(svi_w(ks, th), dtype=float) - W_MIN},
        {"type": "ineq", "fun": lambda th: np.asarray(svi_g(ks, th), dtype=float) + G_TOL},
    )
    for method in ("SLSQP", "trust-constr"):
        try:
            result = minimize(
                objective,
                seed,
                method=method,
                bounds=bounds,
                constraints=constraints,
                options={"maxiter": cfg.slsqp_maxiter, "ftol": 1e-12}
                if method == "SLSQP"
                else {"maxiter": cfg.slsqp_maxiter},
            )
        except (ValueError, RuntimeError):
            continue
        theta = project_theta(result.x, k_min=k_min, k_max=k_max)
        if np.all(np.isfinite(theta)):
            return theta, {
                "status": f"{method.lower()}_{'ok' if result.success else 'partial'}",
                "nfev": int(getattr(result, "nfev", 0) or 0),
                "converged": bool(result.success),
            }
    return None, {"status": "projection_failed", "nfev": 0, "converged": False}


def _objective(
    theta: Sequence[float],
    k: np.ndarray,
    w: np.ndarray,
    weights: np.ndarray,
    delta: float,
    atm_w: float,
    k_min: float,
    k_max: float,
    cfg: ConstrainedSviConfig,
) -> float:
    resid = np.asarray(svi_w(k, theta), dtype=float) - w
    loss = float(np.sum(weights * _huber(resid, delta)))
    ks = np.linspace(k_min, k_max, max(int(cfg.constraint_grid), 7))
    curv = np.asarray(svi_d2w(ks, theta), dtype=float)
    loss += cfg.lambda_curvature * float(np.mean(curv * curv))
    a, b, rho, m, _sigma = [float(v) for v in theta]
    _ = (a, atm_w)
    loss += cfg.lambda_ridge * ((b - cfg.ridge_b0) ** 2 + m * m + rho * rho)
    return loss


def _huber(residual: np.ndarray, delta: float) -> np.ndarray:
    abs_r = np.abs(residual)
    quad = 0.5 * residual * residual
    lin = delta * (abs_r - 0.5 * delta)
    return np.where(abs_r <= delta, quad, lin)


def _atm_total_variance(k: np.ndarray, w: np.ndarray, weights: np.ndarray) -> float:
    if 0.0 < float(k[0]) or 0.0 > float(k[-1]):
        return float(np.average(w, weights=weights))
    return float(np.interp(0.0, k, w))


def _start_eligible(record: _StartRecord) -> bool:
    min_w = record.slice_diag.get("min_w")
    min_g = record.slice_diag.get("min_g")
    return bool(
        record.serving.get("call_monotone")
        and record.serving.get("call_convex")
        and min_w is not None
        and float(min_w) > -W_MIN
        and min_g is not None
        and float(min_g) >= -G_TOL
        and float(record.slice_diag.get("lee_headroom") or 0.0) >= 0.0
        and math.isfinite(record.score)
    )


def _pack_result(
    *,
    fitter: ConstrainedSviFitter,
    usable: Sequence[SmilePoint],
    k: np.ndarray,
    w: np.ndarray,
    weights: np.ndarray,
    theta: np.ndarray,
    time_to_expiry_years: float,
    forward_usd: float,
    k_min: float,
    k_max: float,
    cfg: ConstrainedSviConfig,
    chosen: _StartRecord,
    nfev: int,
    start_notes: tuple[str, ...],
    n_starts: int,
    eligible: bool,
) -> SmileFitResult:
    pred = np.asarray(svi_w(k, theta), dtype=float)
    resid_w = w - pred
    rms = float(np.sqrt(np.mean(resid_w**2)))
    wrms = float(np.sqrt(np.average(resid_w**2, weights=weights)))
    max_idx = int(np.argmax(np.abs(resid_w)))
    iv_obs = np.sqrt(np.maximum(w, 0.0) / time_to_expiry_years) if time_to_expiry_years > 0 else np.full_like(w, np.nan)
    iv_fit = np.sqrt(np.maximum(pred, 0.0) / time_to_expiry_years) if time_to_expiry_years > 0 else np.full_like(w, np.nan)
    resid_iv = iv_obs - iv_fit
    points = []
    spreads = []
    for i, point in enumerate(usable):
        points.append(
            PointResidual(
                strike_usd=point.strike_usd,
                log_moneyness=float(k[i]),
                weight=float(weights[i]),
                observed_w=float(w[i]),
                fitted_w=float(pred[i]),
                residual_w=float(resid_w[i]),
                observed_iv=float(iv_obs[i]),
                fitted_iv=float(iv_fit[i]) if math.isfinite(iv_fit[i]) else None,
                residual_iv=float(resid_iv[i]) if math.isfinite(resid_iv[i]) else None,
            )
        )
        if point.bid_iv is not None and point.ask_iv is not None:
            spreads.append(max(0.5 * (point.ask_iv - point.bid_iv), 0.0))
        else:
            spreads.append(0.02)
    atm_iv = math.sqrt(max(_atm_total_variance(k, pred, weights), 0.0) / time_to_expiry_years) if time_to_expiry_years > 0 else None
    budget_ok, budget, iv_rms = residual_budget(
        residuals=points,
        atm_iv=atm_iv,
        half_spreads=spreads,
        weights=weights,
        cfg=cfg,
    )
    reasons: list[str] = []
    if not chosen.serving.get("call_monotone"):
        reasons.append("served_call_not_decreasing")
    if not chosen.serving.get("call_convex"):
        reasons.append("served_call_not_convex")
    if chosen.slice_diag.get("min_w") is None or float(chosen.slice_diag["min_w"] or 0.0) <= -W_MIN:
        reasons.append("non_positive_total_variance")
    if chosen.slice_diag.get("min_g") is None or float(chosen.slice_diag["min_g"] or 0.0) < -G_TOL:
        reasons.append("svi_butterfly_g_negative")
    if float(chosen.slice_diag.get("lee_headroom") or 0.0) < 0.0:
        reasons.append("lee_moment_violated")
    if not budget_ok:
        reasons.append("residual_budget_exceeded")
    if not eligible:
        reasons.append("no_eligible_constrained_start")
    params = {
        "a": float(theta[0]),
        "b": float(theta[1]),
        "rho": float(theta[2]),
        "m": float(theta[3]),
        "sigma": float(theta[4]),
    }

    def evaluate(k_query: float) -> float:
        return float(np.asarray(svi_w(k_query, theta)).reshape(-1)[0])

    smile_status = ModelStatus.DEGRADED
    if reasons and not chosen.serving.get("call_convex"):
        smile_status = ModelStatus.DEGRADED
    notes = [
        "Constrained raw SVI. Diagnostic candidate: not production-promoted.",
        f"selected_start={chosen.index}",
        f"optimizer={chosen.status}",
        f"served_call_convex={bool(chosen.serving.get('call_convex'))}",
        f"served_call_monotone={bool(chosen.serving.get('call_monotone'))}",
    ]
    notes.extend(reasons)
    diagnostics = SmileFitDiagnostics(
        fitter_name=fitter.name,
        fitter_grade=fitter.grade,
        status=smile_status,
        residual_rms=rms,
        weighted_residual_rms=wrms,
        optimizer_status=chosen.status,
        parameter_count=5,
        parameters=params,
        observation_count=len(usable),
        k_min=k_min,
        k_max=k_max,
        extrapolated=False,
        notes=tuple(notes),
        max_abs_residual=float(abs(resid_w[max_idx])),
        fit_converged=bool(chosen.converged or eligible),
        failure_reasons=tuple(reasons),
    )
    smile = FittedSmile(
        fitter_name=fitter.name,
        fitter_grade=fitter.grade,
        diagnostics=diagnostics,
        k_min=k_min,
        k_max=k_max,
        time_to_expiry_years=time_to_expiry_years,
        forward_usd=forward_usd,
        knot_k=tuple(float(value) for value in k),
        knot_w=tuple(float(value) for value in w),
        parameters=params,
        _evaluate_w=evaluate,
    )
    residual = ResidualSummary(
        rms=rms,
        weighted_rms=wrms,
        max_abs=float(abs(resid_w[max_idx])),
        max_abs_k=float(k[max_idx]),
        max_abs_iv=float(abs(resid_iv[max_idx])) if math.isfinite(resid_iv[max_idx]) else None,
        weighted_iv_rms=iv_rms,
        huber_loss=float(chosen.score),
        residual_budget=budget,
        residual_budget_ok=budget_ok,
        high_weight_max_abs_iv=max(
            (abs(float(item.residual_iv)) for item in points if item.residual_iv is not None),
            default=None,
        ),
    )
    optimizer = OptimizerDiagnostics(
        converged=bool(chosen.converged or eligible),
        status=chosen.status,
        n_starts=n_starts,
        selected_start=chosen.index,
        nfev=nfev,
        message=f"selected_start={chosen.index}; eligible={eligible}",
        start_notes=start_notes,
    )
    return SmileFitResult(
        smile=smile,
        residual=residual,
        optimizer=optimizer,
        served_call_monotone=bool(chosen.serving.get("call_monotone")),
        served_call_convex=bool(chosen.serving.get("call_convex")),
        served_min_butterfly=chosen.serving.get("min_butterfly") if isinstance(chosen.serving.get("min_butterfly"), (int, float)) else None,
        served_worst_convexity_strike=(
            chosen.serving.get("worst_convexity_strike")
            if isinstance(chosen.serving.get("worst_convexity_strike"), (int, float))
            else None
        ),
        served_density_grid=int(cfg.serving_grid),
        failure_reasons=tuple(reasons),
        model_grade=fitter.grade,
        model_status=smile_status,
        point_residuals=tuple(points),
        residual_budget_ok=budget_ok,
    )


def _failed_result(
    fitter: ConstrainedSviFitter,
    *,
    points: Sequence[SmilePoint],
    time_to_expiry_years: float,
    forward_usd: float,
    reasons: tuple[str, ...],
    start_notes: tuple[str, ...] = (),
) -> SmileFitResult:
    diagnostics = SmileFitDiagnostics(
        fitter_name=fitter.name,
        fitter_grade=fitter.grade,
        status=ModelStatus.REJECTED,
        residual_rms=None,
        weighted_residual_rms=None,
        optimizer_status="rejected",
        parameter_count=0,
        parameters={},
        observation_count=len(points),
        k_min=None,
        k_max=None,
        extrapolated=False,
        notes=reasons,
        max_abs_residual=None,
        fit_converged=False,
        failure_reasons=reasons,
    )

    def evaluate(_k: float) -> float:
        return float("nan")

    smile = FittedSmile(
        fitter_name=fitter.name,
        fitter_grade=fitter.grade,
        diagnostics=diagnostics,
        k_min=0.0,
        k_max=0.0,
        time_to_expiry_years=float(time_to_expiry_years),
        forward_usd=float(forward_usd),
        knot_k=(),
        knot_w=(),
        parameters={},
        _evaluate_w=evaluate,
    )
    return SmileFitResult(
        smile=smile,
        residual=ResidualSummary(
            rms=None,
            weighted_rms=None,
            max_abs=None,
            max_abs_k=None,
            max_abs_iv=None,
            weighted_iv_rms=None,
            huber_loss=None,
            residual_budget=None,
            residual_budget_ok=False,
        ),
        optimizer=OptimizerDiagnostics(
            converged=False,
            status="rejected",
            n_starts=0,
            selected_start=None,
            nfev=None,
            message=";".join(reasons),
            start_notes=start_notes,
        ),
        served_call_monotone=None,
        served_call_convex=None,
        served_min_butterfly=None,
        served_worst_convexity_strike=None,
        served_density_grid=None,
        failure_reasons=reasons,
        model_grade=fitter.grade,
        model_status=ModelStatus.REJECTED,
        residual_budget_ok=False,
    )


def with_smile_status(result: SmileFitResult, status: ModelStatus, extra_notes: tuple[str, ...] = ()) -> SmileFitResult:
    notes = result.smile.diagnostics.notes + extra_notes
    diagnostics = replace(result.smile.diagnostics, status=status, notes=notes)
    smile = replace(result.smile, diagnostics=diagnostics)
    return replace(result, smile=smile, model_status=status)
