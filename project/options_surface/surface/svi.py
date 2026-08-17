"""Raw SVI total-variance primitives.

These functions evaluate Gatheral raw SVI and the butterfly factor g(k).
They do not clip, floor, or otherwise conceal invalid values.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

W_MIN = 1e-8
G_TOL = 1e-8
LEE_SLACK = 1e-6
RHO_MAX = 0.999
SIGMA_MIN = 1e-4


def as_theta(values: Sequence[float]) -> np.ndarray:
    theta = np.asarray(list(values), dtype=float)
    if theta.shape != (5,):
        raise ValueError("raw SVI theta must be (a, b, rho, m, sigma)")
    return theta


def svi_w(k: float | np.ndarray, theta: Sequence[float]) -> np.ndarray:
    a, b, rho, m, sigma = as_theta(theta)
    grid = np.asarray(k, dtype=float)
    x = grid - m
    return a + b * (rho * x + np.sqrt(x * x + sigma * sigma))


def svi_dw(k: float | np.ndarray, theta: Sequence[float]) -> np.ndarray:
    _a, b, rho, m, sigma = as_theta(theta)
    grid = np.asarray(k, dtype=float)
    x = grid - m
    dist = np.sqrt(x * x + sigma * sigma)
    return b * (rho + x / np.maximum(dist, 1e-16))


def svi_d2w(k: float | np.ndarray, theta: Sequence[float]) -> np.ndarray:
    _a, b, _rho, m, sigma = as_theta(theta)
    grid = np.asarray(k, dtype=float)
    x = grid - m
    dist = np.sqrt(x * x + sigma * sigma)
    return b * (sigma * sigma) / np.maximum(dist**3, 1e-24)


def svi_g(k: float | np.ndarray, theta: Sequence[float]) -> np.ndarray:
    """Gatheral butterfly factor. Negative values are returned, not clipped."""
    grid = np.asarray(k, dtype=float)
    total = svi_w(grid, theta)
    first = svi_dw(grid, theta)
    second = svi_d2w(grid, theta)
    safe = np.where(total > 1e-16, total, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        term1 = (1.0 - grid * first / (2.0 * safe)) ** 2
        term2 = (first * first / 4.0) * (1.0 / safe + 0.25)
        value = term1 - term2 + 0.5 * second
    return np.where(np.isfinite(value), value, np.full_like(grid, -1.0, dtype=float))


def svi_min_total_variance(theta: Sequence[float]) -> float:
    a, b, rho, _m, sigma = as_theta(theta)
    return float(a + b * sigma * math.sqrt(max(1.0 - rho * rho, 0.0)))


def lee_headroom(theta: Sequence[float]) -> float:
    _a, b, rho, _m, _sigma = as_theta(theta)
    return float((4.0 - LEE_SLACK) - b * (1.0 + abs(rho)))


def project_theta(
    theta: Sequence[float],
    *,
    k_min: float,
    k_max: float,
) -> np.ndarray:
    """Project onto parameter bounds and the necessary Lee / min-w conditions."""
    a, b, rho, m, sigma = [float(value) for value in as_theta(theta)]
    a = min(max(a, 0.0), 4.0)
    b = min(max(b, 0.0), 4.0)
    rho = min(max(rho, -RHO_MAX), RHO_MAX)
    span_lo = max(k_min - 0.5, -2.0)
    span_hi = min(k_max + 0.5, 2.0)
    if span_hi < span_lo:
        span_lo, span_hi = -2.0, 2.0
    m = min(max(m, span_lo), span_hi)
    sigma = min(max(sigma, SIGMA_MIN), 2.0)
    projected = np.asarray([a, b, rho, m, sigma], dtype=float)
    headroom = lee_headroom(projected)
    if headroom < 0.0 and b > 0.0:
        scale = (4.0 - LEE_SLACK) / (b * (1.0 + abs(rho)))
        projected[1] = max(b * scale, 0.0)
    min_w = svi_min_total_variance(projected)
    if min_w < W_MIN:
        projected[0] = float(projected[0] + (W_MIN - min_w))
        projected[0] = min(max(projected[0], 0.0), 4.0)
    return projected


def parameter_bounds(k_min: float, k_max: float) -> tuple[np.ndarray, np.ndarray]:
    span_lo = max(k_min - 0.5, -2.0)
    span_hi = min(k_max + 0.5, 2.0)
    if span_hi < span_lo:
        span_lo, span_hi = -2.0, 2.0
    lower = np.asarray([0.0, 0.0, -RHO_MAX, span_lo, SIGMA_MIN], dtype=float)
    upper = np.asarray([4.0, 4.0, RHO_MAX, span_hi, 2.0], dtype=float)
    return lower, upper


def ssvi_to_raw(theta_atm: float, phi: float, rho: float) -> np.ndarray:
    """Map a Gatheral–Jacquier SSVI slice into raw SVI coordinates."""
    rho = float(min(max(rho, -RHO_MAX), RHO_MAX))
    phi = float(max(phi, 1e-8))
    theta_atm = float(max(theta_atm, W_MIN))
    a = 0.5 * theta_atm * (1.0 - rho * rho)
    b = 0.5 * theta_atm * phi
    m = -rho / phi
    sigma = math.sqrt(max(1.0 - rho * rho, 1e-12)) / phi
    return np.asarray([a, b, rho, m, sigma], dtype=float)


def diagnose_svi_slice(
    theta: Sequence[float],
    *,
    k_min: float,
    k_max: float,
    grid_points: int = 41,
) -> dict[str, float | bool | None]:
    if grid_points < 3 or k_max <= k_min:
        return {
            "min_w": None,
            "min_g": None,
            "lee_headroom": lee_headroom(theta),
            "positive_variance": False,
            "butterfly_ok": False,
        }
    ks = np.linspace(float(k_min), float(k_max), int(grid_points))
    weights = svi_w(ks, theta)
    butterflies = svi_g(ks, theta)
    min_w = float(np.min(weights)) if len(weights) else None
    min_g = float(np.min(butterflies)) if len(butterflies) else None
    return {
        "min_w": min_w,
        "min_g": min_g,
        "lee_headroom": lee_headroom(theta),
        "positive_variance": bool(min_w is not None and min_w > -W_MIN),
        "butterfly_ok": bool(min_g is not None and min_g >= -G_TOL),
    }
