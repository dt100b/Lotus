"""Fail-closed density validation. No clipping to manufacture probabilities."""

from __future__ import annotations

import math
from typing import Callable, Sequence

import numpy as np
from scipy.integrate import trapezoid

from project.options_surface.distribution.black76 import black76_call
from project.options_surface.types import DensityMethod, DensityValidation, ModelStatus

MASS_ACCEPT = 0.02
MASS_REJECT = 0.10
MOMENT_ACCEPT = 0.01
MOMENT_REJECT = 0.05
NEG_ACCEPT = 1e-8
NEG_REJECT = 0.01
GRID_Q50_TOL = 0.005
DIGITAL_TOL_ACCEPT = 0.03
DIGITAL_TOL_REJECT = 0.08


def validate_density(
    *,
    strikes_usd: Sequence[float],
    raw_density: Sequence[float],
    forward_usd: float,
    time_to_expiry_years: float,
    rate: float,
    iv_from_strike: Callable[[float], float | None],
    compare_strikes: Sequence[float] | None = None,
    compare_density: Sequence[float] | None = None,
) -> DensityValidation:
    strikes = np.asarray(list(strikes_usd), dtype=float)
    raw = np.asarray(list(raw_density), dtype=float)
    notes: list[str] = []
    if len(strikes) < 5 or len(strikes) != len(raw):
        return _rejected("insufficient_grid", grid_points=len(strikes))

    mass = float(trapezoid(raw, strikes))
    negative = np.clip(-raw, 0.0, None)
    raw_negative_mass = float(trapezoid(negative, strikes))
    nonnegative = bool(raw_negative_mass <= NEG_ACCEPT)

    pos = np.clip(raw, 0.0, None)
    pos_mass = float(trapezoid(pos, strikes))
    if pos_mass > 0:
        mean = float(trapezoid(strikes * pos, strikes) / pos_mass)
        moment_error = abs(mean - forward_usd) / forward_usd if forward_usd else None
    else:
        mean = None
        moment_error = None
        notes.append("nonpositive_mass")

    cdf = _raw_cdf(strikes, raw)
    diffs = np.diff(cdf)
    cdf_monotone = bool(np.all(diffs >= -1e-8))
    cdf_start = float(cdf[0]) if len(cdf) else None
    cdf_end = float(cdf[-1]) if len(cdf) else None
    if not cdf_monotone:
        notes.append("cdf_not_monotone")

    edge = 0.0
    if pos_mass > 0:
        edge = float((pos[0] + pos[-1]) * 0.5 * (strikes[-1] - strikes[0]) / max(len(strikes) - 1, 1))
        # Tail mass outside a more informative measure: leftover vs 1.
        leftover = abs(1.0 - pos_mass)
        edge = leftover
    truncation_warning = bool(edge > 0.03)
    if truncation_warning:
        notes.append("edge_mass_or_truncation")

    grid_converged = None
    if compare_strikes is not None and compare_density is not None:
        grid_converged = _grids_agree(
            strikes, raw, np.asarray(compare_strikes, dtype=float), np.asarray(compare_density, dtype=float)
        )
        if grid_converged is False:
            notes.append("grid_not_converged")

    digital_err = _digital_error(
        strikes,
        raw,
        forward_usd=forward_usd,
        time_to_expiry_years=time_to_expiry_years,
        rate=rate,
        iv_from_strike=iv_from_strike,
    )
    if digital_err is not None and digital_err > DIGITAL_TOL_ACCEPT:
        notes.append(f"digital_atm_error={digital_err:.4f}")

    status = ModelStatus.ACCEPTED
    if (
        raw_negative_mass > NEG_REJECT
        or not math.isfinite(mass)
        or abs(mass - 1.0) > MASS_REJECT
        or not cdf_monotone
        or (moment_error is not None and moment_error > MOMENT_REJECT)
        or (digital_err is not None and digital_err > DIGITAL_TOL_REJECT)
        or pos_mass <= 0
    ):
        status = ModelStatus.REJECTED
        notes.append("density_rejected")
    elif (
        raw_negative_mass > NEG_ACCEPT
        or abs(mass - 1.0) > MASS_ACCEPT
        or (moment_error is not None and moment_error > MOMENT_ACCEPT)
        or truncation_warning
        or grid_converged is False
        or (digital_err is not None and digital_err > DIGITAL_TOL_ACCEPT)
    ):
        status = ModelStatus.DEGRADED
        notes.append("density_degraded")

    return DensityValidation(
        status=status,
        method=DensityMethod.BREEDEN_LITZENBERGER_BLACK76,
        mass=mass,
        raw_negative_mass=raw_negative_mass,
        nonnegative=nonnegative,
        cdf_monotone=cdf_monotone,
        cdf_start=cdf_start,
        cdf_end=cdf_end,
        forward_moment=mean,
        forward_moment_error=moment_error,
        edge_mass=edge,
        truncation_warning=truncation_warning,
        grid_points=int(len(strikes)),
        grid_converged=grid_converged,
        digital_atm_error=digital_err,
        notes=tuple(notes),
    )


def _raw_cdf(strikes: np.ndarray, density: np.ndarray) -> np.ndarray:
    from scipy.integrate import cumulative_trapezoid

    # CDF of the *raw* density, not the clipped one, so monotonicity
    # failures from negative mass remain visible.
    integral = cumulative_trapezoid(density, strikes, initial=0.0)
    return integral


def _grids_agree(
    strikes_a: np.ndarray,
    dens_a: np.ndarray,
    strikes_b: np.ndarray,
    dens_b: np.ndarray,
) -> bool:
    q_a = _quantile(strikes_a, dens_a, 0.50)
    q_b = _quantile(strikes_b, dens_b, 0.50)
    if q_a is None or q_b is None or q_a <= 0:
        return False
    return abs(q_a - q_b) / q_a <= GRID_Q50_TOL


def _quantile(strikes: np.ndarray, density: np.ndarray, level: float) -> float | None:
    from scipy.integrate import cumulative_trapezoid

    pos = np.clip(density, 0.0, None)
    cdf = cumulative_trapezoid(pos, strikes, initial=0.0)
    if float(cdf[-1]) <= 0:
        return None
    cdf = cdf / float(cdf[-1])
    return float(np.interp(level, cdf, strikes))


def _digital_error(
    strikes: np.ndarray,
    density: np.ndarray,
    *,
    forward_usd: float,
    time_to_expiry_years: float,
    rate: float,
    iv_from_strike: Callable[[float], float | None],
) -> float | None:
    """|Q(S>F) from density − vertical-spread digital at ATM|."""
    from project.options_surface.distribution.density import survival_probability

    p_above = survival_probability(strikes, np.asarray(density, dtype=float), forward_usd)
    h = 0.002 * forward_usd
    iv = iv_from_strike(forward_usd)
    iv_lo = iv_from_strike(forward_usd - h)
    iv_hi = iv_from_strike(forward_usd + h)
    if iv is None or iv_lo is None or iv_hi is None:
        return None
    c_lo = black76_call(
        forward_usd=forward_usd,
        strike_usd=forward_usd - h,
        time_to_expiry_years=time_to_expiry_years,
        rate=rate,
        sigma=iv_lo,
    )
    c_hi = black76_call(
        forward_usd=forward_usd,
        strike_usd=forward_usd + h,
        time_to_expiry_years=time_to_expiry_years,
        rate=rate,
        sigma=iv_hi,
    )
    digital = (c_lo - c_hi) / (2.0 * h)
    df = math.exp(rate * time_to_expiry_years)
    q_spread = digital * df
    return abs(p_above - q_spread)


def _rejected(note: str, *, grid_points: int) -> DensityValidation:
    return DensityValidation(
        status=ModelStatus.REJECTED,
        method=DensityMethod.BREEDEN_LITZENBERGER_BLACK76,
        mass=None,
        raw_negative_mass=0.0,
        nonnegative=False,
        cdf_monotone=False,
        cdf_start=None,
        cdf_end=None,
        forward_moment=None,
        forward_moment_error=None,
        edge_mass=None,
        truncation_warning=True,
        grid_points=grid_points,
        grid_converged=None,
        digital_atm_error=None,
        notes=(note,),
    )
