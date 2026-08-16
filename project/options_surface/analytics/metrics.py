"""ATM IV, implied move, RR25, BF25, wing richness, and Q-measure ranges."""

from __future__ import annotations

import math
from typing import Sequence

from project.options_surface.surface.fitters import FittedSmile
from project.options_surface.surface.smile import solve_delta_strike
from project.options_surface.types import (
    DensityResult,
    ForwardEstimate,
    ModelStatus,
    SmilePoint,
    SurfaceAnalytics,
)


def compute_analytics(
    *,
    fitted: FittedSmile,
    observed: Sequence[SmilePoint],
    forward: ForwardEstimate,
    density: DensityResult | None,
    rate: float = 0.0,
) -> SurfaceAnalytics:
    atm_iv, _status = fitted.iv(0.0)
    t = fitted.time_to_expiry_years
    f = forward.forward_usd
    move_up = move_down = None
    if atm_iv and f and t > 0:
        sigma_move = atm_iv * math.sqrt(t)
        move_up = float(f * (math.exp(sigma_move) - 1.0))
        move_down = float(f * (1.0 - math.exp(-sigma_move)))

    k_call, iv_25_call = solve_delta_strike(fitted, target_delta=0.25, side="call", rate=rate)
    k_put, iv_25_put = solve_delta_strike(fitted, target_delta=-0.25, side="put", rate=rate)
    rr_25 = bf_25 = None
    k_25_call = k_25_put = None
    if (
        k_call is not None
        and k_put is not None
        and fitted.forward_usd > 0
    ):
        k_25_call = math.log(float(k_call) / fitted.forward_usd)
        k_25_put = math.log(float(k_put) / fitted.forward_usd)
    if (
        iv_25_call is not None
        and iv_25_put is not None
        and atm_iv is not None
        and k_25_call is not None
        and k_25_put is not None
        and fitted.k_min - 1e-12 <= k_25_call <= fitted.k_max + 1e-12
        and fitted.k_min - 1e-12 <= k_25_put <= fitted.k_max + 1e-12
    ):
        rr_25 = float((iv_25_call - iv_25_put) * 100.0)
        bf_25 = float(((iv_25_call + iv_25_put) / 2.0 - atm_iv) * 100.0)
    else:
        iv_25_call = iv_25_call if k_25_call is not None else None
        iv_25_put = iv_25_put if k_25_put is not None else None

    left_ivs = [point.iv for point in observed if point.log_moneyness < -1e-9]
    right_ivs = [point.iv for point in observed if point.log_moneyness > 1e-9]
    down_wing = (
        float(sum(left_ivs) / len(left_ivs) - atm_iv) * 100.0
        if left_ivs and atm_iv is not None
        else None
    )
    up_wing = (
        float(sum(right_ivs) / len(right_ivs) - atm_iv) * 100.0
        if right_ivs and atm_iv is not None
        else None
    )

    p_below = p_above = p_left5 = p_right5 = p_left_s = p_right_s = None
    range_50 = range_90 = rn_mean = None
    if density is not None and density.status is not ModelStatus.REJECTED and density.quantiles:
        p_below = _mass_below(density, density.forward_usd)
        p_above = _mass_above(density, density.forward_usd)
        p_left5 = _mass_below(density, density.forward_usd * 0.95)
        p_right5 = _mass_above(density, density.forward_usd * 1.05)
        if atm_iv and t > 0:
            sigma_move = atm_iv * math.sqrt(t)
            p_left_s = _mass_below(density, density.forward_usd * math.exp(-sigma_move))
            p_right_s = _mass_above(density, density.forward_usd * math.exp(sigma_move))
        q = density.quantiles
        if "p25" in q and "p75" in q:
            range_50 = (q["p25"], q["p75"])
        if "p05" in q and "p95" in q:
            range_90 = (q["p05"], q["p95"])
        rn_mean = density.mean

    return SurfaceAnalytics(
        atm_iv=atm_iv,
        implied_move_1sd_up=move_up,
        implied_move_1sd_down=move_down,
        rr_25=rr_25,
        bf_25=bf_25,
        iv_25_call=iv_25_call,
        iv_25_put=iv_25_put,
        downside_wing_richness=down_wing,
        upside_wing_richness=up_wing,
        futures_option_basis=forward.futures_option_difference,
        p_below_forward=p_below,
        p_above_forward=p_above,
        p_left_5=p_left5,
        p_right_5=p_right5,
        p_left_sigma=p_left_s,
        p_right_sigma=p_right_s,
        central_range_50=range_50,
        central_range_90=range_90,
        risk_neutral_mean=rn_mean,
        k_25_call=k_25_call,
        k_25_put=k_25_put,
    )


def _mass_below(density: DensityResult, level: float) -> float:
    return _mass(density, lambda strike: strike < level)


def _mass_above(density: DensityResult, level: float) -> float:
    return _mass(density, lambda strike: strike > level)


def _mass(density: DensityResult, predicate) -> float:
    from scipy.integrate import trapezoid

    strikes = list(density.strikes_usd)
    raw = list(density.raw_density)
    pos = [max(value, 0.0) for value in raw]
    area = float(trapezoid(pos, strikes))
    if area <= 0:
        return 0.0
    xs = [strike for strike, _value in zip(strikes, pos) if predicate(strike)]
    ys = [value for strike, value in zip(strikes, pos) if predicate(strike)]
    if len(xs) < 2:
        return 0.0
    return float(trapezoid(ys, xs) / area)
