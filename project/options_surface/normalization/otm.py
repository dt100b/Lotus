"""Canonical OTM observation selection against a selected forward."""

from __future__ import annotations

import math
from typing import Sequence

from project.options_surface.normalization.quotes import spread_rejected
from project.options_surface.normalization.weights import observation_weight
from project.options_surface.timeutil import tenor_bucket, tenor_coverage_floors
from project.options_surface.types import (
    PointOrigin,
    QuoteObservation,
    RejectionReason,
    SmilePoint,
)


def select_otm_observations(
    observations: Sequence[QuoteObservation],
    *,
    forward_usd: float,
    time_to_expiry_years: float,
) -> dict[str, object]:
    if not math.isfinite(float(forward_usd)) or forward_usd <= 0:
        raise ValueError("OTM selection requires a positive finite forward.")

    accepted = [item for item in observations if item.accepted and item.mark_iv]
    filtered: list[QuoteObservation] = []
    extra_rejects: list[QuoteObservation] = []
    for item in accepted:
        abs_k = abs(math.log(item.quote.strike_usd / forward_usd))
        if spread_rejected(item.quote, abs_k):
            extra_rejects.append(
                QuoteObservation(
                    quote=item.quote,
                    accepted=False,
                    rejection_reason=RejectionReason.WIDE_SPREAD,
                    mark_iv=item.mark_iv,
                    bid_iv=item.bid_iv,
                    ask_iv=item.ask_iv,
                    quote_age_seconds=item.quote_age_seconds,
                    two_sided=item.two_sided,
                    fit_weight=0.0,
                )
            )
            continue
        filtered.append(item)

    by_strike: dict[float, dict[str, list[QuoteObservation]]] = {}
    for item in filtered:
        by_strike.setdefault(item.quote.strike_usd, {}).setdefault(
            item.quote.option_side, []
        ).append(item)

    points: list[SmilePoint] = []
    preferred = 0
    fallbacks = 0
    atm_merged = 0
    for strike in sorted(by_strike):
        sides = by_strike[strike]
        exact_atm = math.isclose(strike, forward_usd, rel_tol=1e-12, abs_tol=1e-6)
        if exact_atm:
            combined = sides.get("call", []) + sides.get("put", [])
            if not combined:
                continue
            point = _point_from_rows(
                combined,
                strike=strike,
                forward_usd=forward_usd,
                time_to_expiry_years=time_to_expiry_years,
                side="merged" if sides.get("call") and sides.get("put") else combined[0].quote.option_side,
                classification="preferred",
                source="atm_call_put_merge" if sides.get("call") and sides.get("put") else "atm_single_side",
                origin=PointOrigin.RAW_OBSERVED,
                fallback=False,
            )
            if sides.get("call") and sides.get("put"):
                atm_merged += 1
            points.append(point)
            continue

        preferred_side = "put" if strike < forward_usd else "call"
        fallback_side = "call" if preferred_side == "put" else "put"
        if sides.get(preferred_side):
            chosen = sides[preferred_side]
            classification = "preferred"
            source = f"{preferred_side}_otm_mark_iv"
            preferred += 1
            is_fallback = False
        elif sides.get(fallback_side):
            chosen = sides[fallback_side]
            classification = "fallback"
            source = f"{fallback_side}_opposite_fallback"
            fallbacks += 1
            is_fallback = True
        else:
            continue
        points.append(
            _point_from_rows(
                chosen,
                strike=strike,
                forward_usd=forward_usd,
                time_to_expiry_years=time_to_expiry_years,
                side=chosen[0].quote.option_side,
                classification=classification,
                source=source,
                origin=PointOrigin.RAW_OBSERVED,
                fallback=is_fallback,
            )
        )

    synthetic: list[SmilePoint] = []
    market = [point for point in points if point.origin is PointOrigin.RAW_OBSERVED]
    if market:
        below = [point for point in market if point.strike_usd < forward_usd]
        above = [point for point in market if point.strike_usd > forward_usd]
        has_exact = any(
            math.isclose(point.strike_usd, forward_usd, rel_tol=1e-12, abs_tol=1e-6)
            for point in market
        )
        if below and above and not has_exact:
            lower = max(below, key=lambda point: point.strike_usd)
            upper = min(above, key=lambda point: point.strike_usd)
            x_lo = math.log(lower.strike_usd / forward_usd)
            x_hi = math.log(upper.strike_usd / forward_usd)
            weight = -x_lo / (x_hi - x_lo)
            iv = lower.iv + weight * (upper.iv - lower.iv)
            k = 0.0
            synthetic.append(
                SmilePoint(
                    strike_usd=float(forward_usd),
                    log_moneyness=k,
                    iv=float(iv),
                    total_variance=float(iv * iv * time_to_expiry_years),
                    origin=PointOrigin.SYNTHETIC_ATM,
                    option_side="merged",
                    classification="synthetic",
                    bid_iv=None,
                    ask_iv=None,
                    mark_iv=float(iv),
                    quote_age_seconds=max(
                        lower.quote_age_seconds or 0.0,
                        upper.quote_age_seconds or 0.0,
                    ),
                    fit_weight=0.25 * min(lower.fit_weight, upper.fit_weight),
                    source="atm_log_moneyness_interpolation",
                )
            )

    lower_n = sum(1 for point in market if point.strike_usd < forward_usd)
    upper_n = sum(1 for point in market if point.strike_usd > forward_usd)
    center_gap = _center_log_gap([point.strike_usd for point in market], forward_usd)
    min_strikes, min_side, max_gap = tenor_coverage_floors(time_to_expiry_years)
    return {
        "observed": tuple(points),
        "synthetic": tuple(synthetic),
        "extra_rejects": tuple(extra_rejects),
        "preferred_side_selections": preferred,
        "opposite_side_fallbacks": fallbacks,
        "atm_merged": atm_merged,
        "lower_strikes": lower_n,
        "upper_strikes": upper_n,
        "center_log_gap": center_gap,
        "center_gap_exceeded": center_gap is None or center_gap > max_gap,
        "tenor_min_strikes": min_strikes,
        "tenor_min_side_strikes": min_side,
        "max_center_log_gap": max_gap,
        "tenor_bucket": tenor_bucket(time_to_expiry_years),
    }


def _point_from_rows(
    rows: Sequence[QuoteObservation],
    *,
    strike: float,
    forward_usd: float,
    time_to_expiry_years: float,
    side: str,
    classification: str,
    source: str,
    origin: PointOrigin,
    fallback: bool,
) -> SmilePoint:
    ivs = [float(item.mark_iv) for item in rows if item.mark_iv]
    iv = sorted(ivs)[len(ivs) // 2]
    k = math.log(strike / forward_usd)
    age = max((item.quote_age_seconds or 0.0) for item in rows)
    weight = observation_weight(
        rows[0].quote,
        log_moneyness=k,
        quote_age_seconds=age,
        two_sided=all(item.two_sided for item in rows),
        fallback=fallback,
        atm_iv=iv,
    )
    bid_ivs = [item.bid_iv for item in rows if item.bid_iv]
    ask_ivs = [item.ask_iv for item in rows if item.ask_iv]
    return SmilePoint(
        strike_usd=float(strike),
        log_moneyness=float(k),
        iv=float(iv),
        total_variance=float(iv * iv * time_to_expiry_years),
        origin=origin,
        option_side=side,
        classification=classification,
        bid_iv=sorted(bid_ivs)[len(bid_ivs) // 2] if bid_ivs else None,
        ask_iv=sorted(ask_ivs)[len(ask_ivs) // 2] if ask_ivs else None,
        mark_iv=float(iv),
        quote_age_seconds=float(age),
        fit_weight=float(weight),
        source=source,
    )


def _center_log_gap(strikes: Sequence[float], forward: float) -> float | None:
    listed = sorted({float(strike) for strike in strikes if strike > 0})
    if not listed:
        return None
    below = [strike for strike in listed if strike <= forward]
    above = [strike for strike in listed if strike >= forward]
    if not below or not above:
        return None
    lower = max(below)
    upper = min(above)
    if math.isclose(lower, upper, rel_tol=1e-12, abs_tol=1e-9):
        next_lower = max((strike for strike in listed if strike < forward), default=None)
        next_upper = min((strike for strike in listed if strike > forward), default=None)
        gaps: list[float] = []
        if next_lower is not None:
            gaps.append(math.log(forward / next_lower))
        if next_upper is not None:
            gaps.append(math.log(next_upper / forward))
        return max(gaps) if gaps else 0.0
    return math.log(upper / lower)
