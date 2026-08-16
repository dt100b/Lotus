"""Accept or reject native quotes with explicit reason codes."""

from __future__ import annotations

from datetime import datetime
from typing import Sequence

from project.options_surface.normalization.weights import observation_weight
from project.options_surface.timeutil import as_utc
from project.options_surface.types import (
    NativeOptionQuote,
    QuoteObservation,
    RejectionReason,
)

MARK_IV_BOUND_TOLERANCE = 0.0025  # 0.25 vol points in absolute units
DEFAULT_MAX_QUOTE_AGE_SECONDS = 30.0
ATM_IV_SPREAD_CAP = 0.15
WING_IV_SPREAD_CAP = 0.35
SPREAD_WING_ABS_K = 0.20
MIN_PREMIUM_FOR_REL_SPREAD = 0.01
ATM_REL_SPREAD_CAP = 0.60
WING_REL_SPREAD_CAP = 1.20


def classify_quotes(
    quotes: Sequence[NativeOptionQuote],
    *,
    as_of_utc: datetime,
    expiry_date: str,
    max_quote_age_seconds: float = DEFAULT_MAX_QUOTE_AGE_SECONDS,
    require_open_state: bool = True,
    require_iv_market: bool = True,
    require_sizes: bool = True,
) -> tuple[QuoteObservation, ...]:
    as_of = as_utc(as_of_utc)
    observations: list[QuoteObservation] = []
    seen: dict[tuple[float, str], int] = {}

    for quote in quotes:
        reason = _reject_reason(
            quote,
            as_of=as_of,
            expiry_date=expiry_date,
            max_quote_age_seconds=max_quote_age_seconds,
            require_open_state=require_open_state,
            require_iv_market=require_iv_market,
            require_sizes=require_sizes,
        )
        key = (round(quote.strike_usd, 8), quote.option_side)
        if reason is None and key in seen:
            reason = RejectionReason.DUPLICATE
        two_sided = _two_sided(quote)
        age = _age_seconds(quote, as_of)
        weight = 0.0
        if reason is None:
            weight = observation_weight(
                quote,
                log_moneyness=None,
                quote_age_seconds=age,
                two_sided=two_sided,
                fallback=False,
                atm_iv=quote.mark_iv,
            )
            seen[key] = seen.get(key, 0) + 1
        observations.append(
            QuoteObservation(
                quote=quote,
                accepted=reason is None,
                rejection_reason=reason,
                mark_iv=quote.mark_iv if reason is None else quote.mark_iv,
                bid_iv=quote.bid_iv,
                ask_iv=quote.ask_iv,
                quote_age_seconds=age,
                two_sided=two_sided,
                fit_weight=weight,
            )
        )
    return tuple(observations)


def _reject_reason(
    quote: NativeOptionQuote,
    *,
    as_of: datetime,
    expiry_date: str,
    max_quote_age_seconds: float,
    require_open_state: bool,
    require_iv_market: bool,
    require_sizes: bool,
) -> RejectionReason | None:
    if quote.option_side not in {"call", "put"}:
        return RejectionReason.MALFORMED_CONTRACT
    if not (quote.strike_usd > 0):
        return RejectionReason.MALFORMED_CONTRACT
    if quote.expiry_date != expiry_date:
        return RejectionReason.MALFORMED_CONTRACT
    if quote.expiry_utc is not None and quote.expiry_utc <= as_of:
        return RejectionReason.EXPIRED
    if require_open_state and quote.state not in {"", "open"}:
        return RejectionReason.NON_OPEN
    if quote.mark_iv is None or quote.mark_iv <= 0:
        return RejectionReason.INVALID_IV
    if quote.mark_iv > 5.0:
        return RejectionReason.OUT_OF_RANGE

    bid = quote.bid_price_btc
    ask = quote.ask_price_btc
    if bid is None or ask is None:
        return RejectionReason.MISSING_QUOTE
    if bid == 0:
        return RejectionReason.ZERO_BID
    if ask == 0:
        return RejectionReason.ZERO_ASK
    if bid < 0 or ask < 0:
        return RejectionReason.OUT_OF_RANGE
    if bid > ask:
        return RejectionReason.CROSSED_PRICE
    if bid <= 0 or ask <= 0:
        return RejectionReason.ONE_SIDED_PRICE

    if require_sizes and (quote.bid_size is None or quote.ask_size is None):
        return RejectionReason.MISSING_SIZE

    if require_iv_market:
        if quote.bid_iv is None or quote.ask_iv is None:
            return RejectionReason.INVALID_IV_MARKET
        if quote.bid_iv <= 0 or quote.ask_iv <= 0:
            return RejectionReason.INVALID_IV_MARKET
        if quote.bid_iv > quote.ask_iv:
            return RejectionReason.CROSSED_IV
        if not (
            quote.bid_iv - MARK_IV_BOUND_TOLERANCE
            <= quote.mark_iv
            <= quote.ask_iv + MARK_IV_BOUND_TOLERANCE
        ):
            return RejectionReason.MARK_IV_OUTSIDE_MARKET

    if quote.quote_as_of_utc is None:
        return RejectionReason.STALE_QUOTE
    age = (as_of - quote.quote_as_of_utc).total_seconds()
    if age < -1.0:
        return RejectionReason.FUTURE_TIMESTAMP
    if age > max_quote_age_seconds:
        return RejectionReason.STALE_QUOTE
    return None


def _two_sided(quote: NativeOptionQuote) -> bool:
    return (
        quote.bid_price_btc is not None
        and quote.ask_price_btc is not None
        and quote.bid_price_btc > 0
        and quote.ask_price_btc > 0
        and quote.bid_price_btc <= quote.ask_price_btc
        and quote.bid_iv is not None
        and quote.ask_iv is not None
        and quote.bid_iv > 0
        and quote.ask_iv > 0
        and quote.bid_iv <= quote.ask_iv
    )


def _age_seconds(quote: NativeOptionQuote, as_of: datetime) -> float | None:
    if quote.quote_as_of_utc is None:
        return None
    return max((as_of - quote.quote_as_of_utc).total_seconds(), 0.0)


def spread_rejected(quote: NativeOptionQuote, abs_k: float) -> bool:
    if quote.bid_iv is not None and quote.ask_iv is not None:
        width = quote.ask_iv - quote.bid_iv
        cap = ATM_IV_SPREAD_CAP + min(1.0, abs_k / SPREAD_WING_ABS_K) * (
            WING_IV_SPREAD_CAP - ATM_IV_SPREAD_CAP
        )
        if width > cap:
            return True
    if (
        quote.bid_price_btc is not None
        and quote.ask_price_btc is not None
        and quote.bid_price_btc > 0
        and quote.ask_price_btc > 0
    ):
        mid = 0.5 * (quote.bid_price_btc + quote.ask_price_btc)
        if mid >= MIN_PREMIUM_FOR_REL_SPREAD:
            rel = (quote.ask_price_btc - quote.bid_price_btc) / mid
            cap = ATM_REL_SPREAD_CAP + min(1.0, abs_k / SPREAD_WING_ABS_K) * (
                WING_REL_SPREAD_CAP - ATM_REL_SPREAD_CAP
            )
            if rel > cap:
                return True
    return False
