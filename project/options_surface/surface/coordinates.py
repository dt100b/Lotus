"""Forward log-moneyness, total variance, and forward delta."""

from __future__ import annotations

import math

from project.options_surface.distribution.black76 import black76_forward_delta


def log_moneyness(strike_usd: float, forward_usd: float) -> float:
    if strike_usd <= 0 or forward_usd <= 0:
        raise ValueError("log-moneyness requires positive strike and forward.")
    return math.log(float(strike_usd) / float(forward_usd))


def total_variance(iv: float, time_to_expiry_years: float) -> float:
    if time_to_expiry_years < 0:
        raise ValueError("Time to expiry cannot be negative.")
    return float(iv) * float(iv) * float(time_to_expiry_years)


def iv_from_total_variance(total_var: float, time_to_expiry_years: float) -> float | None:
    if time_to_expiry_years <= 0 or total_var < 0:
        return None
    return math.sqrt(float(total_var) / float(time_to_expiry_years))


def forward_delta(
    *,
    strike_usd: float,
    forward_usd: float,
    iv: float,
    time_to_expiry_years: float,
    rate: float,
    side: str,
) -> float | None:
    return black76_forward_delta(
        forward_usd=forward_usd,
        strike_usd=strike_usd,
        time_to_expiry_years=time_to_expiry_years,
        rate=rate,
        sigma=iv,
        side=side,
    )
