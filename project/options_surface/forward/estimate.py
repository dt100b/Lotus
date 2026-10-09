"""ForwardEstimate construction with an explicit source hierarchy."""

from __future__ import annotations

from datetime import datetime
import math
from typing import Sequence

import numpy as np

from project.options_surface.market_data.futures import matching_futures
from project.options_surface.types import (
    ForwardEstimate,
    ForwardSource,
    NativeFutureQuote,
    QuoteObservation,
    SourceQuality,
    worse_quality,
)

MIN_PARITY_PAIRS = 2
PARITY_MONEYNESS = 0.08
PARITY_MAX_DISPERSION = 0.015
PARITY_MEDIUM_DISPERSION = 0.005
FUTURE_MAX_REL_SPREAD = 0.004


def inverse_option_forward(
    strike: float, call_mid_btc: float, put_mid_btc: float
) -> float | None:
    """Deribit coin-margined synthetic: F = K / (1 - (C - P)).

    C and P are native BTC inverse premiums. This is not USD put-call parity
    and must not be applied to spot-multiplied premiums.
    """
    denom = 1.0 - (float(call_mid_btc) - float(put_mid_btc))
    if denom <= 1e-6:
        return None
    forward = float(strike) / denom
    if not math.isfinite(forward) or forward <= 0.0:
        return None
    return forward


def estimate_forward(
    observations: Sequence[QuoteObservation],
    *,
    as_of_utc: datetime,
    expiry_utc: datetime,
    expiry_date: str,
    underlying: str,
    index_usd: float,
    futures: Sequence[NativeFutureQuote] = (),
) -> ForwardEstimate:
    flags: list[str] = []
    future_estimate = _from_matching_future(
        futures,
        expiry_date=expiry_date,
        underlying=underlying,
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        flags=flags,
    )
    parity_estimate = _from_inverse_parity(
        observations,
        index_usd=index_usd,
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        underlying=underlying,
        flags=flags,
    )
    venue_estimate = _from_venue_underlying(
        observations,
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        underlying=underlying,
        flags=flags,
    )

    futures_option_difference = None
    if (
        future_estimate is not None
        and future_estimate.forward_usd
        and parity_estimate is not None
        and parity_estimate.forward_usd
    ):
        futures_option_difference = (
            float(future_estimate.forward_usd) - float(parity_estimate.forward_usd)
        )

    if future_estimate is not None and future_estimate.forward_usd:
        return ForwardEstimate(
            as_of_utc=as_of_utc,
            expiry_utc=expiry_utc,
            underlying=underlying,
            forward_usd=future_estimate.forward_usd,
            source=ForwardSource.MATCHING_FUTURE,
            source_quality=future_estimate.source_quality,
            supporting_instruments=future_estimate.supporting_instruments,
            parity_pair_count=(
                parity_estimate.parity_pair_count if parity_estimate else 0
            ),
            parity_dispersion=(
                parity_estimate.parity_dispersion if parity_estimate else None
            ),
            futures_option_difference=futures_option_difference,
            fallback_reason=None,
            validation_flags=tuple(flags),
        )

    if parity_estimate is not None and parity_estimate.forward_usd:
        return ForwardEstimate(
            as_of_utc=as_of_utc,
            expiry_utc=expiry_utc,
            underlying=underlying,
            forward_usd=parity_estimate.forward_usd,
            source=ForwardSource.INVERSE_PUT_CALL_PARITY,
            source_quality=parity_estimate.source_quality,
            supporting_instruments=parity_estimate.supporting_instruments,
            parity_pair_count=parity_estimate.parity_pair_count,
            parity_dispersion=parity_estimate.parity_dispersion,
            futures_option_difference=None,
            fallback_reason="no_quality_matching_future",
            validation_flags=tuple(flags),
        )

    if venue_estimate is not None and venue_estimate.forward_usd:
        return ForwardEstimate(
            as_of_utc=as_of_utc,
            expiry_utc=expiry_utc,
            underlying=underlying,
            forward_usd=venue_estimate.forward_usd,
            source=ForwardSource.VENUE_UNDERLYING_PRICE,
            source_quality=SourceQuality.LOW,
            supporting_instruments=venue_estimate.supporting_instruments,
            parity_pair_count=0,
            parity_dispersion=None,
            futures_option_difference=None,
            fallback_reason="no_matching_future_or_valid_parity",
            validation_flags=tuple(flags),
        )

    if math.isfinite(float(index_usd)) and index_usd > 0:
        flags.append("used_spot_fallback")
        return ForwardEstimate(
            as_of_utc=as_of_utc,
            expiry_utc=expiry_utc,
            underlying=underlying,
            forward_usd=float(index_usd),
            source=ForwardSource.SPOT_FALLBACK,
            source_quality=SourceQuality.LOW,
            supporting_instruments=(),
            parity_pair_count=0,
            parity_dispersion=None,
            futures_option_difference=None,
            fallback_reason="no_future_parity_or_venue_underlying",
            validation_flags=tuple(flags),
        )

    flags.append("forward_unavailable")
    return ForwardEstimate(
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        underlying=underlying,
        forward_usd=None,
        source=None,
        source_quality=SourceQuality.UNAVAILABLE,
        supporting_instruments=(),
        parity_pair_count=0,
        parity_dispersion=None,
        futures_option_difference=None,
        fallback_reason="no_positive_index_or_forward_source",
        validation_flags=tuple(flags),
    )


def _from_matching_future(
    futures: Sequence[NativeFutureQuote],
    *,
    expiry_date: str,
    underlying: str,
    as_of_utc: datetime,
    expiry_utc: datetime,
    flags: list[str],
) -> ForwardEstimate | None:
    matches = matching_futures(futures, expiry_date=expiry_date, underlying=underlying)
    if not matches:
        flags.append("no_matching_listed_future")
        return None
    usable: list[tuple[float, str, SourceQuality]] = []
    for future in matches:
        two_sided = (
            future.bid_usd is not None
            and future.ask_usd is not None
            and future.bid_usd > 0
            and future.ask_usd >= future.bid_usd
        )
        if two_sided:
            mid = 0.5 * (float(future.bid_usd) + float(future.ask_usd))
            rel = (float(future.ask_usd) - float(future.bid_usd)) / mid
            if rel > FUTURE_MAX_REL_SPREAD:
                flags.append(f"future_wide_spread:{future.instrument_name}")
                continue
            usable.append((mid, future.instrument_name, SourceQuality.HIGH))
            continue
        mark = future.mark_usd or future.mid_usd
        if mark is not None and mark > 0:
            flags.append(f"future_mark_only:{future.instrument_name}")
            usable.append((float(mark), future.instrument_name, SourceQuality.MEDIUM))
    if not usable:
        flags.append("matching_future_failed_quality")
        return None
    quality = worse_quality(*(item[2] for item in usable))
    forward = float(np.median(np.asarray([item[0] for item in usable], dtype=float)))
    return ForwardEstimate(
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        underlying=underlying,
        forward_usd=forward,
        source=ForwardSource.MATCHING_FUTURE,
        source_quality=quality,
        supporting_instruments=tuple(item[1] for item in usable),
        parity_pair_count=0,
        parity_dispersion=None,
        futures_option_difference=None,
        fallback_reason=None,
        validation_flags=(),
    )


def _from_inverse_parity(
    observations: Sequence[QuoteObservation],
    *,
    index_usd: float,
    as_of_utc: datetime,
    expiry_utc: datetime,
    underlying: str,
    flags: list[str],
) -> ForwardEstimate | None:
    accepted = [item for item in observations if item.accepted]
    by_strike: dict[float, dict[str, QuoteObservation]] = {}
    for item in accepted:
        by_strike.setdefault(item.quote.strike_usd, {})[item.quote.option_side] = item
    pairs: list[tuple[float, float, str, str]] = []
    ref = float(index_usd) if index_usd and index_usd > 0 else None
    for strike, sides in by_strike.items():
        if "call" not in sides or "put" not in sides:
            continue
        if ref is not None and abs(strike / ref - 1.0) > PARITY_MONEYNESS:
            continue
        call = sides["call"].quote
        put = sides["put"].quote
        if (
            call.bid_price_btc is None
            or call.ask_price_btc is None
            or put.bid_price_btc is None
            or put.ask_price_btc is None
        ):
            continue
        call_mid = 0.5 * (call.bid_price_btc + call.ask_price_btc)
        put_mid = 0.5 * (put.bid_price_btc + put.ask_price_btc)
        forward = inverse_option_forward(strike, call_mid, put_mid)
        if forward is None:
            flags.append(f"parity_pair_invalid:{strike:.0f}")
            continue
        pairs.append((forward, strike, call.instrument_name, put.instrument_name))
    if len(pairs) < MIN_PARITY_PAIRS:
        flags.append(f"parity_insufficient_pairs:{len(pairs)}")
        return None
    forwards = np.asarray([item[0] for item in pairs], dtype=float)
    dispersion = float(np.std(forwards) / np.mean(forwards)) if np.mean(forwards) > 0 else None
    if dispersion is None or dispersion > PARITY_MAX_DISPERSION:
        flags.append(
            f"parity_dispersion_fail:{dispersion:.6f}" if dispersion is not None else "parity_dispersion_fail"
        )
        return None
    quality = (
        SourceQuality.MEDIUM
        if dispersion <= PARITY_MEDIUM_DISPERSION
        else SourceQuality.LOW
    )
    names: list[str] = []
    for item in pairs:
        names.extend((item[2], item[3]))
    return ForwardEstimate(
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        underlying=underlying,
        forward_usd=float(np.median(forwards)),
        source=ForwardSource.INVERSE_PUT_CALL_PARITY,
        source_quality=quality,
        supporting_instruments=tuple(dict.fromkeys(names)),
        parity_pair_count=len(pairs),
        parity_dispersion=dispersion,
        futures_option_difference=None,
        fallback_reason=None,
        validation_flags=(),
    )


def _from_venue_underlying(
    observations: Sequence[QuoteObservation],
    *,
    as_of_utc: datetime,
    expiry_utc: datetime,
    underlying: str,
    flags: list[str],
) -> ForwardEstimate | None:
    prices: list[float] = []
    names: list[str] = []
    for item in observations:
        price = item.quote.underlying_price_usd or item.quote.estimated_delivery_usd
        if price is not None and price > 0:
            prices.append(float(price))
            names.append(item.quote.instrument_name)
    if not prices:
        flags.append("no_venue_underlying_price")
        return None
    return ForwardEstimate(
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        underlying=underlying,
        forward_usd=float(np.median(np.asarray(prices, dtype=float))),
        source=ForwardSource.VENUE_UNDERLYING_PRICE,
        source_quality=SourceQuality.LOW,
        supporting_instruments=tuple(dict.fromkeys(names))[:8],
        parity_pair_count=0,
        parity_dispersion=None,
        futures_option_difference=None,
        fallback_reason=None,
        validation_flags=(),
    )


def collect_forward_candidates(
    observations: Sequence[QuoteObservation],
    *,
    as_of_utc: datetime,
    expiry_utc: datetime,
    expiry_date: str,
    underlying: str,
    index_usd: float,
    futures: Sequence[NativeFutureQuote] = (),
) -> dict[str, object]:
    """All hierarchy candidates. Selection policy is unchanged."""
    flags: list[str] = []
    future_estimate = _from_matching_future(
        futures,
        expiry_date=expiry_date,
        underlying=underlying,
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        flags=flags,
    )
    parity_estimate = _from_inverse_parity(
        observations,
        index_usd=index_usd,
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        underlying=underlying,
        flags=flags,
    )
    venue_estimate = _from_venue_underlying(
        observations,
        as_of_utc=as_of_utc,
        expiry_utc=expiry_utc,
        underlying=underlying,
        flags=flags,
    )
    spot = None
    if math.isfinite(float(index_usd)) and index_usd > 0:
        spot = ForwardEstimate(
            as_of_utc=as_of_utc,
            expiry_utc=expiry_utc,
            underlying=underlying,
            forward_usd=float(index_usd),
            source=ForwardSource.SPOT_FALLBACK,
            source_quality=SourceQuality.LOW,
            supporting_instruments=(),
            parity_pair_count=0,
            parity_dispersion=None,
            futures_option_difference=None,
            fallback_reason="spot_candidate_only",
            validation_flags=(),
        )
    return {
        "matching_future": future_estimate,
        "inverse_put_call_parity": parity_estimate,
        "venue_underlying_price": venue_estimate,
        "spot_fallback": spot,
        "validation_flags": tuple(flags),
    }
