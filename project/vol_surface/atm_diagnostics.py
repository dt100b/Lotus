"""Independent BTC inverse-option price inversion; diagnostics, not execution quotes.

Deribit's documented R=log(F/index)/T makes exp(-R*T)*F/index=1.
Dividing its USD Black price by the index therefore gives the normalized
Black price below directly in BTC. Applying another discount would double count
the basis. Use the individual ticker's forward and timestamp, not a batch median.
"""
from __future__ import annotations

import math

from scipy.optimize import brentq
from scipy.special import ndtr

from greeks.types import GreekSnapshot
from vol_surface.surface import YEAR_SECONDS


def inverse_option_price(iv: float, *, strike: float, forward: float,
                         years: float, side: str) -> float:
    x = strike / forward
    if iv == 0:
        return max(1-x, 0) if side == "call" else max(x-1, 0)
    s = iv * math.sqrt(years)
    d1 = -math.log(x)/s + s/2
    d2 = d1-s
    return float(ndtr(d1)-x*ndtr(d2) if side == "call" else x*ndtr(-d2)-ndtr(-d1))


def price_iv(price: float, *, strike: float, forward: float,
             years: float, side: str) -> float | None:
    if (side not in {"call", "put"} or not all(math.isfinite(v) and v > 0
            for v in (price, strike, forward, years))):
        return None
    args = dict(strike=strike, forward=forward, years=years, side=side)
    lower = inverse_option_price(0, **args)
    upper = inverse_option_price(5, **args)
    if not lower < price <= upper:
        return None
    return float(brentq(lambda iv: inverse_option_price(iv, **args)-price, 1e-12, 5))


def midpoint_diagnostic(snapshot: GreekSnapshot, *, strike: float, expiry: int,
                        side: str) -> tuple[float | None, str | None]:
    years = (expiry-snapshot.snapshot_ts)/(YEAR_SECONDS*1000)
    # Expiring options have special settlement-period underlying conventions.
    if years <= 1800/YEAR_SECONDS:
        return None, "settlement_window"
    if snapshot.bid_price is None or snapshot.ask_price is None:
        return None, "missing_prices"
    args = dict(strike=strike, forward=snapshot.spot_price, years=years, side=side)
    bid = price_iv(snapshot.bid_price, **args)
    ask = price_iv(snapshot.ask_price, **args)
    if bid is None or ask is None:
        return None, "price_outside_inversion_bounds"
    # Refuse to present a convention mismatch as a mark/mid disagreement.
    if (snapshot.bid_iv is None or snapshot.ask_iv is None
            or abs(bid*100-snapshot.bid_iv) > .5
            or abs(ask*100-snapshot.ask_iv) > .5):
        return None, "ticker_iv_repricing_mismatch"
    return price_iv((snapshot.bid_price+snapshot.ask_price)/2, **args), None
