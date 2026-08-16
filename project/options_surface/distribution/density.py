"""Breeden–Litzenberger density from the Black-76 call surface."""

from __future__ import annotations

from datetime import datetime
import math
from typing import Callable

import numpy as np
from scipy.integrate import cumulative_trapezoid, trapezoid

from project.options_surface.distribution.black76 import black76_call
from project.options_surface.distribution.validate import validate_density
from project.options_surface.types import (
    DensityMethod,
    DensityResult,
    DensityValidation,
    ModelStatus,
)

DEFAULT_GRID = 401
COMPARE_GRID = 201
DEFAULT_K_SPAN = 0.80


def extract_density(
    *,
    iv_from_strike: Callable[[float], float | None],
    forward_usd: float,
    time_to_expiry_years: float,
    as_of_utc: datetime,
    expiry_utc: datetime,
    rate: float = 0.0,
    k_min: float | None = None,
    k_max: float | None = None,
    grid_points: int = DEFAULT_GRID,
    compare_grid_points: int = COMPARE_GRID,
) -> DensityResult:
    lo = -DEFAULT_K_SPAN if k_min is None else float(k_min)
    hi = DEFAULT_K_SPAN if k_max is None else float(k_max)
    strikes, raw = _second_derivative_density(
        iv_from_strike=iv_from_strike,
        forward_usd=forward_usd,
        time_to_expiry_years=time_to_expiry_years,
        rate=rate,
        k_min=lo,
        k_max=hi,
        grid_points=grid_points,
    )
    compare = _second_derivative_density(
        iv_from_strike=iv_from_strike,
        forward_usd=forward_usd,
        time_to_expiry_years=time_to_expiry_years,
        rate=rate,
        k_min=lo,
        k_max=hi,
        grid_points=compare_grid_points,
    )
    validation = validate_density(
        strikes_usd=strikes,
        raw_density=raw,
        forward_usd=forward_usd,
        time_to_expiry_years=time_to_expiry_years,
        rate=rate,
        iv_from_strike=iv_from_strike,
        compare_strikes=compare[0],
        compare_density=compare[1],
    )
    cdf = _cdf(strikes, raw)
    quantiles: dict[str, float] = {}
    mean = None
    if validation.status is not ModelStatus.REJECTED:
        quantiles = _quantiles(strikes, raw, (0.05, 0.16, 0.25, 0.50, 0.75, 0.84, 0.95))
        pos = np.clip(raw, 0.0, None)
        area = float(trapezoid(pos, strikes))
        if area > 0:
            mean = float(trapezoid(strikes * pos, strikes) / area)
    return DensityResult(
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        forward_usd=float(forward_usd),
        status=validation.status,
        strikes_usd=tuple(float(x) for x in strikes),
        raw_density=tuple(float(x) for x in raw),
        cdf=tuple(float(x) for x in cdf),
        quantiles=quantiles,
        mean=mean,
        validation=validation,
        display_smooth=None,
    )


def _second_derivative_density(
    *,
    iv_from_strike: Callable[[float], float | None],
    forward_usd: float,
    time_to_expiry_years: float,
    rate: float,
    k_min: float,
    k_max: float,
    grid_points: int,
) -> tuple[np.ndarray, np.ndarray]:
    # Uniform strike grid. Second derivatives use a local, independent
    # stencil so ITM cancellation on a coarse global grid does not dominate.
    strike_lo = float(forward_usd) * math.exp(float(k_min))
    strike_hi = float(forward_usd) * math.exp(float(k_max))
    strikes = np.linspace(strike_lo, strike_hi, int(grid_points))
    raw = np.zeros(strikes.shape, dtype=float)
    df_inv = math.exp(rate * time_to_expiry_years)
    h = max(0.002 * float(forward_usd), 1.0)
    for i, strike in enumerate(strikes):
        density = _point_density(
            strike=float(strike),
            h=h,
            iv_from_strike=iv_from_strike,
            forward_usd=float(forward_usd),
            time_to_expiry_years=float(time_to_expiry_years),
            rate=rate,
            df_inv=df_inv,
        )
        raw[i] = 0.0 if density is None else density
    return strikes.astype(float), raw.astype(float)


def _point_density(
    *,
    strike: float,
    h: float,
    iv_from_strike,
    forward_usd: float,
    time_to_expiry_years: float,
    rate: float,
    df_inv: float,
) -> float | None:
    if strike - h <= 0:
        return None
    ivs = [iv_from_strike(strike + offset) for offset in (-h, 0.0, h)]
    if any(iv is None or iv <= 0 for iv in ivs):
        return None
    calls = [
        black76_call(
            forward_usd=forward_usd,
            strike_usd=strike + offset,
            time_to_expiry_years=time_to_expiry_years,
            rate=rate,
            sigma=float(iv),
        )
        for offset, iv in zip((-h, 0.0, h), ivs)
    ]
    return float(df_inv * (calls[0] - 2.0 * calls[1] + calls[2]) / (h * h))


def survival_probability(
    strikes: np.ndarray,
    density: np.ndarray,
    level: float,
    *,
    clip_negative: bool = False,
) -> float:
    """∫_{level}^{∞} q(K) dK from the raw (or clipped) density via the CDF."""
    values = np.clip(density, 0.0, None) if clip_negative else np.asarray(density, dtype=float)
    if len(strikes) < 2:
        return 0.0
    cdf = cumulative_trapezoid(values, strikes, initial=0.0)
    total = float(cdf[-1])
    below = float(np.interp(level, strikes, cdf, left=0.0, right=total))
    return total - below


def _cdf(strikes: np.ndarray, density: np.ndarray) -> np.ndarray:
    if len(strikes) < 2:
        return np.zeros_like(strikes)
    pos = np.clip(density, 0.0, None)
    integral = cumulative_trapezoid(pos, strikes, initial=0.0)
    total = float(integral[-1])
    if total <= 0:
        return np.zeros_like(strikes)
    return integral / total


def _quantiles(
    strikes: np.ndarray,
    density: np.ndarray,
    levels: tuple[float, ...],
) -> dict[str, float]:
    cdf = _cdf(strikes, density)
    labels = {
        0.05: "p05",
        0.16: "p16",
        0.25: "p25",
        0.50: "p50",
        0.75: "p75",
        0.84: "p84",
        0.95: "p95",
    }
    out: dict[str, float] = {}
    for level in levels:
        out[labels.get(level, f"p{int(level * 100):02d}")] = float(
            np.interp(level, cdf, strikes)
        )
    return out
