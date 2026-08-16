"""Static-arbitrage diagnostics. Violations are reported, never clamped."""

from __future__ import annotations

import math
from typing import Callable, Sequence

import numpy as np

from project.options_surface.distribution.black76 import black76_call
from project.options_surface.types import ArbitrageReport

MONOTONE_TOL = 1e-10
CONVEX_TOL = 1e-8
VARIANCE_TOL = 1e-12
CALENDAR_TOL = 1e-8


def diagnose_slice_arbitrage(
    *,
    strikes_usd: Sequence[float],
    call_prices: Sequence[float] | None = None,
    total_variances: Sequence[float] | None = None,
    forward_usd: float | None = None,
    time_to_expiry_years: float | None = None,
    iv_from_k: Callable[[float], float | None] | None = None,
    rate: float = 0.0,
) -> ArbitrageReport:
    strikes = np.asarray(list(strikes_usd), dtype=float)
    order = np.argsort(strikes)
    strikes = strikes[order]
    violations: list[str] = []

    if total_variances is not None:
        tw = np.asarray(list(total_variances), dtype=float)[order]
        min_w = float(np.min(tw)) if len(tw) else None
        positive = bool(min_w is not None and min_w > -VARIANCE_TOL)
        if not positive:
            violations.append("non_positive_total_variance")
    else:
        min_w = None
        positive = True

    if call_prices is None:
        if iv_from_k is None or forward_usd is None or time_to_expiry_years is None:
            return ArbitrageReport(
                positive_variance=positive,
                call_monotone=True,
                call_convex=True,
                butterfly_ok=True,
                calendar_ok=None,
                min_total_variance=min_w,
                min_call_step=None,
                min_butterfly=None,
                min_calendar_dw=None,
                violations=tuple(violations),
            )
        prices = []
        for strike in strikes:
            k = math.log(float(strike) / float(forward_usd))
            iv = iv_from_k(k)
            if iv is None or iv <= 0:
                prices.append(float("nan"))
            else:
                prices.append(
                    black76_call(
                        forward_usd=float(forward_usd),
                        strike_usd=float(strike),
                        time_to_expiry_years=float(time_to_expiry_years),
                        rate=rate,
                        sigma=float(iv),
                    )
                )
        call = np.asarray(prices, dtype=float)
    else:
        call = np.asarray(list(call_prices), dtype=float)[order]

    finite = np.isfinite(call)
    if int(np.count_nonzero(finite)) < 3:
        violations.append("insufficient_call_grid")
        return ArbitrageReport(
            positive_variance=positive,
            call_monotone=False,
            call_convex=False,
            butterfly_ok=False,
            calendar_ok=None,
            min_total_variance=min_w,
            min_call_step=None,
            min_butterfly=None,
            min_calendar_dw=None,
            violations=tuple(violations),
        )

    steps = np.diff(call)
    min_step = float(np.min(steps))
    monotone = bool(min_step <= MONOTONE_TOL)
    # Calls must be decreasing in K: C[i+1] - C[i] <= tol, i.e. min_step should be <= 0
    # Wait: C[i+1] <= C[i] means steps = C[i+1]-C[i] <= 0, so min_step <= 0 is expected,
    # and we fail if any step is positive beyond tolerance: max(steps) > MONOTONE_TOL
    max_step = float(np.max(steps))
    monotone = bool(max_step <= MONOTONE_TOL)
    min_call_step = max_step
    if not monotone:
        violations.append("call_not_decreasing_in_strike")

    butterflies = call[:-2] - 2.0 * call[1:-1] + call[2:]
    # For non-uniform grids this is only approximate. Prefer uniform grids.
    min_bf = float(np.min(butterflies))
    convex = bool(min_bf >= -CONVEX_TOL)
    if not convex:
        violations.append("call_not_convex_in_strike")

    return ArbitrageReport(
        positive_variance=positive,
        call_monotone=monotone,
        call_convex=convex,
        butterfly_ok=convex,
        calendar_ok=None,
        min_total_variance=min_w,
        min_call_step=min_call_step,
        min_butterfly=min_bf,
        min_calendar_dw=None,
        violations=tuple(violations),
    )


def calendar_violations(
    short_w: Sequence[float],
    long_w: Sequence[float],
    *,
    k_grid: Sequence[float],
    tolerance: float = CALENDAR_TOL,
) -> tuple[bool, float | None, tuple[str, ...]]:
    """Require w(k, T2) >= w(k, T1) - tolerance on a shared k grid."""
    left = np.asarray(list(short_w), dtype=float)
    right = np.asarray(list(long_w), dtype=float)
    ks = np.asarray(list(k_grid), dtype=float)
    if left.shape != right.shape or left.shape != ks.shape:
        return False, None, ("calendar_grid_mismatch",)
    dw = right - left
    min_dw = float(np.nanmin(dw))
    ok = bool(min_dw >= -tolerance)
    violations = () if ok else (f"calendar_w_decreases:min_dw={min_dw:.6g}",)
    return ok, min_dw, violations
