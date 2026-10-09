"""Robust quality weights for smile observations."""

from __future__ import annotations

import math

from project.options_surface.types import NativeOptionQuote


def observation_weight_components(
    quote: NativeOptionQuote,
    *,
    log_moneyness: float | None,
    quote_age_seconds: float | None,
    two_sided: bool,
    fallback: bool,
    atm_iv: float | None = None,
) -> dict[str, float | None]:
    """Every factor used to build `fit_weight`. Formula is unchanged."""
    iv_width = None
    if quote.bid_iv is not None and quote.ask_iv is not None:
        iv_width = max(quote.ask_iv - quote.bid_iv, 0.0)
    ref_width = 0.04
    if atm_iv is not None and atm_iv > 0:
        ref_width = max(0.02, 0.15 * atm_iv)
    if iv_width is None:
        w_spread = 0.35
    else:
        w_spread = 1.0 / (1.0 + (iv_width / ref_width) ** 2)

    w_premium = 1.0
    premium_rel = None
    if (
        quote.bid_price_btc is not None
        and quote.ask_price_btc is not None
        and quote.bid_price_btc > 0
        and quote.ask_price_btc > 0
    ):
        mid = 0.5 * (quote.bid_price_btc + quote.ask_price_btc)
        if mid >= 0.01:
            premium_rel = (quote.ask_price_btc - quote.bid_price_btc) / mid
            w_premium = 1.0 / (1.0 + (premium_rel / 0.35) ** 2)

    if quote_age_seconds is None:
        w_age = 0.5
    else:
        w_age = math.exp(-max(quote_age_seconds, 0.0) / 15.0)

    if quote.open_interest is None:
        w_oi = 0.6
    else:
        w_oi = min(1.0, math.sqrt(max(quote.open_interest, 0.0) / 10.0))

    if log_moneyness is None:
        w_k = 0.75
    else:
        w_k = math.exp(-0.5 * (float(log_moneyness) / 0.30) ** 2)

    if two_sided and not fallback:
        w_quality = 1.0
    elif two_sided:
        w_quality = 0.35
    else:
        w_quality = 0.12

    raw = w_spread * w_premium * w_age * w_oi * w_k * w_quality
    if not math.isfinite(raw) or raw <= 0.0:
        fit_weight = 0.0
    else:
        fit_weight = float(min(raw, 1.0))
    return {
        "w_spread": float(w_spread),
        "w_premium": float(w_premium),
        "w_age": float(w_age),
        "w_oi": float(w_oi),
        "w_k": float(w_k),
        "w_quality": float(w_quality),
        "iv_width": None if iv_width is None else float(iv_width),
        "ref_width": float(ref_width),
        "premium_rel_spread": None if premium_rel is None else float(premium_rel),
        "quote_age_seconds": None if quote_age_seconds is None else float(quote_age_seconds),
        "open_interest": quote.open_interest,
        "log_moneyness": None if log_moneyness is None else float(log_moneyness),
        "two_sided": 1.0 if two_sided else 0.0,
        "fallback": 1.0 if fallback else 0.0,
        "fit_weight": fit_weight,
    }


def observation_weight(
    quote: NativeOptionQuote,
    *,
    log_moneyness: float | None,
    quote_age_seconds: float | None,
    two_sided: bool,
    fallback: bool,
    atm_iv: float | None = None,
) -> float:
    """Documented product of spread, age, OI, moneyness, and quote-quality factors.

    A verified two-sided quote can reach weight 1. A fallback or one-sided
    quote is capped well below that so it cannot dominate the fit.
    """
    components = observation_weight_components(
        quote,
        log_moneyness=log_moneyness,
        quote_age_seconds=quote_age_seconds,
        two_sided=two_sided,
        fallback=fallback,
        atm_iv=atm_iv,
    )
    return float(components["fit_weight"] or 0.0)
