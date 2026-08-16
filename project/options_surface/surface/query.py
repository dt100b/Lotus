"""Surface query API: IV, total variance, delta, call, put."""

from __future__ import annotations

import math

from project.options_surface.distribution.black76 import (
    black76_call,
    black76_forward_delta,
    black76_put,
)
from project.options_surface.surface.fitters import FittedSmile
from project.options_surface.types import QueryStatus, SurfaceQueryResult


def query_smile(
    fitted: FittedSmile,
    *,
    strike_usd: float | None = None,
    log_moneyness: float | None = None,
    side: str = "call",
    rate: float = 0.0,
) -> SurfaceQueryResult:
    if fitted.diagnostics.status.value == "rejected" or not fitted.knot_k:
        return SurfaceQueryResult(
            status=QueryStatus.UNAVAILABLE,
            iv=None,
            total_variance=None,
            forward_delta=None,
            call_price_usd=None,
            put_price_usd=None,
            log_moneyness=None,
            note="smile_rejected",
        )
    if log_moneyness is None:
        if strike_usd is None or strike_usd <= 0 or fitted.forward_usd <= 0:
            return SurfaceQueryResult(
                status=QueryStatus.UNAVAILABLE,
                iv=None,
                total_variance=None,
                forward_delta=None,
                call_price_usd=None,
                put_price_usd=None,
                log_moneyness=None,
                note="need_strike_or_k",
            )
        k = math.log(float(strike_usd) / fitted.forward_usd)
    else:
        k = float(log_moneyness)
        strike_usd = fitted.forward_usd * math.exp(k)
    iv, status = fitted.iv(k)
    tw, _tw_status = fitted.total_variance(k)
    if iv is None or status is QueryStatus.EXTRAPOLATED:
        return SurfaceQueryResult(
            status=status if iv is None else QueryStatus.EXTRAPOLATED,
            iv=None,
            total_variance=tw if status is QueryStatus.EXTRAPOLATED else None,
            forward_delta=None,
            call_price_usd=None,
            put_price_usd=None,
            log_moneyness=k,
            note="outside_observed_k_range" if status is QueryStatus.EXTRAPOLATED else "iv_unavailable",
        )
    call = black76_call(
        forward_usd=fitted.forward_usd,
        strike_usd=float(strike_usd),
        time_to_expiry_years=fitted.time_to_expiry_years,
        rate=rate,
        sigma=iv,
    )
    put = black76_put(
        forward_usd=fitted.forward_usd,
        strike_usd=float(strike_usd),
        time_to_expiry_years=fitted.time_to_expiry_years,
        rate=rate,
        sigma=iv,
    )
    delta = black76_forward_delta(
        forward_usd=fitted.forward_usd,
        strike_usd=float(strike_usd),
        time_to_expiry_years=fitted.time_to_expiry_years,
        rate=rate,
        sigma=iv,
        side=side,
    )
    return SurfaceQueryResult(
        status=status,
        iv=iv,
        total_variance=tw,
        forward_delta=delta,
        call_price_usd=call,
        put_price_usd=put,
        log_moneyness=k,
    )
