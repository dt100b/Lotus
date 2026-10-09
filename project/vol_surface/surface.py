"""Desk volatility surface.

Each listed expiry is an out-of-the-money smile in total variance,
interpolated with a shape-preserving PCHIP and never extrapolated past quoted
wings. Headline metrics require numerical price and calendar gates.
Constant-maturity tenors are a direct total-variance interpolation
between the two listed expiries that bracket the target, on the log-moneyness
grid both smiles actually cover. Delta strikes are roots of the Black-76
forward delta on that smile, using the listed future (the option ticker's
underlying price) as the forward.

Live marks must have fresh two-sided markets and declared forward provenance.
Constrained SVI stays a research candidate. This surface refuses a number it would have to invent:
no wing past the last quote, no tenor outside the listed maturity range.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from statistics import median
from typing import Mapping, Sequence

import numpy as np
from scipy.stats import norm
from scipy.interpolate import PchipInterpolator

from greeks.types import GreekSnapshot
from normalizer.instruments import parse_deribit_option_instrument_name
from project.options_surface.surface.fitters import FittedSmile, TotalVariancePchipFitter
from project.options_surface.surface.smile import solve_delta_strike
from project.options_surface.types import ModelStatus, PointOrigin, SmilePoint

YEAR_SECONDS = 365.0 * 24.0 * 3600.0
SETTLE_HOUR_UTC = 8
MIN_TIME_YEARS = 60.0 / YEAR_SECONDS
MIN_KNOTS = 4
MAX_QUOTE_AGE_MS = 5 * 60 * 1000
MAX_FORWARD_DISPERSION = 0.005
BODY_DELTA = 0.25
TAIL_DELTA = 0.10
# Tenors the term structure is allowed to publish. Days, ACT/365.
TERM_TENORS: tuple[tuple[str, float], ...] = (
    ("1d", 1.0),
    ("7d", 7.0),
    ("30d", 30.0),
    ("60d", 60.0),
    ("90d", 90.0),
    ("180d", 180.0),
)
FLAT_BAND_VOL_POINTS = 0.50

_FITTER = TotalVariancePchipFitter()


@dataclass(frozen=True, slots=True)
class SurfaceQuote:
    """One listed option mark. ``mark_iv`` is a decimal (0.50 = 50%)."""

    underlying: str
    expiry_ts_ms: int
    strike: float
    option_type: str
    mark_iv: float
    forward_usd: float
    open_interest: float = 0.0


def quotes_from_greeks(
    greeks: Mapping[str, GreekSnapshot],
    *,
    underlying: str = "BTC",
    as_of_ms: int | None = None,
) -> list[SurfaceQuote]:
    """Read the live ticker map. Underlying price on each option is its future."""
    wanted = underlying.upper()
    quotes: list[SurfaceQuote] = []
    for snapshot in greeks.values():
        parsed = parse_deribit_option_instrument_name(snapshot.instrument_name)
        if parsed is None or parsed.underlying != wanted:
            continue
        iv = decimal_iv(snapshot.mark_iv, unit="percent")
        if as_of_ms is not None:
            age = as_of_ms - snapshot.snapshot_ts
            bid, ask = snapshot.bid_price, snapshot.ask_price
            if age < -5_000 or age > MAX_QUOTE_AGE_MS:
                continue
            if snapshot.forward_source != "ticker_underlying_price":
                continue
            if not all(v is not None and math.isfinite(v) and v > 0 for v in
                       (bid, ask, snapshot.bid_size, snapshot.ask_size)):
                continue
            if ask < bid or (ask - bid) / ((ask + bid) / 2) > 0.50:
                continue
            bid_iv = decimal_iv(snapshot.bid_iv, unit="percent")
            ask_iv = decimal_iv(snapshot.ask_iv, unit="percent")
            if iv is None or bid_iv is None or ask_iv is None or not bid_iv <= iv <= ask_iv:
                continue
        forward = float(snapshot.spot_price)
        strike = float(parsed.strike)
        if iv is None or not math.isfinite(forward) or forward <= 0 or strike <= 0:
            continue
        quotes.append(
            SurfaceQuote(
                underlying=wanted,
                expiry_ts_ms=snapshot.expiration_timestamp or settle_ts_ms(parsed.expiry_ts_ms),
                strike=strike,
                option_type=parsed.option_type,
                mark_iv=iv,
                forward_usd=forward,
                open_interest=float(snapshot.open_interest or 0.0),
            )
        )
    return quotes


def build_slices(
    quotes: Sequence[SurfaceQuote],
    *,
    as_of_ms: int,
) -> list[FittedSmile]:
    """One smile per expiry that has a forward and at least four OTM marks."""
    as_of = datetime.fromtimestamp(as_of_ms / 1000.0, tz=UTC)
    grouped: dict[int, list[SurfaceQuote]] = {}
    for quote in quotes:
        if not all(math.isfinite(v) and v > 0 for v in
                   (quote.strike, quote.mark_iv, quote.forward_usd)):
            continue
        grouped.setdefault(quote.expiry_ts_ms, []).append(quote)

    slices: list[FittedSmile] = []
    for expiry_ts, bucket in sorted(grouped.items()):
        t_years = (expiry_ts / 1000.0 - as_of.timestamp()) / YEAR_SECONDS
        if t_years <= MIN_TIME_YEARS:
            continue
        forward = _expiry_forward(bucket)
        if forward is None:
            continue
        points = _otm_points(bucket, forward=forward, t_years=t_years)
        if len(points) < MIN_KNOTS:
            continue
        fitted = _FITTER.fit(points, time_to_expiry_years=t_years, forward_usd=forward)
        if fitted.diagnostics.status is ModelStatus.REJECTED or not fitted.knot_k:
            continue
        slices.append(fitted)
    slices.sort(key=lambda item: item.time_to_expiry_years)
    return slices


def listed_metrics(slices: Sequence[FittedSmile], *, as_of_ms: int) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for fitted in slices:
        expiry_ms = int(as_of_ms + fitted.time_to_expiry_years * YEAR_SECONDS * 1000.0)
        row = metrics_for_smile(fitted)
        row["expiry_ts_ms"] = expiry_ms
        row["expiry"] = datetime.fromtimestamp(expiry_ms / 1000.0, tz=UTC).date().isoformat()
        row["method"] = "listed_expiry"
        rows.append(row)
    return rows


def term_structure(slices: Sequence[FittedSmile]) -> list[dict[str, object]]:
    """Constant-maturity smiles. A target outside the listed range is omitted."""
    rows: list[dict[str, object]] = []
    for name, days in TERM_TENORS:
        target = days / 365.0
        fitted, method, calendar_ok = smile_at_tenor(slices, target_years=target)
        if fitted is None:
            rows.append(
                {
                    "tenor": name,
                    "target_days": days,
                    "status": "unavailable",
                    "method": method,
                    "calendar_ok": calendar_ok,
                    "validation_reasons": [method],
                }
            )
            continue
        row = metrics_for_smile(fitted)
        row["tenor"] = name
        row["target_days"] = days
        row["method"] = method
        row["calendar_ok"] = calendar_ok
        rows.append(row)
    return rows


def smile_at_tenor(
    slices: Sequence[FittedSmile],
    *,
    target_years: float,
) -> tuple[FittedSmile | None, str, bool | None]:
    """Return ``(smile, method, calendar_ok)``. No extrapolation."""
    dated = [item for item in slices if item.knot_k and item.time_to_expiry_years > 0]
    dated.sort(key=lambda item: item.time_to_expiry_years)
    if not dated or target_years <= 0:
        return None, "unavailable", None
    if target_years < dated[0].time_to_expiry_years - 1e-12:
        return None, "extrapolated", None
    if target_years > dated[-1].time_to_expiry_years + 1e-12:
        return None, "extrapolated", None

    for fitted in dated:
        if abs(fitted.time_to_expiry_years - target_years) <= 1e-10:
            if validation_reasons(fitted):
                return None, "butterfly_rejected", None
            index = dated.index(fitted)
            neighbors = []
            if index > 0:
                neighbors.append((dated[index-1], fitted))
            if index+1 < len(dated):
                neighbors.append((fitted, dated[index+1]))
            if any(not calendar_valid(a,b) for a,b in neighbors):
                return None, "calendar_rejected", False
            return fitted, "exact_expiry", True

    left = None
    right = None
    for candidate in dated:
        if candidate.time_to_expiry_years <= target_years:
            left = candidate
        if candidate.time_to_expiry_years >= target_years and right is None:
            right = candidate
    if left is None or right is None or left is right:
        return None, "unavailable", None
    if validation_reasons(left) or validation_reasons(right):
        return None, "source_smile_rejected", None
    if not calendar_valid(left, right):
        return None, "calendar_rejected", False

    span = right.time_to_expiry_years - left.time_to_expiry_years
    if span <= 0:
        return left, "exact_expiry", True
    weight = (target_years - left.time_to_expiry_years) / span
    k_lo = max(left.k_min, right.k_min)
    k_hi = min(left.k_max, right.k_max)
    if k_hi - k_lo <= 1e-8:
        return None, "no_overlap", None

    knots = _overlap_knots(left, right, k_lo, k_hi)
    if len(knots) < MIN_KNOTS:
        return None, "sparse_overlap", None

    forward = math.exp(
        (1.0 - weight) * math.log(left.forward_usd) + weight * math.log(right.forward_usd)
    )
    points: list[SmilePoint] = []
    calendar_ok = True
    for k in knots:
        w1, _ = left.total_variance(k)
        w2, _ = right.total_variance(k)
        if w1 is None or w2 is None or w1 < 0 or w2 < 0:
            continue
        if w2 + 1e-12 < w1:
            calendar_ok = False
        total_var = w1 + weight * (w2 - w1)
        if total_var <= 0:
            continue
        iv = math.sqrt(total_var / target_years)
        points.append(_point(strike=forward * math.exp(k), k=k, iv=iv, t_years=target_years))
    if len(points) < MIN_KNOTS:
        return None, "sparse_overlap", calendar_ok
    fitted = _FITTER.fit(points, time_to_expiry_years=target_years, forward_usd=forward)
    if fitted.diagnostics.status is ModelStatus.REJECTED or not fitted.knot_k:
        return None, "fit_rejected", calendar_ok
    # Evaluate the original variance blend directly, not a nonlinear PCHIP refit.
    def evaluate(k: float) -> float:
        a, _ = left.total_variance(k)
        b, _ = right.total_variance(k)
        return float("nan") if a is None or b is None else (1-weight)*a + weight*b
    fitted = replace(fitted, _evaluate_w=evaluate)
    if validation_reasons(fitted):
        return None, "interpolated_smile_rejected", calendar_ok
    return fitted, "total_variance_interpolation", calendar_ok


def metrics_for_smile(fitted: FittedSmile) -> dict[str, object]:
    """ATM, 1-sigma move, 25-delta skew, and 10-delta tail skew for one smile."""
    reasons = validation_reasons(fitted)
    if reasons:
        return {"status": "rejected", "validation_reasons": reasons,
                "t_days": fitted.time_to_expiry_years * 365,
                "knot_count": len(fitted.knot_k)}
    atm_iv, _status = fitted.iv(0.0)
    t_years = fitted.time_to_expiry_years
    forward = fitted.forward_usd
    move = _implied_move(atm_iv, t_years, forward)

    iv_25_put = _delta_iv(fitted, target=-BODY_DELTA, side="put")
    iv_25_call = _delta_iv(fitted, target=BODY_DELTA, side="call")
    iv_10_put = _delta_iv(fitted, target=-TAIL_DELTA, side="put")
    iv_10_call = _delta_iv(fitted, target=TAIL_DELTA, side="call")

    rr_25 = _risk_reversal(iv_25_put, iv_25_call)
    rr_10 = _risk_reversal(iv_10_put, iv_10_call)
    tail_gap = None if rr_25 is None or rr_10 is None else rr_10 - rr_25
    normalized = None
    if rr_25 is not None and atm_iv is not None and atm_iv > 0:
        normalized = (rr_25 / 100.0) / atm_iv

    status = "ok" if atm_iv is not None else "no_atm"
    return {
        "status": status,
        "validation_reasons": [],
        "quality": "marks_with_numerical_gates",
        "t_years": t_years,
        "t_days": t_years * 365.0,
        "forward_usd": forward,
        "knot_count": len(fitted.knot_k),
        "k_min": fitted.k_min,
        "k_max": fitted.k_max,
        "atm_iv": atm_iv,
        "atm_iv_percent": None if atm_iv is None else atm_iv * 100.0,
        "iv_25_put": iv_25_put,
        "iv_25_call": iv_25_call,
        "iv_10_put": iv_10_put,
        "iv_10_call": iv_10_call,
        "rr_25_vol_points": rr_25,
        "rr_10_vol_points": rr_10,
        "tail_gap_vol_points": tail_gap,
        "skew_25_normalized": normalized,
        **move,
    }


def classify_divergence(
    rr_25_change: float | None,
    rr_10_change: float | None,
    *,
    band: float = FLAT_BAND_VOL_POINTS,
) -> str:
    """Name the 10-delta versus 25-delta change.

    Both risk reversals are put IV minus call IV, in volatility points.
    Tail acceleration is the wing richening while the 25-delta body stays
    inside the flat band. Fear unwinding is both wings cheapening together.
    """
    if rr_25_change is None or rr_10_change is None:
        return "baseline"
    tail_up = rr_10_change > band
    tail_down = rr_10_change < -band
    body_up = rr_25_change > band
    body_down = rr_25_change < -band
    tail_flat = not tail_up and not tail_down
    body_flat = not body_up and not body_down
    if tail_up and body_flat:
        return "tail_acceleration"
    if tail_down and body_down:
        return "fear_unwinding"
    if tail_up and body_up:
        return "fear_building"
    if tail_flat and body_flat:
        return "unchanged"
    return "divergent"


def decimal_iv(raw: float | None, *, unit: str = "decimal") -> float | None:
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    if unit == "percent":
        value = value / 100.0
    elif unit != "decimal":
        raise ValueError("IV unit must be percent or decimal")
    if value <= 0 or value > 5.0:
        return None
    return value


def settle_ts_ms(expiry_midnight_ms: int) -> int:
    """Deribit option names encode a date. Settlement is 08:00 UTC that day."""
    midnight = datetime.fromtimestamp(expiry_midnight_ms / 1000.0, tz=UTC)
    settle = datetime(midnight.year, midnight.month, midnight.day, SETTLE_HOUR_UTC, tzinfo=UTC)
    return int(settle.timestamp() * 1000)


def _implied_move(
    atm_iv: float | None,
    t_years: float,
    forward: float,
) -> dict[str, float | None]:
    empty: dict[str, float | None] = {
        "implied_move_1sd_log": None,
        "implied_move_1sd_up_percent": None,
        "implied_move_1sd_down_percent": None,
        "implied_move_1sd_up_usd": None,
        "implied_move_1sd_down_usd": None,
    }
    if atm_iv is None or t_years <= 0 or forward <= 0:
        return empty
    sigma_move = atm_iv * math.sqrt(t_years)
    up = math.exp(sigma_move) - 1.0
    down = 1.0 - math.exp(-sigma_move)
    return {
        "implied_move_1sd_log": sigma_move,
        "implied_move_1sd_up_percent": up * 100.0,
        "implied_move_1sd_down_percent": down * 100.0,
        "implied_move_1sd_up_usd": forward * up,
        "implied_move_1sd_down_usd": forward * down,
    }


def _delta_iv(fitted: FittedSmile, *, target: float, side: str) -> float | None:
    _strike, iv = solve_delta_strike(fitted, target_delta=target, side=side)
    if iv is None or not math.isfinite(iv) or iv <= 0:
        return None
    return float(iv)


def _risk_reversal(put_iv: float | None, call_iv: float | None) -> float | None:
    if put_iv is None or call_iv is None:
        return None
    return (put_iv - call_iv) * 100.0


def _expiry_forward(quotes: Sequence[SurfaceQuote]) -> float | None:
    forwards = [quote.forward_usd for quote in quotes if quote.forward_usd > 0]
    if not forwards:
        return None
    forward = float(median(forwards))
    if max(abs(value / forward - 1) for value in forwards) > MAX_FORWARD_DISPERSION:
        return None
    return forward


def _otm_points(
    quotes: Sequence[SurfaceQuote],
    *,
    forward: float,
    t_years: float,
) -> list[SmilePoint]:
    """Put marks below the forward, call marks above. One mark per strike."""
    chosen: dict[float, SurfaceQuote] = {}
    for quote in quotes:
        if quote.strike <= 0 or quote.strike == forward:
            side = quote.option_type
        elif quote.strike < forward:
            side = "put"
        else:
            side = "call"
        if quote.option_type != side and quote.strike != forward:
            continue
        key = round(quote.strike, 8)
        current = chosen.get(key)
        if current is None or quote.open_interest > current.open_interest:
            chosen[key] = quote
    points: list[SmilePoint] = []
    for quote in chosen.values():
        k = math.log(quote.strike / forward)
        points.append(_point(strike=quote.strike, k=k, iv=quote.mark_iv, t_years=t_years))
    points.sort(key=lambda point: point.log_moneyness)
    return points


def _point(*, strike: float, k: float, iv: float, t_years: float) -> SmilePoint:
    return SmilePoint(
        strike_usd=strike,
        log_moneyness=k,
        iv=iv,
        total_variance=iv * iv * t_years,
        origin=PointOrigin.RAW_OBSERVED,
        option_side="otm",
        classification="otm",
        bid_iv=None,
        ask_iv=None,
        mark_iv=iv,
        quote_age_seconds=None,
        fit_weight=1.0,
        source="mark_iv",
        forward_delta=None,
    )


def _overlap_knots(
    left: FittedSmile,
    right: FittedSmile,
    k_lo: float,
    k_hi: float,
) -> list[float]:
    raw = [k for k in (*left.knot_k, *right.knot_k) if k_lo - 1e-12 <= k <= k_hi + 1e-12]
    raw.extend([k_lo, k_hi, 0.0])
    unique = sorted({min(k_hi,max(k_lo,k)) for k in raw if k_lo - 1e-12 <= k <= k_hi + 1e-12})
    return [float(k) for k in unique]


def calendar_valid(left: FittedSmile, right: FittedSmile) -> bool:
    """Check shared support including intervals between observed knots."""
    lo, hi = max(left.k_min, right.k_min), min(left.k_max, right.k_max)
    if hi <= lo:
        return False
    knots = _overlap_knots(left, right, lo, hi)
    # Listed source smiles are piecewise cubics. Inspect derivative roots of
    # their difference on every shared interval to catch arbitrarily narrow
    # crossings that any fixed grid could miss.
    if left.fitter_name == right.fitter_name == "tv_pchip":
        a_poly = PchipInterpolator(left.knot_k,left.knot_w,extrapolate=False)
        b_poly = PchipInterpolator(right.knot_k,right.knot_w,extrapolate=False)
        for start,end in zip(knots,knots[1:]):
            coefficients = [(float(b_poly(start,nu))-float(a_poly(start,nu)))/math.factorial(nu)
                            for nu in (3,2,1,0)]
            roots = np.roots(np.trim_zeros(np.asarray([3*coefficients[0],2*coefficients[1],coefficients[2]]),'f'))
            if coefficients[3] < -1e-10:
                return False
            for root in roots:
                if abs(root.imag)<1e-10 and 0<root.real<end-start:
                    if np.polyval(coefficients,root.real)<-1e-10:
                        return False
    grid = sorted(set(np.linspace(lo, hi, 2001)) | set(knots) |
                  {float(k) for a,b in zip(knots,knots[1:]) for k in np.linspace(a,b,33)})
    for k in grid:
        a, _ = left.total_variance(float(k))
        b, _ = right.total_variance(float(k))
        if a is None or b is None or b < a - 1e-10:
            return False
    return True


def validation_reasons(fitted: FittedSmile) -> list[str]:
    """Normalized Black calls: bounds, vertical spreads and butterflies.

    Numerical gates over supported strikes; never a global arbitrage-free claim.
    Include dense points within each knot interval to cover sparse wings.
    """
    if not fitted.knot_k or fitted.forward_usd <= 0:
        return ["no_fit"]
    strikes = np.unique(np.concatenate((
        np.linspace(math.exp(fitted.k_min), math.exp(fitted.k_max), 2001),
        np.exp(np.asarray(fitted.knot_k)),
        np.exp(np.concatenate([np.linspace(a,b,33) for a,b in
                               zip(fitted.knot_k,fitted.knot_k[1:])])),
    )))
    # Remove nearly duplicate grid points to avoid cancellation in divided differences.
    strikes = strikes[np.concatenate(([True], np.diff(strikes) > 1e-9))]
    w = np.asarray([fitted.total_variance(math.log(float(x)))[0] for x in strikes],dtype=float)
    if not np.all(np.isfinite(w)) or np.any(w <= 0):
        return ["non_positive_total_variance"]
    d1 = (-np.log(strikes) + w/2) / np.sqrt(w)
    calls = norm.cdf(d1) - strikes * norm.cdf(d1-np.sqrt(w))
    steps = np.diff(strikes)
    slopes = np.diff(calls)/steps
    reasons = []
    if np.any(calls < np.maximum(1-strikes,0)-1e-9) or np.any(calls > 1+1e-9):
        reasons.append("call_price_bounds")
    if np.any(slopes < -1-1e-7) or np.any(slopes > 1e-7):
        reasons.append("vertical_spread_bounds")
    curvature = np.diff(slopes)/((steps[:-1]+steps[1:])/2)
    if np.any(curvature < -1e-5):
        reasons.append("butterfly_rejected")
    return reasons
