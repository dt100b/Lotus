"""Risk-neutral density and directional IV signals for one option expiry.

This module is the headless, live-snapshot portion of the open-source IV
scanner supplied with the dashboard work.  It intentionally contains no HTTP
fetching, GUI code, plotting code, synthetic case generation, or backtesting.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time
import math
from typing import Any, Literal, Mapping, Sequence

import numpy as np
from scipy.integrate import simpson
from scipy.interpolate import UnivariateSpline
from scipy.ndimage import gaussian_filter1d
from scipy.stats import norm


DENSE_POINTS = 100
SMOOTHING_IV = 1.0
MIN_POINTS = 4
TAIL_THRESHOLD = 0.02
BAND_WIDTH = 0.03
SIGNAL_DELTA = 0.03
BAND_DELTA_MULT = 8
RISK_FREE_R = 0.0
DERIBIT_SETTLEMENT_HOUR_UTC = 8
SECONDS_PER_YEAR = 365.0 * 24.0 * 60.0 * 60.0
MAX_QUOTE_AGE_SECONDS = 30.0
IV_SELECTION_POLICY = "otm_mark_iv_v1"
TICKER_IV_SELECTION_POLICY = "otm_ticker_mark_iv_v4"
TICKER_SOURCE_PREFIX = "deribit_ticker_ws"
# Deribit publishes IV fields in percentage points.  A small tolerance avoids
# rejecting harmless serializer/rounding differences while still failing
# closed when mark IV sits materially outside the executable IV market.
MARK_IV_BOUND_TOLERANCE_PERCENTAGE_POINTS = 0.25
MIN_SIGNAL_MARKET_STRIKES = 8
MIN_SIGNAL_IV_COVERAGE_RATIO = 0.35
MIN_FORWARD_PAIRS = 2
FORWARD_PAIR_MONEYNESS = 0.08
SIGNAL_HYSTERESIS = 0.01
PEAK_NEUTRAL_FRACTION = 0.005
PEAK_HYSTERESIS_FRACTION = 0.0025
SIGNAL_CONFIRMATION_WINDOW = 3
SIGNAL_CONFIRMATION_REQUIRED = 2
QUALITY_HIGH_MAX_NEGATIVE_AREA = 1e-8
QUALITY_CAUTION_MAX_NEGATIVE_AREA = 0.01
# Live density filters.  Bid/ask quality is the primary gate; OI and |Δ| are
# secondary wing screens and never punch a hole in the near-ATM core.
DELTA_TAIL_CUTOFF = 0.05
ATM_MONEYNESS = 0.03
FAR_WING_MONEYNESS = 0.15
FAR_WING_ABS_DELTA = 0.10
MIN_WING_COVERAGE_PCT = 0.05
COVERAGE_VOL_UNITS = 1.5
MIN_CORE_STRIKES = 8


@dataclass(frozen=True, slots=True)
class TenorCoverageSpec:
    """Tenor-aware smile floors.  Eight strikes is a short-dated minimum."""

    min_strikes: int
    min_side_strikes: int
    max_center_log_gap: float
    label: str


ATM_REL_SPREAD_CAP = 0.60
WING_REL_SPREAD_CAP = 1.20
SPREAD_WING_MONEYNESS = 0.20
MIN_PREMIUM_FOR_REL_SPREAD = 0.01
ATM_IV_SPREAD_CAP = 15.0
WING_IV_SPREAD_CAP = 35.0

Signal = Literal["LONG", "SHORT", "NO_TRADE"]


@dataclass(frozen=True, slots=True)
class _SmileQuote:
    strike: float
    side: str
    iv: float
    age_seconds: float
    iv_spread: float
    bid: float
    ask: float
    open_interest: float | None
    delta: float | None
    bid_iv: float | None = None
    ask_iv: float | None = None


def bs_call_price(
    spot: float,
    strike: float,
    time_to_expiry_years: float,
    rate: float,
    sigma: float,
) -> float:
    """Black-Scholes call value used by the Breeden-Litzenberger step."""
    if sigma <= 0 or time_to_expiry_years <= 0:
        return max(spot - strike, 0.0)
    sqrt_t = np.sqrt(time_to_expiry_years)
    d1 = (
        np.log(spot / strike)
        + (rate + 0.5 * sigma**2) * time_to_expiry_years
    ) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    return float(
        spot * norm.cdf(d1)
        - strike * np.exp(-rate * time_to_expiry_years) * norm.cdf(d2)
    )


def bs_put_price(
    spot: float,
    strike: float,
    time_to_expiry_years: float,
    rate: float,
    sigma: float,
) -> float:
    """Black–Scholes put via put-call parity (USD numeraire)."""
    return (
        bs_call_price(spot, strike, time_to_expiry_years, rate, sigma)
        - spot
        + strike * math.exp(-rate * time_to_expiry_years)
    )


def bs_delta(
    spot: float,
    strike: float,
    time_to_expiry_years: float,
    rate: float,
    sigma: float,
    side: str,
) -> float:
    """Black-Scholes delta used when the venue greek is unavailable."""
    option_side = str(side).strip().lower()
    if option_side not in {"call", "put"}:
        raise ValueError("bs_delta side must be 'call' or 'put'.")
    if sigma <= 0 or time_to_expiry_years <= 0:
        if math.isclose(spot, strike, rel_tol=1e-12, abs_tol=1e-9):
            return 0.5 if option_side == "call" else -0.5
        if option_side == "call":
            return 1.0 if spot > strike else 0.0
        return -1.0 if spot < strike else 0.0
    sqrt_t = math.sqrt(time_to_expiry_years)
    d1 = (
        math.log(spot / strike)
        + (rate + 0.5 * sigma**2) * time_to_expiry_years
    ) / (sigma * sqrt_t)
    call_delta = float(norm.cdf(d1))
    return call_delta if option_side == "call" else call_delta - 1.0


def tenor_coverage_spec(time_to_expiry_years: float | None) -> TenorCoverageSpec:
    """Return the accepted-strike floor for one expiry tenor."""
    days = (
        float(time_to_expiry_years) * 365.0
        if time_to_expiry_years is not None and time_to_expiry_years > 0
        else 0.0
    )
    if days <= 2.0:
        return TenorCoverageSpec(8, 3, 0.06, "0_2_dte")
    if days <= 14.0:
        return TenorCoverageSpec(12, 4, 0.04, "3_14_dte")
    return TenorCoverageSpec(16, 5, 0.05, "15_plus_dte")


def inverse_option_forward(
    strike: float, call_mid: float, put_mid: float
) -> float | None:
    """Deribit coin-margined synthetic: F = K / (1 - (C - P))."""
    denom = 1.0 - (float(call_mid) - float(put_mid))
    if denom <= 1e-6:
        return None
    forward = float(strike) / denom
    if not math.isfinite(forward) or forward <= 0.0:
        return None
    return forward


def derive_implied_forward(
    quotes: Sequence[_SmileQuote],
    *,
    spot: float,
    underlying_prices: Sequence[float] = (),
    use_parity: bool = True,
) -> tuple[float, str, int]:
    """DVOL-style synthetic from near-ATM call/put pairs, with safe fallbacks."""
    if use_parity:
        by_strike: dict[float, dict[str, _SmileQuote]] = {}
        for quote in quotes:
            by_strike.setdefault(quote.strike, {})[quote.side] = quote
        pairs: list[tuple[float, float, float]] = []
        for strike, sides in by_strike.items():
            if "call" not in sides or "put" not in sides:
                continue
            if abs(strike / float(spot) - 1.0) > FORWARD_PAIR_MONEYNESS:
                continue
            call_mid = (sides["call"].bid + sides["call"].ask) / 2.0
            put_mid = (sides["put"].bid + sides["put"].ask) / 2.0
            forward = inverse_option_forward(strike, call_mid, put_mid)
            if forward is None:
                continue
            pairs.append((abs(call_mid - put_mid), float(strike), forward))
        if len(pairs) >= MIN_FORWARD_PAIRS:
            min_spread = min(item[0] for item in pairs)
            winners = [
                item for item in pairs if abs(item[0] - min_spread) <= 1e-8
            ]
            winner_strikes = [item[1] for item in winners]
            span = (max(winner_strikes) - min(winner_strikes)) / float(spot)
            if (
                len(winners) == len(pairs)
                and span > FORWARD_PAIR_MONEYNESS
                and min_spread < 1e-6
            ):
                return float(np.mean(winner_strikes)), "parity_pairs", len(pairs)
            return (
                float(np.mean([item[2] for item in winners])),
                "parity_pairs",
                len(pairs),
            )

    venue = [
        float(price)
        for price in underlying_prices
        if math.isfinite(float(price)) and float(price) > 0.0
    ]
    if venue:
        return float(np.median(np.asarray(venue, dtype=float))), "underlying_price", 0
    return float(spot), "spot_fallback", 0


def center_log_moneyness_gap(
    strikes: Sequence[float],
    forward: float,
) -> float | None:
    """Log-moneyness hole straddling the implied forward."""
    listed = sorted({float(strike) for strike in strikes if strike > 0})
    if not listed or not math.isfinite(float(forward)) or forward <= 0:
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


WING_MONEYNESS = 0.05


def rnd_diagnostics(
    dense_strikes: np.ndarray,
    density: np.ndarray,
    *,
    forward: float,
    atm_iv: float | None = None,
    time_to_expiry_years: float | None = None,
) -> dict[str, Any]:
    """Price-space and probability-space evidence for one recovered density.

    Fixed 5% wings stay comparable across tenors.  One-sigma wings use
    ``ln(K/F) / (σ_ATM √T)`` so a long-dated 5% band is not mistaken for
    the body, and a short-dated 5% band is not an unreachable extreme.
    """
    strikes = np.asarray(dense_strikes, dtype=float)
    raw = np.asarray(density, dtype=float)
    if (
        strikes.ndim != 1
        or raw.shape != strikes.shape
        or len(strikes) == 0
        or not math.isfinite(float(forward))
        or forward <= 0
    ):
        raise ValueError("RND diagnostics require a finite forward and matching arrays.")
    negative_area = max(float(simpson(np.clip(-raw, 0, None), x=strikes)), 0.0)
    positive = np.clip(raw, 0, None)
    area = float(simpson(raw, x=strikes))
    pos_area = float(simpson(positive, x=strikes))
    weights = positive / pos_area if pos_area > 0 else positive
    mean = float(simpson(strikes * weights, x=strikes)) if pos_area > 0 else float("nan")

    def mass(mask: np.ndarray) -> float:
        if not mask.any() or pos_area <= 0:
            return 0.0
        return float(simpson(weights[mask], x=strikes[mask]))

    percentiles = _rnd_percentiles(
        strikes,
        weights,
        (0.05, 0.16, 0.25, 0.50, 0.75, 0.84, 0.95),
    )
    left_5 = mass(strikes < forward * (1.0 - WING_MONEYNESS))
    right_5 = mass(strikes > forward * (1.0 + WING_MONEYNESS))
    if left_5 > right_5 + 1e-9:
        wing_ordering = "left"
    elif right_5 > left_5 + 1e-9:
        wing_ordering = "right"
    else:
        wing_ordering = "balanced"
    wing_gap = abs(left_5 - right_5)
    if wing_gap < SIGNAL_DELTA:
        wing_signal: Signal = "NO_TRADE"
    else:
        wing_signal = "SHORT" if left_5 > right_5 else "LONG"
    sigma_move = 0.0
    if (
        atm_iv is not None
        and time_to_expiry_years is not None
        and atm_iv > 0
        and time_to_expiry_years > 0
    ):
        sigma_move = float(atm_iv) * math.sqrt(float(time_to_expiry_years))
    sigma_left_strike = float(forward * math.exp(-sigma_move)) if sigma_move > 0 else None
    sigma_right_strike = float(forward * math.exp(sigma_move)) if sigma_move > 0 else None
    left_sigma = (
        mass(strikes < sigma_left_strike) if sigma_left_strike is not None else 0.0
    )
    right_sigma = (
        mass(strikes > sigma_right_strike) if sigma_right_strike is not None else 0.0
    )
    if left_sigma > right_sigma + 1e-9:
        sigma_ordering = "left"
    elif right_sigma > left_sigma + 1e-9:
        sigma_ordering = "right"
    else:
        sigma_ordering = "balanced"
    sigma_gap = abs(left_sigma - right_sigma)
    if sigma_move <= 0 or sigma_gap < SIGNAL_DELTA:
        sigma_signal: Signal = "NO_TRADE"
    else:
        sigma_signal = "SHORT" if left_sigma > right_sigma else "LONG"
    return {
        "forward": float(forward),
        "p_below_forward": mass(strikes < forward),
        "p_above_forward": mass(strikes > forward),
        "p_left_5": left_5,
        "p_right_5": right_5,
        "p_left_sigma": left_sigma,
        "p_right_sigma": right_sigma,
        "sigma_move": float(sigma_move),
        "sigma_left_strike": sigma_left_strike,
        "sigma_right_strike": sigma_right_strike,
        "atm_iv": float(atm_iv) if atm_iv is not None else None,
        "percentile_05": percentiles[0],
        "percentile_16": percentiles[1],
        "percentile_25": percentiles[2],
        "percentile_50": percentiles[3],
        "percentile_75": percentiles[4],
        "percentile_84": percentiles[5],
        "percentile_95": percentiles[6],
        "expected_move_up": (
            float(forward * (math.exp(sigma_move) - 1.0)) if sigma_move > 0 else 0.0
        ),
        "expected_move_down": (
            float(forward * (1.0 - math.exp(-sigma_move))) if sigma_move > 0 else 0.0
        ),
        "mean": mean,
        "normalization_integral": area,
        "negative_area": negative_area,
        "wing_ordering": wing_ordering,
        "wing_signal": wing_signal,
        "sigma_ordering": sigma_ordering,
        "sigma_signal": sigma_signal,
    }


def _rnd_percentiles(
    strikes: np.ndarray,
    weights: np.ndarray,
    levels: Sequence[float] = (0.05, 0.25, 0.50, 0.75, 0.95),
) -> list[float]:
    empty = [float("nan")] * len(levels)
    if len(strikes) < 2 or float(np.sum(weights)) <= 0:
        return empty
    dx = np.diff(strikes)
    mid = 0.5 * (weights[1:] + weights[:-1]) * dx
    cdf = np.concatenate(([0.0], np.cumsum(mid)))
    total = float(cdf[-1])
    if total <= 0:
        return empty
    cdf = cdf / total
    return [float(np.interp(level, cdf, strikes)) for level in levels]


def canonical_wing_ivs(
    iv_curve: Sequence[Mapping[str, Any]],
    *,
    forward: float,
) -> tuple[float | None, float | None]:
    """Mean selected IV below / above the forward, excluding synthetic anchors."""
    left: list[float] = []
    right: list[float] = []
    for point in iv_curve:
        if bool(point.get("synthetic")):
            continue
        strike = float(point["strike"])
        iv = float(point["iv"])
        if strike < forward:
            left.append(iv)
        elif strike > forward:
            right.append(iv)
    return (
        float(np.mean(left)) if left else None,
        float(np.mean(right)) if right else None,
    )


def build_canonical_smile(
    points: Sequence[Mapping[str, Any]],
    *,
    forward: float,
    time_to_expiry_years: float,
    rate: float = RISK_FREE_R,
) -> dict[str, Any]:
    """Fitted IV smile used by the PDF, plus 25Δ risk-reversal / butterfly.

    The dense strike grid and UnivariateSpline(s=1.0) match ``build_pdf``.
    25Δ metrics are interpolated on that fitted surface, never raw marks.
    """
    empty = {
        "points": [],
        "fit": [],
        "metrics": {
            "rr_25": None,
            "bf_25": None,
            "atm_iv": None,
            "iv_25_call": None,
            "iv_25_put": None,
            "delta_axis_available": False,
        },
    }
    accepted = [
        dict(point)
        for point in points
        if _positive_finite(point.get("strike")) is not None
        and _positive_finite(point.get("iv")) is not None
    ]
    if (
        len(accepted) < MIN_POINTS
        or not math.isfinite(float(forward))
        or forward <= 0
        or not math.isfinite(float(time_to_expiry_years))
        or time_to_expiry_years <= 0
    ):
        return empty

    accepted.sort(key=lambda point: float(point["strike"]))
    strike_arr = np.asarray([float(point["strike"]) for point in accepted], dtype=float)
    iv_arr = np.asarray([float(point["iv"]) for point in accepted], dtype=float)
    if len(np.unique(strike_arr)) != len(strike_arr):
        return empty

    iv_spline = UnivariateSpline(strike_arr, iv_arr, s=SMOOTHING_IV)
    dense_strikes = np.linspace(float(strike_arr.min()), float(strike_arr.max()), DENSE_POINTS)
    dense_ivs = np.clip(iv_spline(dense_strikes), 1e-4, None)

    fit: list[dict[str, Any]] = []
    for strike, iv in zip(dense_strikes, dense_ivs, strict=True):
        signed_delta = _signed_delta_from_forward(
            float(strike),
            float(iv),
            forward=float(forward),
            time_to_expiry_years=float(time_to_expiry_years),
            rate=rate,
        )
        fit.append(
            {
                "strike": float(strike),
                "iv": float(iv),
                "iv_percent": float(iv * 100.0),
                "log_moneyness": float(math.log(float(strike) / float(forward))),
                "delta": signed_delta,
            }
        )

    public_points: list[dict[str, Any]] = []
    for point in accepted:
        strike = float(point["strike"])
        iv = float(point["iv"])
        signed_delta = _signed_delta_from_forward(
            strike,
            iv,
            forward=float(forward),
            time_to_expiry_years=float(time_to_expiry_years),
            rate=rate,
            side=str(point.get("option_side") or ""),
        )
        public_points.append(
            {
                "strike": strike,
                "iv": iv,
                "iv_percent": float(point.get("iv_percent") or iv * 100.0),
                "log_moneyness": float(math.log(strike / float(forward))),
                "delta": signed_delta,
                "option_side": point.get("option_side") or "unknown",
                "classification": _smile_classification(point),
                "source": str(point.get("source") or ""),
                "synthetic": bool(point.get("synthetic")),
                "bid_iv": _positive_finite(point.get("bid_iv")),
                "ask_iv": _positive_finite(point.get("ask_iv")),
                "mark_iv": _positive_finite(point.get("mark_iv")) or iv,
                "quote_age_seconds": _non_negative_finite(point.get("quote_age_seconds")),
            }
        )

    atm_iv = float(np.clip(iv_spline(float(forward)), 1e-4, None))
    if not (float(strike_arr.min()) <= float(forward) <= float(strike_arr.max())):
        nearest = int(np.argmin(np.abs(strike_arr - float(forward))))
        atm_iv = float(iv_arr[nearest])
    iv_25_call = _iv_at_signed_delta(
        dense_strikes,
        dense_ivs,
        target_delta=0.25,
        forward=float(forward),
        time_to_expiry_years=float(time_to_expiry_years),
        rate=rate,
    )
    iv_25_put = _iv_at_signed_delta(
        dense_strikes,
        dense_ivs,
        target_delta=-0.25,
        forward=float(forward),
        time_to_expiry_years=float(time_to_expiry_years),
        rate=rate,
    )
    rr_25 = None
    bf_25 = None
    if iv_25_call is not None and iv_25_put is not None:
        rr_25 = float((iv_25_call - iv_25_put) * 100.0)
        bf_25 = float(((iv_25_call + iv_25_put) / 2.0 - atm_iv) * 100.0)

    finite_point_deltas = [
        point["delta"]
        for point in public_points
        if point["delta"] is not None and math.isfinite(float(point["delta"]))
    ]
    finite_fit_deltas = [
        point["delta"]
        for point in fit
        if point["delta"] is not None and math.isfinite(float(point["delta"]))
    ]
    delta_axis_available = (
        len(finite_point_deltas) == len(public_points)
        and len(public_points) >= MIN_POINTS
        and len(finite_fit_deltas) >= max(8, len(fit) // 2)
        and min(finite_point_deltas) < 0.0
        and max(finite_point_deltas) > 0.0
    )

    return {
        "points": public_points,
        "fit": fit,
        "metrics": {
            "rr_25": rr_25,
            "bf_25": bf_25,
            "atm_iv": float(atm_iv),
            "iv_25_call": iv_25_call,
            "iv_25_put": iv_25_put,
            "delta_axis_available": bool(delta_axis_available),
        },
    }


def _signed_delta_from_forward(
    strike: float,
    iv: float,
    *,
    forward: float,
    time_to_expiry_years: float,
    rate: float,
    side: str = "",
) -> float | None:
    option_side = str(side).strip().lower()
    if option_side not in {"call", "put"}:
        if math.isclose(strike, forward, rel_tol=1e-12, abs_tol=1e-6):
            return 0.0
        option_side = "put" if strike < forward else "call"
    try:
        return float(
            bs_delta(
                forward,
                strike,
                time_to_expiry_years,
                rate,
                iv,
                option_side,
            )
        )
    except ValueError:
        return None


def _iv_at_signed_delta(
    strikes: np.ndarray,
    ivs: np.ndarray,
    *,
    target_delta: float,
    forward: float,
    time_to_expiry_years: float,
    rate: float,
) -> float | None:
    signed: list[float] = []
    for strike, iv in zip(strikes, ivs, strict=True):
        delta = _signed_delta_from_forward(
            float(strike),
            float(iv),
            forward=forward,
            time_to_expiry_years=time_to_expiry_years,
            rate=rate,
        )
        if delta is None or not math.isfinite(delta):
            return None
        signed.append(delta)
    xs = np.asarray(signed, dtype=float)
    ys = np.asarray(ivs, dtype=float)
    order = np.argsort(xs)
    xs = xs[order]
    ys = ys[order]
    unique_x, unique_index = np.unique(xs, return_index=True)
    unique_y = ys[unique_index]
    if len(unique_x) < 2:
        return None
    if float(target_delta) < float(unique_x[0]) or float(target_delta) > float(unique_x[-1]):
        return None
    return float(np.interp(float(target_delta), unique_x, unique_y))


def _smile_classification(point: Mapping[str, Any]) -> str:
    if bool(point.get("synthetic")):
        return "synthetic"
    source = str(point.get("source") or "").lower()
    if "fallback" in source:
        return "fallback"
    return "preferred"


def build_pdf(
    spot: float,
    strikes: np.ndarray,
    ivs: np.ndarray,
    time_to_expiry_years: float,
    rate: float = RISK_FREE_R,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Reconstruct the risk-neutral density from an IV smile.

    The numerical choices deliberately match the supplied model: an IV spline
    with ``s=1.0``, a 100-strike dense grid, a second call-price derivative,
    Simpson normalization, and a Gaussian filter with sigma two.
    """
    dense_strikes, normalized_density, smoothed_density, _quality = (
        _build_pdf_with_quality(
            spot,
            strikes,
            ivs,
            time_to_expiry_years,
            rate,
        )
    )
    return dense_strikes, normalized_density, smoothed_density


def _build_pdf_with_quality(
    spot: float,
    strikes: np.ndarray,
    ivs: np.ndarray,
    time_to_expiry_years: float,
    rate: float = RISK_FREE_R,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
    """Build the prototype density and retain its numerical quality evidence."""
    strike_arr = np.asarray(strikes, dtype=float)
    iv_arr = np.asarray(ivs, dtype=float)
    if strike_arr.ndim != 1 or iv_arr.ndim != 1 or len(strike_arr) != len(iv_arr):
        raise ValueError("Strikes and mark IVs must be equal-length one-dimensional arrays.")
    if len(strike_arr) < MIN_POINTS:
        raise ValueError(f"At least {MIN_POINTS} unique strikes are required.")
    if not math.isfinite(float(spot)) or spot <= 0:
        raise ValueError("Snapshot spot_price must be positive and finite.")
    if not math.isfinite(float(time_to_expiry_years)) or time_to_expiry_years <= 0:
        raise ValueError("Expiry must be after the snapshot as_of time.")
    if not np.all(np.isfinite(strike_arr)) or np.any(strike_arr <= 0):
        raise ValueError("Strikes must be positive and finite.")
    if not np.all(np.isfinite(iv_arr)) or np.any(iv_arr <= 0):
        raise ValueError("Mark IVs must be positive and finite.")

    sort_idx = np.argsort(strike_arr)
    strike_arr = strike_arr[sort_idx]
    iv_arr = iv_arr[sort_idx]
    if len(np.unique(strike_arr)) != len(strike_arr):
        raise ValueError("build_pdf requires one mark IV per unique strike.")

    iv_spline = UnivariateSpline(strike_arr, iv_arr, s=SMOOTHING_IV)
    dense_strikes = np.linspace(strike_arr.min(), strike_arr.max(), DENSE_POINTS)
    dense_ivs = np.clip(iv_spline(dense_strikes), 1e-4, None)

    call_prices = np.asarray(
        [
            bs_call_price(spot, strike, time_to_expiry_years, rate, iv)
            for strike, iv in zip(dense_strikes, dense_ivs, strict=True)
        ],
        dtype=float,
    )
    price_spline = UnivariateSpline(dense_strikes, call_prices, s=0)
    raw_density = price_spline.derivative(2)(dense_strikes) * np.exp(
        rate * time_to_expiry_years
    )

    area = float(simpson(raw_density, x=dense_strikes))
    normalized_density = raw_density / (area if area > 0 else 1.0)
    smoothed_density = gaussian_filter1d(normalized_density, sigma=2)
    if not (
        np.all(np.isfinite(normalized_density))
        and np.all(np.isfinite(smoothed_density))
    ):
        raise ValueError("IV surface produced a non-finite risk-neutral density.")
    negative_grid_points = int(np.count_nonzero(normalized_density < 0.0))
    negative_area = max(
        float(simpson(np.clip(-normalized_density, 0, None), x=dense_strikes)),
        0.0,
    )
    positive_area = max(
        float(simpson(np.clip(normalized_density, 0, None), x=dense_strikes)),
        0.0,
    )
    normalization_valid = math.isfinite(area) and area > 0.0
    if not normalization_valid or negative_area > QUALITY_CAUTION_MAX_NEGATIVE_AREA:
        quality_level = "LOW"
    elif negative_area > QUALITY_HIGH_MAX_NEGATIVE_AREA:
        quality_level = "CAUTION"
    else:
        quality_level = "HIGH"

    quality = {
        "level": quality_level,
        "signal_eligible": quality_level != "LOW",
        "negative_grid_points": negative_grid_points,
        "grid_point_count": int(len(dense_strikes)),
        "negative_grid_fraction": float(negative_grid_points / len(dense_strikes)),
        "negative_area": float(negative_area),
        "positive_area": float(positive_area),
        "normalization_integral": float(area),
        "clipping_required": negative_grid_points > 0,
        "sparse_center": False,
    }
    return dense_strikes, normalized_density, smoothed_density, quality


def compute_signals(
    spot: float,
    dense_strikes: np.ndarray,
    normalized_density: np.ndarray,
    smoothed_density: np.ndarray,
    *,
    tail_threshold: float = TAIL_THRESHOLD,
    band_width: float = BAND_WIDTH,
    signal_delta: float = SIGNAL_DELTA,
    previous: Mapping[str, Any] | None = None,
    reference_price: float | None = None,
) -> dict[str, Any]:
    """Compute the model's four votes and active-vote unanimous verdict.

    ``reference_price`` is the implied forward when available.  Mass-above vs
    mass-below that level is a *body* metric; 5% wing probabilities live on
    the ``rnd`` diagnostics and can disagree with it.
    """
    _validate_threshold("tail_threshold", tail_threshold)
    _validate_threshold("band_width", band_width)
    _validate_threshold("signal_delta", signal_delta)

    strikes = np.asarray(dense_strikes, dtype=float)
    density = np.asarray(normalized_density, dtype=float)
    smooth = np.asarray(smoothed_density, dtype=float)
    if strikes.ndim != 1 or density.shape != strikes.shape or smooth.shape != strikes.shape:
        raise ValueError("Density arrays must be equal-length one-dimensional arrays.")
    if len(strikes) == 0 or not (
        np.all(np.isfinite(strikes))
        and np.all(np.isfinite(density))
        and np.all(np.isfinite(smooth))
    ):
        raise ValueError("Density arrays must be non-empty and finite.")

    band_signal_delta = min(0.49, signal_delta * BAND_DELTA_MULT)
    positive_density = np.clip(density, 0, None)
    previous_map = previous if isinstance(previous, Mapping) else {}
    # Prototype votes stay on spot and the configured tail gate so frozen
    # parity math is unchanged.  Economic 5% wings live on ``rnd``.
    _ = reference_price

    above = strikes > spot
    below = strikes < spot
    p_up = _integral(positive_density, strikes, above)
    p_down = _integral(positive_density, strikes, below)
    skew_difference = abs(p_up - p_down)
    skew_signal = _direction_with_hysteresis(
        p_up,
        p_down,
        skew_difference,
        signal_delta,
        _previous_signal(previous_map, "skew"),
    )

    upper_tail = strikes > spot * (1 + tail_threshold)
    lower_tail = strikes < spot * (1 - tail_threshold)
    p_tail_up = _integral(positive_density, strikes, upper_tail)
    p_tail_down = _integral(positive_density, strikes, lower_tail)
    tail_difference = abs(p_tail_up - p_tail_down)
    tails_signal = _direction_with_hysteresis(
        p_tail_up,
        p_tail_down,
        tail_difference,
        signal_delta,
        _previous_signal(previous_map, "tails"),
    )

    peak_strike = float(strikes[int(np.argmax(smooth))])
    peak_signal = _peak_signal_with_hysteresis(
        peak_strike,
        float(spot),
        _previous_signal(previous_map, "peak"),
    )

    band_lower = spot * (1 - band_width)
    band_upper = spot * (1 + band_width)
    inside_band = (strikes >= band_lower) & (strikes <= band_upper)
    p_band = _integral(positive_density, strikes, inside_band)
    p_outside = 1.0 - p_band
    band_difference = abs(p_outside - p_band)
    raw_band: Signal = (
        skew_signal
        if p_outside > 0.5 and band_difference >= band_signal_delta
        else "NO_TRADE"
    )
    band_signal = _hold_signal(
        raw_band,
        band_difference,
        band_signal_delta,
        _previous_signal(previous_map, "band"),
    )

    active: list[Signal] = [
        signal
        for signal in (skew_signal, tails_signal, peak_signal, band_signal)
        if signal != "NO_TRADE"
    ]
    if active and all(signal == active[0] for signal in active):
        verdict: Signal = active[0]
    else:
        verdict = "NO_TRADE"

    return {
        "skew": {
            "signal": skew_signal,
            "p_up": p_up,
            "p_down": p_down,
            "difference": skew_difference,
        },
        "tails": {
            "signal": tails_signal,
            "p_up": p_tail_up,
            "p_down": p_tail_down,
            "difference": tail_difference,
        },
        "peak": {
            "signal": peak_signal,
            "peak_strike": peak_strike,
            "shift_percent": ((peak_strike / spot) - 1.0) * 100.0,
        },
        "band": {
            "signal": band_signal,
            "p_band": p_band,
            "p_outside": p_outside,
            "difference": band_difference,
        },
        "verdict": verdict,
    }


def deribit_settlement(expiry: str) -> datetime:
    """Parse an ISO expiry date as Deribit's exact 08:00 UTC settlement."""
    text = str(expiry).strip()
    if text.upper() == "ALL":
        raise ValueError('IV signal scan requires one ISO expiry; "ALL" is not supported.')
    try:
        parsed = date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(
            f"Invalid expiry '{expiry}'; expected an ISO date (YYYY-MM-DD)."
        ) from exc
    if parsed.isoformat() != text:
        raise ValueError(
            f"Invalid expiry '{expiry}'; expected an ISO date (YYYY-MM-DD)."
        )
    return datetime.combine(
        parsed,
        time(hour=DERIBIT_SETTLEMENT_HOUR_UTC),
        tzinfo=UTC,
    )


def normalize_expiry_iv_curve(
    rows: Sequence[dict[str, Any]],
    *,
    expiry: str,
    spot: float,
    as_of: datetime,
    max_quote_age_seconds: float = MAX_QUOTE_AGE_SECONDS,
    source: str = "deribit_book_summary",
    verified_live_quotes: bool = True,
    time_to_expiry_years: float | None = None,
) -> dict[str, Any]:
    """Select a deterministic, quote-verified OTM IV smile for one expiry.

    Live ticker rows classify OTM against an option-implied forward, not raw
    spot.  The forward is the DVOL synthetic from near-ATM call/put mids, with
    venue underlying and spot as fallbacks.  Book-summary/parity path still
    classifies against spot so frozen prototype inputs stay comparable.

    If the preferred side at a strike is unavailable, the opposite side is the
    sole deterministic fallback.  An exact ATM strike robustly merges both
    sides; otherwise a synthetic ATM anchor is interpolated linearly in log
    moneyness from the nearest bracketing market strikes.

    Live ticker rows also apply density-input screens: zero/invalid bids are
    excluded from fitting, relative spreads are capped, and far-from-ATM
    wings may be dropped for low |Δ| or modest OI.  Those wing screens never
    remove the near-spot core needed to keep left/right coverage.
    """
    if not math.isfinite(float(spot)) or spot <= 0:
        raise ValueError("Snapshot spot_price must be positive and finite.")
    if (
        not math.isfinite(float(max_quote_age_seconds))
        or max_quote_age_seconds <= 0
    ):
        raise ValueError("max_quote_age_seconds must be positive and finite.")
    normalized_as_of = _as_utc(as_of)
    matching_rows = [row for row in rows if str(row.get("expiry")) == expiry]
    if not matching_rows:
        raise KeyError(f"Unknown expiry: {expiry}")
    resolved_time_to_expiry = _resolved_time_to_expiry_years(
        expiry,
        normalized_as_of,
        time_to_expiry_years,
    )

    # Each key may contain more than one row in fixtures or during a transient
    # venue duplication.  Median IV is robust and deterministic in either case.
    hard_valid: list[_SmileQuote] = []
    candidate_strikes: set[float] = set()
    ticker_market_required = str(source).startswith(TICKER_SOURCE_PREFIX)
    rejected_invalid_contract_rows = 0
    rejected_invalid_iv_rows = 0
    rejected_missing_quote_rows = 0
    rejected_zero_bid_rows = 0
    rejected_crossed_quote_rows = 0
    rejected_stale_quote_rows = 0
    rejected_non_open_rows = 0
    rejected_missing_size_rows = 0
    rejected_invalid_iv_market_rows = 0
    rejected_wide_spread_rows = 0
    rejected_low_delta_rows = 0
    rejected_low_open_interest_rows = 0
    coverage_corridor: float | None = None
    valid_quote_rows = 0

    for row in matching_rows:
        strike = _positive_finite(row.get("strike"))
        side = _option_side(row.get("option_type", row.get("option_side")))
        if strike is None or side is None:
            rejected_invalid_contract_rows += 1
            continue
        candidate_strikes.add(strike)

        iv_percent = _positive_finite(row.get("mark_iv"))
        if iv_percent is None:
            rejected_invalid_iv_rows += 1
            continue

        iv_spread_percentage_points = 0.0
        if ticker_market_required:
            if str(row.get("state") or "").strip().lower() != "open":
                rejected_non_open_rows += 1
                continue
            bid_size = _positive_finite(row.get("bid_size"))
            ask_size = _positive_finite(row.get("ask_size"))
            if bid_size is None or ask_size is None:
                rejected_missing_size_rows += 1
                continue
            bid_iv = _positive_finite(row.get("bid_iv"))
            ask_iv = _positive_finite(row.get("ask_iv"))
            if bid_iv is None or ask_iv is None or bid_iv > ask_iv:
                rejected_invalid_iv_market_rows += 1
                continue
            if not (
                bid_iv - MARK_IV_BOUND_TOLERANCE_PERCENTAGE_POINTS
                <= iv_percent
                <= ask_iv + MARK_IV_BOUND_TOLERANCE_PERCENTAGE_POINTS
            ):
                rejected_invalid_iv_market_rows += 1
                continue
            iv_spread_percentage_points = float(ask_iv - bid_iv)

        bid_raw = _finite_or_none(row.get("bid_price"))
        ask_raw = _finite_or_none(row.get("ask_price"))
        if bid_raw is None or ask_raw is None:
            rejected_missing_quote_rows += 1
            continue
        if bid_raw <= 0.0 or ask_raw <= 0.0:
            # Exclude from density fitting.  Never coerce a zero bid into IV=0.
            rejected_zero_bid_rows += 1
            continue
        if bid_raw > ask_raw:
            rejected_crossed_quote_rows += 1
            continue

        quote_as_of = _parse_quote_as_of(row.get("quote_as_of"))
        if quote_as_of is None:
            rejected_stale_quote_rows += 1
            continue
        age_seconds = (normalized_as_of - quote_as_of).total_seconds()
        if age_seconds < -1.0:
            rejected_invalid_contract_rows += 1
            continue
        age_seconds = max(age_seconds, 0.0)
        if age_seconds > max_quote_age_seconds:
            rejected_stale_quote_rows += 1
            continue

        iv = float(iv_percent) / 100.0
        venue_delta = _finite_or_none(row.get("delta"))
        if (
            ticker_market_required
            and venue_delta is None
            and resolved_time_to_expiry is not None
        ):
            venue_delta = bs_delta(
                float(spot),
                float(strike),
                resolved_time_to_expiry,
                RISK_FREE_R,
                iv,
                side,
            )
        quote_bid_iv = None
        quote_ask_iv = None
        if ticker_market_required:
            parsed_bid_iv = _positive_finite(row.get("bid_iv"))
            parsed_ask_iv = _positive_finite(row.get("ask_iv"))
            if parsed_bid_iv is not None:
                quote_bid_iv = float(parsed_bid_iv) / 100.0
            if parsed_ask_iv is not None:
                quote_ask_iv = float(parsed_ask_iv) / 100.0
        hard_valid.append(
            _SmileQuote(
                strike=float(strike),
                side=side,
                iv=iv,
                age_seconds=float(age_seconds),
                iv_spread=float(iv_spread_percentage_points),
                bid=float(bid_raw),
                ask=float(ask_raw),
                open_interest=_non_negative_finite(row.get("open_interest")),
                delta=venue_delta,
                bid_iv=quote_bid_iv,
                ask_iv=quote_ask_iv,
            )
        )

    hard_valid_strikes = {quote.strike for quote in hard_valid}
    underlying_prices = [
        price
        for price in (
            _positive_finite(row.get("underlying_price")) for row in matching_rows
        )
        if price is not None
    ]
    implied_forward, forward_source, forward_pair_count = derive_implied_forward(
        hard_valid,
        spot=float(spot),
        underlying_prices=underlying_prices,
        use_parity=True,
    )
    otm_ref = implied_forward if ticker_market_required else float(spot)
    if ticker_market_required:
        (
            hard_valid,
            density_rejects,
            coverage_corridor,
        ) = _apply_ticker_density_filters(
            hard_valid,
            spot=float(otm_ref),
            time_to_expiry_years=resolved_time_to_expiry,
        )
        rejected_wide_spread_rows = density_rejects["rejected_wide_spread_rows"]
        rejected_low_delta_rows = density_rejects["rejected_low_delta_rows"]
        rejected_low_open_interest_rows = density_rejects[
            "rejected_low_open_interest_rows"
        ]

    candidates: dict[tuple[float, str], list[_SmileQuote]] = {}
    for quote in hard_valid:
        candidates.setdefault((quote.strike, quote.side), []).append(quote)
        valid_quote_rows += 1

    points: list[dict[str, Any]] = []
    preferred_side_selections = 0
    opposite_side_fallbacks = 0
    atm_merged_selections = 0
    atm_single_side_selections = 0
    selected_iv_spreads: list[float] = []

    for strike in sorted({key[0] for key in candidates}):
        call_rows = candidates.get((strike, "call"), [])
        put_rows = candidates.get((strike, "put"), [])
        exact_atm = math.isclose(strike, float(otm_ref), rel_tol=1e-12, abs_tol=1e-9)

        if exact_atm:
            combined = call_rows + put_rows
            if not combined:
                continue
            chosen_rows = combined
            iv = _median_iv(combined)
            age = max(item.age_seconds for item in combined)
            selected_iv_spreads.append(_median_iv_spread(combined))
            if call_rows and put_rows:
                point_source = "atm_call_put_merge"
                point_side = "merged"
                atm_merged_selections += 1
            else:
                point_side = "call" if call_rows else "put"
                point_source = f"atm_single_{point_side}"
                atm_single_side_selections += 1
        else:
            preferred_side = "put" if strike < otm_ref else "call"
            fallback_side = "call" if preferred_side == "put" else "put"
            preferred_rows = candidates.get((strike, preferred_side), [])
            fallback_rows = candidates.get((strike, fallback_side), [])
            if preferred_rows:
                chosen_rows = preferred_rows
                point_side = preferred_side
                point_source = f"{preferred_side}_otm_mark_iv"
                preferred_side_selections += 1
            elif fallback_rows:
                chosen_rows = fallback_rows
                point_side = fallback_side
                point_source = f"{fallback_side}_opposite_fallback"
                opposite_side_fallbacks += 1
            else:
                continue
            iv = _median_iv(chosen_rows)
            age = max(item.age_seconds for item in chosen_rows)
            selected_iv_spreads.append(_median_iv_spread(chosen_rows))

        points.append(
            {
                "strike": float(strike),
                "iv": float(iv),
                "iv_percent": float(iv * 100.0),
                "source": point_source,
                "option_side": point_side,
                "synthetic": False,
                "quote_age_seconds": float(age),
                "bid_iv": _median_optional_iv([item.bid_iv for item in chosen_rows]),
                "ask_iv": _median_optional_iv([item.ask_iv for item in chosen_rows]),
                "mark_iv": float(iv),
            }
        )

    selected_market_strikes = len(points)
    if selected_market_strikes < MIN_POINTS:
        raise ValueError(
            f"Expiry '{expiry}' has {selected_market_strikes} valid quoted strikes; "
            f"at least {MIN_POINTS} are required after quote validation "
            f"(rejected stale={rejected_stale_quote_rows}, "
            f"iv_market={rejected_invalid_iv_market_rows}, "
            f"missing_size={rejected_missing_size_rows}, "
            f"zero_bid={rejected_zero_bid_rows}, "
            f"missing_quote={rejected_missing_quote_rows}, "
            f"non_open={rejected_non_open_rows})."
        )

    market_strikes = [float(point["strike"]) for point in points]
    spot_bracketed = min(market_strikes) <= spot <= max(market_strikes)
    forward_bracketed = min(market_strikes) <= otm_ref <= max(market_strikes)
    synthetic_anchor_added = False
    has_exact_atm = any(
        math.isclose(strike, float(otm_ref), rel_tol=1e-12, abs_tol=1e-9)
        for strike in market_strikes
    )
    if forward_bracketed and not has_exact_atm:
        lower = max(
            (point for point in points if float(point["strike"]) < otm_ref),
            key=lambda point: float(point["strike"]),
        )
        upper = min(
            (point for point in points if float(point["strike"]) > otm_ref),
            key=lambda point: float(point["strike"]),
        )
        x_lower = math.log(float(lower["strike"]) / otm_ref)
        x_upper = math.log(float(upper["strike"]) / otm_ref)
        weight = -x_lower / (x_upper - x_lower)
        anchor_iv = float(lower["iv"]) + weight * (
            float(upper["iv"]) - float(lower["iv"])
        )
        points.append(
            {
                "strike": float(otm_ref),
                "iv": float(anchor_iv),
                "iv_percent": float(anchor_iv * 100.0),
                "source": "atm_log_moneyness_interpolation",
                "option_side": "merged",
                "synthetic": True,
                "quote_age_seconds": float(
                    max(lower["quote_age_seconds"], upper["quote_age_seconds"])
                ),
                "bid_iv": None,
                "ask_iv": None,
                "mark_iv": float(anchor_iv),
            }
        )
        synthetic_anchor_added = True

    points.sort(key=lambda point: float(point["strike"]))
    strikes = np.asarray([point["strike"] for point in points], dtype=float)
    ivs = np.asarray([point["iv"] for point in points], dtype=float)
    dropped_rows = len(matching_rows) - valid_quote_rows
    duplicate_rows = max(valid_quote_rows - len(candidates), 0)
    listed_strike_count = len(candidate_strikes)
    coverage_ratio = (
        selected_market_strikes / listed_strike_count
        if listed_strike_count
        else 0.0
    )
    hard_valid_coverage_ratio = (
        len(hard_valid_strikes) / listed_strike_count
        if listed_strike_count
        else 0.0
    )
    tenor = tenor_coverage_spec(resolved_time_to_expiry)
    lower_strikes = sum(1 for strike in market_strikes if strike < otm_ref)
    upper_strikes = sum(1 for strike in market_strikes if strike > otm_ref)
    center_gap = center_log_moneyness_gap(market_strikes, otm_ref)
    center_gap_exceeded = (
        center_gap is None or center_gap > tenor.max_center_log_gap
    )
    coverage: dict[str, Any] = {
        "total_expiry_rows": len(matching_rows),
        "valid_iv_rows": valid_quote_rows,
        "unique_strikes": len(points),
        "dropped_rows": dropped_rows,
        "duplicate_rows": duplicate_rows,
        "strike_min": float(strikes[0]),
        "strike_max": float(strikes[-1]),
        "iv_coverage_ratio": float(coverage_ratio),
        "hard_valid_strikes": len(hard_valid_strikes),
        "hard_valid_coverage_ratio": float(hard_valid_coverage_ratio),
        "spot_bracketed": bool(spot_bracketed),
        "forward_bracketed": bool(forward_bracketed),
        "implied_forward": float(implied_forward),
        "otm_reference": float(otm_ref),
        "lower_strikes": int(lower_strikes),
        "upper_strikes": int(upper_strikes),
        "center_log_gap": center_gap,
        "center_gap_exceeded": bool(center_gap_exceeded),
        "tenor_min_strikes": tenor.min_strikes,
        "tenor_min_side_strikes": tenor.min_side_strikes,
        "max_center_log_gap": tenor.max_center_log_gap,
        "tenor_bucket": tenor.label,
    }
    selected_ages = [
        float(point["quote_age_seconds"])
        for point in points
        if not bool(point["synthetic"])
    ]
    selection = {
        "policy": (
            TICKER_IV_SELECTION_POLICY
            if ticker_market_required
            else IV_SELECTION_POLICY
        ),
        "iv_basis": "mark_iv",
        "source": str(source),
        "verified_live_quotes": bool(verified_live_quotes),
        "input_rows": len(rows),
        "expiry_rows": len(matching_rows),
        "valid_quote_rows": valid_quote_rows,
        "selected_market_strikes": selected_market_strikes,
        "preferred_side_selections": preferred_side_selections,
        "opposite_side_fallbacks": opposite_side_fallbacks,
        "atm_merged_selections": atm_merged_selections,
        "atm_single_side_selections": atm_single_side_selections,
        "synthetic_anchor_added": synthetic_anchor_added,
        "rejected_invalid_contract_rows": rejected_invalid_contract_rows,
        "rejected_invalid_iv_rows": rejected_invalid_iv_rows,
        "rejected_missing_quote_rows": rejected_missing_quote_rows,
        "rejected_zero_bid_rows": rejected_zero_bid_rows,
        "rejected_crossed_quote_rows": rejected_crossed_quote_rows,
        "rejected_stale_quote_rows": rejected_stale_quote_rows,
        "rejected_non_open_rows": rejected_non_open_rows,
        "rejected_missing_size_rows": rejected_missing_size_rows,
        "rejected_invalid_iv_market_rows": rejected_invalid_iv_market_rows,
        "rejected_wide_spread_rows": rejected_wide_spread_rows,
        "rejected_low_delta_rows": rejected_low_delta_rows,
        "rejected_low_open_interest_rows": rejected_low_open_interest_rows,
        "coverage_corridor": coverage_corridor,
        "delta_cutoff": DELTA_TAIL_CUTOFF if ticker_market_required else None,
        "methodology": "dvol_inspired_quote_filter_and_forward",
        "implied_forward": float(implied_forward),
        "forward_source": forward_source,
        "forward_pair_count": int(forward_pair_count),
        "otm_reference": float(otm_ref),
        "median_selected_iv_spread_percentage_points": float(
            np.median(np.asarray(selected_iv_spreads, dtype=float))
            if selected_iv_spreads
            else 0.0
        ),
        "max_selected_iv_spread_percentage_points": max(
            selected_iv_spreads,
            default=0.0,
        ),
        "max_quote_age_seconds": float(max_quote_age_seconds),
        "oldest_selected_quote_age_seconds": max(selected_ages, default=0.0),
    }

    warnings: list[str] = []
    if dropped_rows:
        warnings.append(
            f"Rejected {dropped_rows} of {len(matching_rows)} expiry quote row(s) "
            "under the canonical IV input policy."
        )
    if opposite_side_fallbacks:
        warnings.append(
            f"Used deterministic opposite-side IV fallback at "
            f"{opposite_side_fallbacks} strike(s)."
        )
    if synthetic_anchor_added:
        warnings.append(
            "Inserted a synthetic ATM IV anchor by log-moneyness interpolation."
        )
    if not spot_bracketed:
        warnings.append("Available verified strikes do not bracket spot.")
    if ticker_market_required and not forward_bracketed:
        warnings.append("Available verified strikes do not bracket the implied forward.")
    if center_gap_exceeded:
        warnings.append(
            "Accepted strikes leave a sparse hole next to ATM in log-moneyness."
        )
    if not verified_live_quotes:
        warnings.append("IV inputs are not a ready, verified Deribit ticker stream.")
    density_filtered = (
        rejected_zero_bid_rows
        + rejected_wide_spread_rows
        + rejected_low_delta_rows
        + rejected_low_open_interest_rows
    )
    if density_filtered:
        warnings.append(
            f"Excluded {density_filtered} quote(s) from density fitting "
            "(zero bid, wide spread, low delta, or low open interest)."
        )

    return {
        "strikes": strikes,
        "ivs": ivs,
        "iv_curve": points,
        "coverage": coverage,
        "selection": selection,
        "warnings": warnings,
    }


def aggregate_expiry_mark_ivs(
    rows: Sequence[dict[str, Any]],
    *,
    expiry: str,
    spot: float,
    as_of: datetime,
    max_quote_age_seconds: float = MAX_QUOTE_AGE_SECONDS,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any], list[str]]:
    """Compatibility wrapper around the canonical IV selector."""
    normalized = normalize_expiry_iv_curve(
        rows,
        expiry=expiry,
        spot=spot,
        as_of=as_of,
        max_quote_age_seconds=max_quote_age_seconds,
    )
    return (
        normalized["strikes"],
        normalized["ivs"],
        normalized["coverage"],
        normalized["warnings"],
    )


def scan_expiry_rows(
    rows: Sequence[dict[str, Any]],
    *,
    expiry: str,
    spot: float,
    as_of: datetime,
    tail_threshold: float = TAIL_THRESHOLD,
    band_width: float = BAND_WIDTH,
    signal_delta: float = SIGNAL_DELTA,
    max_quote_age_seconds: float = MAX_QUOTE_AGE_SECONDS,
    source: str = "deribit_book_summary",
    verified_live_quotes: bool = True,
    previous_signals: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the full quick-view scanner over one normalized snapshot expiry."""
    settlement_at = deribit_settlement(expiry)
    normalized_as_of = as_of if as_of.tzinfo else as_of.replace(tzinfo=UTC)
    normalized_as_of = normalized_as_of.astimezone(UTC)
    seconds_to_expiry = (settlement_at - normalized_as_of).total_seconds()
    if seconds_to_expiry <= 0:
        raise ValueError(
            f"Expiry '{expiry}' settled at {settlement_at.isoformat()} and is expired "
            f"at snapshot as_of {normalized_as_of.isoformat()}."
        )
    if not math.isfinite(float(spot)) or spot <= 0:
        raise ValueError("Snapshot spot_price must be positive and finite.")

    time_to_expiry_years = seconds_to_expiry / SECONDS_PER_YEAR
    normalized = normalize_expiry_iv_curve(
        rows,
        expiry=expiry,
        spot=float(spot),
        as_of=normalized_as_of,
        max_quote_age_seconds=max_quote_age_seconds,
        source=source,
        verified_live_quotes=verified_live_quotes,
        time_to_expiry_years=time_to_expiry_years,
    )
    strikes = normalized["strikes"]
    ivs = normalized["ivs"]
    coverage = normalized["coverage"]
    warnings = list(normalized["warnings"])
    dense_strikes, raw_density, smoothed_density, curve_quality = (
        _build_pdf_with_quality(
            float(spot), strikes, ivs, time_to_expiry_years
        )
    )
    otm_ref = float(normalized["selection"].get("otm_reference") or spot)
    nearest_iv = None
    if len(ivs) > 0:
        nearest = min(
            range(len(strikes)),
            key=lambda index: abs(float(strikes[index]) - otm_ref),
        )
        nearest_iv = float(ivs[nearest])
    rnd = rnd_diagnostics(
        dense_strikes,
        raw_density,
        forward=otm_ref,
        atm_iv=nearest_iv,
        time_to_expiry_years=time_to_expiry_years,
    )
    signals = compute_signals(
        float(spot),
        dense_strikes,
        raw_density,
        smoothed_density,
        tail_threshold=tail_threshold,
        band_width=band_width,
        signal_delta=signal_delta,
        previous=previous_signals,
        reference_price=otm_ref,
    )

    if bool(coverage.get("center_gap_exceeded")):
        curve_quality = dict(curve_quality)
        curve_quality["level"] = "LOW"
        curve_quality["signal_eligible"] = False
        curve_quality["sparse_center"] = True
        warnings.append(
            "Curve quality is LOW because accepted strikes leave a sparse "
            "hole next to ATM; the directional verdict is suppressed."
        )

    if curve_quality["clipping_required"]:
        warnings.append(
            "Breeden-Litzenberger density contains negative values; signal "
            "integrals clip them to zero."
        )
    if curve_quality["level"] == "LOW" and not curve_quality.get("sparse_center"):
        warnings.append(
            "Curve quality is LOW because negative density area exceeds 1% "
            "or the normalization integral is invalid; the directional verdict "
            "is suppressed."
        )
    tenor = tenor_coverage_spec(time_to_expiry_years)
    selected_market_strikes = int(normalized["selection"]["selected_market_strikes"])
    ticker_coverage_low = str(source).startswith(TICKER_SOURCE_PREFIX) and (
        selected_market_strikes < tenor.min_strikes
        or int(coverage.get("lower_strikes") or 0) < tenor.min_side_strikes
        or int(coverage.get("upper_strikes") or 0) < tenor.min_side_strikes
        or float(coverage["hard_valid_coverage_ratio"]) < MIN_SIGNAL_IV_COVERAGE_RATIO
    )
    if ticker_coverage_low:
        warnings.append(
            "Verified ticker IV coverage is too sparse for a trade-eligible "
            "density; the model remains visible for diagnosis only."
        )

    suppression_reasons: list[str] = []
    if curve_quality["level"] == "LOW":
        suppression_reasons.append("LOW curve quality")
    if not verified_live_quotes:
        suppression_reasons.append("unverified IV input source")
    if not bool(coverage["spot_bracketed"]):
        suppression_reasons.append("verified strikes do not bracket spot")
    if str(source).startswith(TICKER_SOURCE_PREFIX) and not bool(
        coverage.get("forward_bracketed")
    ):
        suppression_reasons.append("verified strikes do not bracket implied forward")
    if ticker_coverage_low:
        suppression_reasons.append("insufficient verified ticker IV coverage")
    model_verdict = signals["verdict"]
    verdict: Signal = "NO_TRADE" if suppression_reasons else model_verdict

    return {
        "settlement_at": settlement_at,
        "time_to_expiry_years": float(time_to_expiry_years),
        "density": [
            {
                "strike": float(strike),
                "raw": float(raw),
                "smoothed": float(smoothed),
            }
            for strike, raw, smoothed in zip(
                dense_strikes, raw_density, smoothed_density, strict=True
            )
        ],
        "markers": {
            "spot": float(spot),
            "tail_lower": float(spot * (1 - tail_threshold)),
            "tail_upper": float(spot * (1 + tail_threshold)),
            "band_lower": float(spot * (1 - band_width)),
            "band_upper": float(spot * (1 + band_width)),
            "peak_strike": float(signals["peak"]["peak_strike"]),
        },
        "signals": {
            "skew": signals["skew"],
            "tails": signals["tails"],
            "peak": signals["peak"],
            "band": signals["band"],
        },
        "iv_curve": normalized["iv_curve"],
        "smile": build_canonical_smile(
            normalized["iv_curve"],
            forward=float(otm_ref),
            time_to_expiry_years=float(time_to_expiry_years),
        ),
        "selection": normalized["selection"],
        "curve_quality": curve_quality,
        "rnd": rnd,
        "model_verdict": model_verdict,
        "verdict": verdict,
        "suppression_reasons": suppression_reasons,
        "coverage": coverage,
        "warnings": warnings,
    }


def _integral(values: np.ndarray, strikes: np.ndarray, mask: np.ndarray) -> float:
    if not mask.any():
        return 0.0
    return float(simpson(values[mask], x=strikes[mask]))


def _direction(
    up: float, down: float, difference: float, threshold: float
) -> Signal:
    if difference < threshold:
        return "NO_TRADE"
    return "LONG" if up > down else "SHORT"


def _previous_signal(previous: Mapping[str, Any], name: str) -> Signal | None:
    raw = previous.get(name)
    if not isinstance(raw, Mapping):
        return None
    value = str(raw.get("signal") or "").upper()
    if value in {"LONG", "SHORT", "NO_TRADE"}:
        return value  # type: ignore[return-value]
    return None


def _hold_signal(
    raw: Signal,
    difference: float,
    threshold: float,
    previous: Signal | None,
    *,
    hysteresis: float = SIGNAL_HYSTERESIS,
) -> Signal:
    if previous not in {"LONG", "SHORT", "NO_TRADE"}:
        return raw
    if raw == previous:
        return raw
    if previous == "NO_TRADE":
        return raw
    if raw == "NO_TRADE":
        return previous if difference >= max(threshold - hysteresis, 0.0) else "NO_TRADE"
    return raw if difference >= threshold + hysteresis else previous


def _direction_with_hysteresis(
    up: float,
    down: float,
    difference: float,
    threshold: float,
    previous: Signal | None,
) -> Signal:
    return _hold_signal(
        _direction(up, down, difference, threshold),
        difference,
        threshold,
        previous,
    )


def confirm_published_verdict(
    *,
    raw: Signal,
    history: Sequence[str] = (),
    previous_published: Signal | None = None,
    immediate: bool = False,
) -> dict[str, Any]:
    """Hold the published outlook until raw repeats in 2 of the last 3 scans."""
    window = [str(item) for item in history if item]
    window.append(str(raw))
    window = window[-SIGNAL_CONFIRMATION_WINDOW:]
    matches = window.count(str(raw))
    if immediate or previous_published is None:
        return {
            "raw_verdict": raw,
            "published_verdict": raw,
            "forming": False,
            "confirmation_window": SIGNAL_CONFIRMATION_WINDOW,
            "confirmation_required": SIGNAL_CONFIRMATION_REQUIRED,
            "raw_matches_in_window": matches,
            "history": window,
        }
    confirmed = matches >= SIGNAL_CONFIRMATION_REQUIRED
    published: Signal = raw if confirmed else (
        previous_published if previous_published in {"LONG", "SHORT", "NO_TRADE"} else "NO_TRADE"
    )
    return {
        "raw_verdict": raw,
        "published_verdict": published,
        "forming": published != raw,
        "confirmation_window": SIGNAL_CONFIRMATION_WINDOW,
        "confirmation_required": SIGNAL_CONFIRMATION_REQUIRED,
        "raw_matches_in_window": matches,
        "history": window,
    }


def _peak_signal_with_hysteresis(
    peak_strike: float,
    spot: float,
    previous: Signal | None,
) -> Signal:
    if peak_strike > spot * (1.0 + PEAK_NEUTRAL_FRACTION):
        raw: Signal = "LONG"
    elif peak_strike < spot * (1.0 - PEAK_NEUTRAL_FRACTION):
        raw = "SHORT"
    else:
        raw = "NO_TRADE"
    if previous not in {"LONG", "SHORT"}:
        return raw
    hold_up = spot * (1.0 + PEAK_NEUTRAL_FRACTION - PEAK_HYSTERESIS_FRACTION)
    hold_down = spot * (1.0 - PEAK_NEUTRAL_FRACTION + PEAK_HYSTERESIS_FRACTION)
    if previous == "LONG" and peak_strike >= hold_up:
        return "LONG"
    if previous == "SHORT" and peak_strike <= hold_down:
        return "SHORT"
    return raw


def _validate_threshold(name: str, value: float) -> None:
    if not math.isfinite(float(value)) or value <= 0 or value >= 0.5:
        raise ValueError(f"{name} must be greater than 0 and less than 0.5.")


def _positive_finite(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed <= 0:
        return None
    return parsed


def _option_side(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    if normalized in {"c", "call"}:
        return "call"
    if normalized in {"p", "put"}:
        return "put"
    return None


def _parse_quote_as_of(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _as_utc(value)
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        numeric = float(value)
        # Accept Deribit milliseconds, JSON-RPC microseconds, or epoch seconds
        # in injected offline fixtures without weakening production validation.
        if numeric > 1e14:
            numeric /= 1_000_000.0
        elif numeric > 1e11:
            numeric /= 1_000.0
        try:
            return datetime.fromtimestamp(numeric, tz=UTC)
        except (OSError, OverflowError, ValueError):
            return None
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return _as_utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _median_iv(rows: Sequence[_SmileQuote]) -> float:
    return float(np.median(np.asarray([item.iv for item in rows], dtype=float)))


def _median_optional_iv(values: Sequence[float | None]) -> float | None:
    finite = [
        float(value)
        for value in values
        if value is not None and math.isfinite(float(value)) and float(value) > 0.0
    ]
    if not finite:
        return None
    return float(np.median(np.asarray(finite, dtype=float)))


def _median_iv_spread(rows: Sequence[_SmileQuote]) -> float:
    return float(np.median(np.asarray([item.iv_spread for item in rows], dtype=float)))


def _finite_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def _non_negative_finite(value: Any) -> float | None:
    parsed = _finite_or_none(value)
    if parsed is None or parsed < 0.0:
        return None
    return parsed


def _resolved_time_to_expiry_years(
    expiry: str,
    as_of: datetime,
    explicit: float | None,
) -> float | None:
    if explicit is not None:
        if math.isfinite(float(explicit)) and float(explicit) > 0.0:
            return float(explicit)
        return None
    try:
        seconds = (deribit_settlement(expiry) - _as_utc(as_of)).total_seconds()
    except ValueError:
        return None
    if seconds <= 0:
        return None
    return seconds / SECONDS_PER_YEAR


def _relative_spread(bid: float, ask: float) -> float | None:
    mid = (bid + ask) / 2.0
    if mid <= 0:
        return None
    return (ask - bid) / mid


def _relative_spread_cap(moneyness: float) -> float:
    weight = min(1.0, max(0.0, float(moneyness) / SPREAD_WING_MONEYNESS))
    return ATM_REL_SPREAD_CAP + weight * (WING_REL_SPREAD_CAP - ATM_REL_SPREAD_CAP)


def _iv_spread_cap(moneyness: float) -> float:
    weight = min(1.0, max(0.0, float(moneyness) / SPREAD_WING_MONEYNESS))
    return ATM_IV_SPREAD_CAP + weight * (WING_IV_SPREAD_CAP - ATM_IV_SPREAD_CAP)


def _quote_spread_rejected(quote: _SmileQuote, moneyness: float) -> bool:
    """Wide-spread screen.  Cheap books are tick-granular; IV spread leads."""
    if quote.iv_spread > _iv_spread_cap(moneyness):
        return True
    mid = (quote.bid + quote.ask) / 2.0
    if mid < MIN_PREMIUM_FOR_REL_SPREAD:
        return False
    rel_spread = _relative_spread(quote.bid, quote.ask)
    return rel_spread is not None and rel_spread > _relative_spread_cap(moneyness)


def _coverage_corridor(atm_iv: float, time_to_expiry_years: float) -> float:
    expected_move = (
        COVERAGE_VOL_UNITS * float(atm_iv) * math.sqrt(float(time_to_expiry_years))
        if atm_iv > 0 and time_to_expiry_years > 0
        else 0.0
    )
    return max(MIN_WING_COVERAGE_PCT, expected_move)


def _min_open_interest(time_to_expiry_years: float, *, far_wing: bool) -> float:
    days = float(time_to_expiry_years) * 365.0
    if days < 3.0:
        floor = 1.0
    elif days < 14.0:
        floor = 2.0
    elif days < 45.0:
        floor = 5.0
    else:
        floor = 10.0
    if far_wing:
        floor *= 2.0
    return floor


def _apply_ticker_density_filters(
    quotes: Sequence[_SmileQuote],
    *,
    spot: float,
    time_to_expiry_years: float | None,
) -> tuple[list[_SmileQuote], dict[str, int], float | None]:
    """Apply secondary live-quote screens without collapsing wing coverage."""
    empty_counts = {
        "rejected_wide_spread_rows": 0,
        "rejected_low_delta_rows": 0,
        "rejected_low_open_interest_rows": 0,
    }
    if not quotes:
        return [], empty_counts, None

    near_atm_ivs = [
        quote.iv
        for quote in quotes
        if abs(quote.strike / spot - 1.0) <= ATM_MONEYNESS
    ]
    atm_iv = float(
        np.median(
            np.asarray(near_atm_ivs or [quote.iv for quote in quotes], dtype=float)
        )
    )
    corridor = (
        _coverage_corridor(atm_iv, time_to_expiry_years)
        if time_to_expiry_years is not None
        else MIN_WING_COVERAGE_PCT
    )
    unique_strikes = sorted({quote.strike for quote in quotes})
    core_floor = tenor_coverage_spec(time_to_expiry_years).min_strikes
    core_strikes = {
        strike
        for strike in unique_strikes
        if abs(strike / spot - 1.0) <= corridor
    }
    if len(core_strikes) < core_floor:
        for strike in sorted(unique_strikes, key=lambda value: abs(value / spot - 1.0)):
            core_strikes.add(strike)
            if len(core_strikes) >= min(core_floor, len(unique_strikes)):
                break

    kept: list[_SmileQuote] = []
    rejected_wide = 0
    rejected_delta = 0
    rejected_oi = 0
    for quote in quotes:
        moneyness = abs(quote.strike / spot - 1.0)
        if _quote_spread_rejected(quote, moneyness):
            rejected_wide += 1
            continue

        in_core = quote.strike in core_strikes
        abs_delta = abs(quote.delta) if quote.delta is not None else None
        is_atm = moneyness <= ATM_MONEYNESS
        if not in_core and abs_delta is not None and (
            abs_delta < DELTA_TAIL_CUTOFF
            or abs_delta > (1.0 - DELTA_TAIL_CUTOFF)
        ):
            rejected_delta += 1
            continue
        if not is_atm and quote.open_interest is not None:
            far_wing = (
                moneyness > FAR_WING_MONEYNESS
                or (abs_delta is not None and abs_delta < FAR_WING_ABS_DELTA)
            )
            min_oi = 1.0
            if not in_core and time_to_expiry_years is not None:
                min_oi = _min_open_interest(
                    time_to_expiry_years,
                    far_wing=far_wing,
                )
            if quote.open_interest < min_oi:
                rejected_oi += 1
                continue
        kept.append(quote)

    return (
        kept,
        {
            "rejected_wide_spread_rows": rejected_wide,
            "rejected_low_delta_rows": rejected_delta,
            "rejected_low_open_interest_rows": rejected_oi,
        },
        float(corridor),
    )


def _as_utc(value: datetime) -> datetime:
    return (
        value.replace(tzinfo=UTC)
        if value.tzinfo is None
        else value.astimezone(UTC)
    )
