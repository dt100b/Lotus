"""USD-equivalent Black-76 layer. Inverse BTC premiums are never used here."""

from __future__ import annotations

import math

from scipy.stats import norm

DEFAULT_RATE = 0.0


def _d1_d2(
    forward_usd: float,
    strike_usd: float,
    time_to_expiry_years: float,
    sigma: float,
) -> tuple[float, float] | None:
    if (
        forward_usd <= 0
        or strike_usd <= 0
        or time_to_expiry_years <= 0
        or sigma <= 0
    ):
        return None
    sqrt_t = math.sqrt(time_to_expiry_years)
    d1 = (
        math.log(forward_usd / strike_usd) + 0.5 * sigma * sigma * time_to_expiry_years
    ) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    return d1, d2


def black76_call(
    *,
    forward_usd: float,
    strike_usd: float,
    time_to_expiry_years: float,
    rate: float = DEFAULT_RATE,
    sigma: float,
) -> float:
    """C(K,T) = e^{-rT} [F N(d1) - K N(d2)]."""
    if time_to_expiry_years <= 0:
        return max(forward_usd - strike_usd, 0.0) * math.exp(-rate * max(time_to_expiry_years, 0.0))
    pair = _d1_d2(forward_usd, strike_usd, time_to_expiry_years, sigma)
    if pair is None:
        df = math.exp(-rate * time_to_expiry_years)
        return df * max(forward_usd - strike_usd, 0.0)
    d1, d2 = pair
    df = math.exp(-rate * time_to_expiry_years)
    return float(df * (forward_usd * norm.cdf(d1) - strike_usd * norm.cdf(d2)))


def black76_put(
    *,
    forward_usd: float,
    strike_usd: float,
    time_to_expiry_years: float,
    rate: float = DEFAULT_RATE,
    sigma: float,
) -> float:
    call = black76_call(
        forward_usd=forward_usd,
        strike_usd=strike_usd,
        time_to_expiry_years=time_to_expiry_years,
        rate=rate,
        sigma=sigma,
    )
    df = math.exp(-rate * time_to_expiry_years)
    return float(call - df * (forward_usd - strike_usd))


def black76_forward_delta(
    *,
    forward_usd: float,
    strike_usd: float,
    time_to_expiry_years: float,
    rate: float = DEFAULT_RATE,
    sigma: float,
    side: str,
) -> float | None:
    """Undiscounted Black-76 forward delta: N(d1) for calls, N(d1)-1 for puts."""
    option_side = str(side).strip().lower()
    if option_side not in {"call", "put"}:
        return None
    pair = _d1_d2(forward_usd, strike_usd, time_to_expiry_years, sigma)
    if pair is None:
        if math.isclose(forward_usd, strike_usd, rel_tol=1e-12, abs_tol=1e-9):
            return 0.5 if option_side == "call" else -0.5
        if option_side == "call":
            return 1.0 if forward_usd > strike_usd else 0.0
        return -1.0 if forward_usd < strike_usd else 0.0
    call_delta = float(norm.cdf(pair[0]))
    return call_delta if option_side == "call" else call_delta - 1.0


def black76_digital_call(
    *,
    forward_usd: float,
    strike_usd: float,
    time_to_expiry_years: float,
    rate: float = DEFAULT_RATE,
    sigma: float,
) -> float:
    """e^{-rT} N(d2) = discounted risk-neutral Q(S_T > K)."""
    pair = _d1_d2(forward_usd, strike_usd, time_to_expiry_years, sigma)
    df = math.exp(-rate * time_to_expiry_years)
    if pair is None:
        return df * (1.0 if forward_usd > strike_usd else 0.0)
    return float(df * norm.cdf(pair[1]))


def lognormal_density(
    strike_usd: float,
    *,
    forward_usd: float,
    time_to_expiry_years: float,
    sigma: float,
) -> float:
    """Analytical Black-76 / lognormal terminal density q(K)."""
    pair = _d1_d2(forward_usd, strike_usd, time_to_expiry_years, sigma)
    if pair is None or strike_usd <= 0:
        return 0.0
    _d1, d2 = pair
    return float(
        norm.pdf(d2) / (strike_usd * sigma * math.sqrt(time_to_expiry_years))
    )
