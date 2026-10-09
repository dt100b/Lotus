"""Forward dealer-Greek surface projection for one selected expiry.

Holds one current expiry chain (signed call/put GEX + mark IV) fixed and
revalues net dollar-gamma-per-1% on a future (time, price) grid by advancing
τ → settle under Black–Scholes gamma (r = q = 0).

This is **not** historical inventory sampling. Inventory is frozen at the
snapshot; only the BS gamma kernel evolves with τ and hypothetical spot.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Any, Iterable, Literal, Sequence

# Deribit options settle 08:00 UTC.
DERIBIT_SETTLE_HOUR_UTC = 8
MS_PER_YEAR = 365.25 * 24 * 3600 * 1000
# Floor residual life so Γ does not explode / NaN at settle.
# ~5 minutes: still pins the last column near settle without a 20× peak spike
# that crushes the rest of the residual field after unit-normalize.
MIN_TAU_YEARS = 5.0 / (365.25 * 24 * 60)
# mark_iv > this → treat as percent (Deribit public ticker convention).
IV_PERCENT_THRESHOLD = 3.0
# Skip legs whose reference gamma is effectively zero (cannot ratio-scale).
MIN_REF_GAMMA = 1e-14
# Default grid density (texture bake is cheap; denser than listed strikes).
DEFAULT_N_TIMES = 64
DEFAULT_N_PRICES = 128
DEFAULT_PRICE_WINDOW_PCT = 8.0
FORWARD_SURFACE_VERSION = "gex_forward_surface.v3"

ForwardMetric = Literal["gamma", "delta", "delta_change", "charm", "vanna"]
ForwardExpiryScope = Literal["0dte", "eow", "eom"]
MAX_IV_SHIFT_BY_SCOPE: dict[ForwardExpiryScope, float] = {
    "0dte": 2.0,
    "eow": 5.0,
    "eom": 10.0,
}
FORWARD_METRICS: tuple[ForwardMetric, ...] = (
    "gamma",
    "delta",
    "delta_change",
    "charm",
    "vanna",
)
METRIC_UNITS: dict[ForwardMetric, str] = {
    "gamma": "USD / 1% move",
    "delta": "USD delta notional",
    "delta_change": "USD hedge change",
    "charm": "USD delta / day",
    "vanna": "USD delta / vol point",
}


@dataclass(frozen=True, slots=True)
class ChainLeg:
    """One signed GEX contribution at a strike (call or put book)."""

    strike: float
    gex0: float  # $ per 1% at (S0, τ0)
    iv: float  # decimal vol
    option_type: str  # call | put
    # Signed contracts × contract multiplier from the taker-flow ledger.
    # Optional for backwards compatibility with pre-v3 phase-5 snapshots.
    position_units: float | None = None


@dataclass(frozen=True, slots=True)
class ForwardGammaSurface:
    times_ms: list[int]
    prices: list[float]
    values: list[list[float]]  # [time][price] net GEX $ per 1%
    spot: float
    settle_ms: int
    as_of_ms: int
    expiry: str
    meta: dict[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "times": self.times_ms,
            "prices": self.prices,
            "values": self.values,
            "spot": self.spot,
            "settle_ms": self.settle_ms,
            "as_of_ms": self.as_of_ms,
            "expiry": self.expiry,
            "meta": self.meta,
        }


def empty_forward_surface(
    *,
    spot: float = 0.0,
    as_of_ms: int = 0,
    expiry: str = "",
    note: str = "no selected-expiry chain",
    metric: ForwardMetric = "gamma",
    iv_shift: float = 0.0,
    expiry_scope: ForwardExpiryScope = "0dte",
) -> ForwardGammaSurface:
    return ForwardGammaSurface(
        times_ms=[],
        prices=[],
        values=[],
        spot=spot,
        settle_ms=0,
        as_of_ms=as_of_ms,
        expiry=expiry,
        meta={
            "version": FORWARD_SURFACE_VERSION,
            "methodology": (
                "forward BS gamma revaluation; inventory frozen at snapshot; "
                "single selected expiry; r=q=0"
            ),
            "note": note,
            "leg_count": 0,
            "n_times": 0,
            "n_prices": 0,
            "metric": metric,
            "unit": METRIC_UNITS[metric],
            "iv_shift": float(iv_shift),
            "reference_iv": None,
            "settlement_strike": None,
            "positioning_source": "flow",
            "position_recovery": "unavailable",
            "direct_position_leg_count": 0,
            "reference_gex_coverage": 0.0,
            "expiry_scope": expiry_scope,
        },
    )


def normalize_mark_iv(raw: float | None) -> float | None:
    """Map Deribit percent or decimal mark_iv to a positive decimal vol."""
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    if value > IV_PERCENT_THRESHOLD:
        value = value / 100.0
    if not math.isfinite(value) or value <= 0 or value > 5.0:
        return None
    return value


def settle_ms_from_expiry(expiry: str) -> int | None:
    """Parse snapshot expiry ``YYYY-MM-DD`` → Deribit 08:00 UTC epoch ms."""
    if not expiry or not isinstance(expiry, str):
        return None
    text = expiry.strip()
    try:
        if "T" in text:
            # ISO datetime — use date portion only.
            text = text.split("T", 1)[0]
        year, month, day = (int(p) for p in text.split("-", 2))
        dt = datetime(year, month, day, DERIBIT_SETTLE_HOUR_UTC, 0, 0, tzinfo=UTC)
        return int(dt.timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def select_front_0dte_expiry(
    expiries: Iterable[str],
    *,
    now_ms: int,
) -> str | None:
    """Nearest unexpired Deribit daily (settle 08:00 UTC still in the future).

    ``sorted(expiries)[0]`` is *not* sufficient: after the calendar rolls, the
    lexicographic first date may already be settled, or a longer-dated book may
    sort ahead of the true front when formats differ. Always pick by settle time.
    """
    upcoming: list[tuple[int, str]] = []
    for raw in expiries:
        exp = str(raw or "").strip()
        if not exp:
            continue
        settle = settle_ms_from_expiry(exp)
        if settle is None:
            continue
        if settle > now_ms:
            upcoming.append((settle, exp))
    if not upcoming:
        return None
    upcoming.sort(key=lambda item: item[0])
    return upcoming[0][1]


def select_forward_expiry(
    expiries: Iterable[str],
    *,
    now_ms: int,
    scope: ForwardExpiryScope = "0dte",
) -> str | None:
    """Resolve the exact single expiry represented by a forward tenor.

    ``0dte`` is the nearest live settle, ``eow`` is the next live Friday, and
    ``eom`` is the next live last-Friday monthly settle. Each choice is one
    clean chain cliff; expiries are never aggregated.
    """
    upcoming: list[tuple[int, str, datetime]] = []
    for raw in expiries:
        expiry = str(raw or "").strip()
        settle = settle_ms_from_expiry(expiry)
        if settle is None or settle <= now_ms:
            continue
        upcoming.append((settle, expiry, datetime.fromtimestamp(settle / 1000, tz=UTC)))
    if not upcoming:
        return None
    upcoming.sort(key=lambda item: item[0])
    if scope == "0dte":
        return upcoming[0][1]
    if scope == "eow":
        match = next((item for item in upcoming if item[2].weekday() == 4), None)
        return match[1] if match else None
    if scope == "eom":
        match = next(
            (
                item
                for item in upcoming
                if item[2].weekday() == 4
                and (item[2] + timedelta(days=7)).month != item[2].month
            ),
            None,
        )
        return match[1] if match else None
    return upcoming[0][1]


def bs_gamma(*, spot: float, strike: float, t_years: float, iv: float) -> float | None:
    """Black–Scholes gamma (call = put) with r = q = 0."""
    if not (
        math.isfinite(spot)
        and spot > 0
        and math.isfinite(strike)
        and strike > 0
        and math.isfinite(t_years)
        and t_years > 0
        and math.isfinite(iv)
        and iv > 0
    ):
        return None
    sqrt_t = math.sqrt(t_years)
    denom = iv * sqrt_t
    if denom <= 0:
        return None
    d1 = (math.log(spot / strike) + 0.5 * iv * iv * t_years) / denom
    # φ(d1) / (S σ √τ)
    pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2.0 * math.pi)
    gamma = pdf / (spot * denom)
    if not math.isfinite(gamma) or gamma < 0:
        return None
    return gamma


def bs_delta(
    *,
    spot: float,
    strike: float,
    t_years: float,
    iv: float,
    option_type: str,
) -> float | None:
    """Black--Scholes delta with r=q=0."""
    d1_d2 = _bs_d1_d2(spot=spot, strike=strike, t_years=t_years, iv=iv)
    if d1_d2 is None:
        return None
    d1, _ = d1_d2
    call_delta = 0.5 * (1.0 + math.erf(d1 / math.sqrt(2.0)))
    return call_delta if option_type == "call" else call_delta - 1.0


def bs_charm_per_day(
    *,
    spot: float,
    strike: float,
    t_years: float,
    iv: float,
) -> float | None:
    """Calendar-time delta decay per day (call and put are equal for r=q=0)."""
    d1_d2 = _bs_d1_d2(spot=spot, strike=strike, t_years=t_years, iv=iv)
    if d1_d2 is None:
        return None
    d1, _ = d1_d2
    sqrt_t = math.sqrt(t_years)
    log_m = math.log(spot / strike)
    dd1_dtau = -log_m / (2.0 * iv * t_years * sqrt_t) + iv / (4.0 * sqrt_t)
    pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2.0 * math.pi)
    # Calendar time advances as time-to-expiry falls: dDelta/dt = -dDelta/dtau.
    value = -pdf * dd1_dtau / 365.25
    return value if math.isfinite(value) else None


def bs_vanna(
    *,
    spot: float,
    strike: float,
    t_years: float,
    iv: float,
) -> float | None:
    """Delta sensitivity to one unit of decimal volatility."""
    d1_d2 = _bs_d1_d2(spot=spot, strike=strike, t_years=t_years, iv=iv)
    if d1_d2 is None:
        return None
    d1, d2 = d1_d2
    pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2.0 * math.pi)
    value = -pdf * d2 / iv
    return value if math.isfinite(value) else None


def _bs_d1_d2(
    *, spot: float, strike: float, t_years: float, iv: float
) -> tuple[float, float] | None:
    if not (
        math.isfinite(spot)
        and spot > 0
        and math.isfinite(strike)
        and strike > 0
        and math.isfinite(t_years)
        and t_years > 0
        and math.isfinite(iv)
        and iv > 0
    ):
        return None
    sqrt_t = math.sqrt(t_years)
    denom = iv * sqrt_t
    if denom <= 0:
        return None
    d1 = (math.log(spot / strike) + 0.5 * iv * iv * t_years) / denom
    d2 = d1 - denom
    if not (math.isfinite(d1) and math.isfinite(d2)):
        return None
    return d1, d2


def extract_0dte_legs(
    rows: Sequence[dict[str, Any]],
    *,
    front_expiry: str,
) -> list[ChainLeg]:
    """Build call/put legs from snapshot rows for one exact expiry."""
    legs: list[ChainLeg] = []
    for row in rows:
        if str(row.get("expiry", "")) != front_expiry:
            continue
        try:
            strike = float(row.get("strike", 0.0))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(strike) or strike <= 0:
            continue

        call_gex = _finite_float(row.get("call_gex"), 0.0)
        put_gex = _finite_float(row.get("put_gex"), 0.0)
        call_position = _optional_finite_float(row.get("call_position_units"))
        put_position = _optional_finite_float(row.get("put_position_units"))
        call_iv = normalize_mark_iv(
            row.get("call_flow_iv")
            if row.get("call_flow_iv") is not None
            else row.get("call_mark_iv")
            if row.get("call_mark_iv") is not None
            else row.get("mark_iv")
        )
        put_iv = normalize_mark_iv(
            row.get("put_flow_iv")
            if row.get("put_flow_iv") is not None
            else row.get("put_mark_iv")
            if row.get("put_mark_iv") is not None
            else row.get("mark_iv")
        )

        if (abs(call_gex) > 0 or _is_nonzero(call_position)) and call_iv is not None:
            legs.append(
                ChainLeg(
                    strike=strike,
                    gex0=call_gex,
                    iv=call_iv,
                    option_type="call",
                    position_units=call_position,
                )
            )
        if (abs(put_gex) > 0 or _is_nonzero(put_position)) and put_iv is not None:
            legs.append(
                ChainLeg(
                    strike=strike,
                    gex0=put_gex,
                    iv=put_iv,
                    option_type="put",
                    position_units=put_position,
                )
            )
    return legs


def build_forward_gamma_surface(
    rows: Sequence[dict[str, Any]],
    *,
    spot: float,
    as_of_ms: int,
    front_expiry: str | None = None,
    n_times: int = DEFAULT_N_TIMES,
    n_prices: int = DEFAULT_N_PRICES,
    price_window_pct: float = DEFAULT_PRICE_WINDOW_PCT,
    metric: ForwardMetric = "gamma",
    iv_shift: float = 0.0,
    expiry_scope: ForwardExpiryScope = "0dte",
) -> ForwardGammaSurface:
    """Project a frozen-flow dealer Greek on a future time × price grid."""
    if metric not in FORWARD_METRICS:
        metric = "gamma"
    max_shift = MAX_IV_SHIFT_BY_SCOPE.get(expiry_scope, 2.0)
    shift = max(-max_shift, min(max_shift, float(iv_shift)))
    if not math.isfinite(spot) or spot <= 0:
        return empty_forward_surface(
            as_of_ms=as_of_ms, note="invalid spot", metric=metric, iv_shift=shift,
            expiry_scope=expiry_scope,
        )

    expiries = sorted({str(r.get("expiry")) for r in rows if r.get("expiry")})
    if not expiries:
        return empty_forward_surface(
            spot=spot, as_of_ms=as_of_ms, note="empty snapshot", metric=metric,
            iv_shift=shift, expiry_scope=expiry_scope,
        )

    now_ms = int(as_of_ms) if as_of_ms > 0 else int(datetime.now(tz=UTC).timestamp() * 1000)

    # Prefer explicit front when still live; otherwise nearest unexpired settle.
    expiry: str | None = None
    explicit_expiry_selected = False
    if front_expiry and front_expiry in expiries:
        cand_settle = settle_ms_from_expiry(front_expiry)
        if cand_settle is not None and cand_settle > now_ms:
            expiry = front_expiry
            explicit_expiry_selected = True
    if expiry is None:
        expiry = select_forward_expiry(expiries, now_ms=now_ms, scope=expiry_scope)
    if expiry is None:
        return empty_forward_surface(
            spot=spot,
            as_of_ms=now_ms,
            note=f"no unexpired {expiry_scope} expiry", metric=metric, iv_shift=shift,
            expiry_scope=expiry_scope,
        )

    settle_ms = settle_ms_from_expiry(expiry)
    if settle_ms is None:
        return empty_forward_surface(
            spot=spot, as_of_ms=now_ms, expiry=expiry, note="unparseable expiry",
            metric=metric, iv_shift=shift, expiry_scope=expiry_scope,
        )

    if settle_ms <= now_ms:
        return empty_forward_surface(
            spot=spot,
            as_of_ms=now_ms,
            expiry=expiry,
            note="selected expiry already settled", metric=metric, iv_shift=shift,
            expiry_scope=expiry_scope,
        )

    legs = extract_0dte_legs(rows, front_expiry=expiry)
    if not legs and not explicit_expiry_selected and expiry_scope == "0dte":
        # Front may be in the book with zero GEX / missing IV — try next lives.
        for alt in expiries:
            if alt == expiry:
                continue
            alt_settle = settle_ms_from_expiry(alt)
            if alt_settle is None or alt_settle <= now_ms:
                continue
            alt_legs = extract_0dte_legs(rows, front_expiry=alt)
            if alt_legs:
                expiry = alt
                settle_ms = alt_settle
                legs = alt_legs
                break
    if not legs:
        return empty_forward_surface(
            spot=spot,
            as_of_ms=now_ms,
            expiry=expiry,
            note="no non-zero selected-expiry legs with IV", metric=metric,
            iv_shift=shift, expiry_scope=expiry_scope,
        )

    tau0 = max(MIN_TAU_YEARS, (settle_ms - now_ms) / MS_PER_YEAR)

    # Precompute reference gamma and invertible scale factor per leg:
    # gex(S,τ) = gex0 * Γ(S,τ)/Γ(S0,τ0) * (S/S0)²
    # gex0 / (Gamma0 * S0^2 * .01) recovers the signed flow position units.
    # Each expiry/strike/type is one Deribit instrument, so this is not an OI
    # sign heuristic; it is an algebraic recovery of the flow ledger position.
    prepared: list[tuple[ChainLeg, float, float, float, bool]] = []
    for leg in legs:
        g_ref = bs_gamma(spot=spot, strike=leg.strike, t_years=tau0, iv=leg.iv)
        has_direct_position = _is_nonzero(leg.position_units)
        if has_direct_position:
            position_units = float(leg.position_units)
        else:
            if g_ref is None or g_ref < MIN_REF_GAMMA or abs(leg.gex0) <= 0:
                continue
            position_units = leg.gex0 / (g_ref * spot * spot * 0.01)
        shifted_iv = max(0.01, min(5.0, leg.iv + shift / 100.0))
        delta_ref = bs_delta(
            spot=spot,
            strike=leg.strike,
            t_years=tau0,
            iv=shifted_iv,
            option_type=leg.option_type,
        )
        if delta_ref is None or not math.isfinite(position_units):
            continue
        prepared.append((leg, position_units, shifted_iv, delta_ref, has_direct_position))

    if not prepared:
        return empty_forward_surface(
            spot=spot,
            as_of_ms=now_ms,
            expiry=expiry,
            note="no invertible reference gamma", metric=metric, iv_shift=shift,
            expiry_scope=expiry_scope,
        )

    n_t = max(8, int(n_times))
    n_p = max(16, int(n_prices))
    window = max(1.0, float(price_window_pct)) / 100.0

    # Price domain: ±window around spot, expanded only by material flow strikes.
    # Tiny far-wing positions remain in the valuation but no longer dilute the
    # texture resolution for the actionable near-spot field.
    p_lo = spot * (1.0 - window)
    p_hi = spot * (1.0 + window)
    material_lo, material_hi = _material_strike_bounds(prepared)
    if material_lo is not None and material_hi is not None:
        p_lo = min(p_lo, material_lo)
        p_hi = max(p_hi, material_hi)
    # Soft pad so kernels don't clip at the rim.
    pad = max((p_hi - p_lo) * 0.04, spot * 0.005)
    p_lo = max(1.0, p_lo - pad)
    p_hi = p_hi + pad
    if not (p_hi > p_lo):
        return empty_forward_surface(
            spot=spot, as_of_ms=now_ms, expiry=expiry, note="degenerate price domain",
            metric=metric, iv_shift=shift, expiry_scope=expiry_scope,
        )

    prices = [p_lo + (p_hi - p_lo) * i / (n_p - 1) for i in range(n_p)]
    times_ms = _forward_time_grid(now_ms=now_ms, settle_ms=settle_ms, n_times=n_t)
    # Last column pins exactly at settle − ε so τ never hits zero.
    times_ms[-1] = int(settle_ms - 1)

    values: list[list[float]] = []
    for t_ms in times_ms:
        tau = max(MIN_TAU_YEARS, (settle_ms - t_ms) / MS_PER_YEAR)
        col: list[float] = []
        for s in prices:
            total = 0.0
            for leg, position_units, shifted_iv, delta_ref, _ in prepared:
                if metric == "gamma":
                    greek = bs_gamma(
                        spot=s, strike=leg.strike, t_years=tau, iv=shifted_iv
                    )
                    if greek is not None:
                        total += position_units * greek * s * s * 0.01
                elif metric == "delta":
                    greek = bs_delta(
                        spot=s,
                        strike=leg.strike,
                        t_years=tau,
                        iv=shifted_iv,
                        option_type=leg.option_type,
                    )
                    if greek is not None:
                        total += position_units * greek * s
                elif metric == "delta_change":
                    greek = bs_delta(
                        spot=s,
                        strike=leg.strike,
                        t_years=tau,
                        iv=shifted_iv,
                        option_type=leg.option_type,
                    )
                    if greek is not None:
                        total += position_units * (greek - delta_ref) * s
                elif metric == "charm":
                    greek = bs_charm_per_day(
                        spot=s, strike=leg.strike, t_years=tau, iv=shifted_iv
                    )
                    if greek is not None:
                        total += position_units * greek * s
                else:  # vanna
                    greek = bs_vanna(
                        spot=s, strike=leg.strike, t_years=tau, iv=shifted_iv
                    )
                    if greek is not None:
                        total += position_units * greek * s * 0.01
            col.append(total if math.isfinite(total) else 0.0)
        values.append(col)

    active_strikes = sorted({leg.strike for leg, _, _, _, _ in prepared})
    settlement_strike = min(active_strikes, key=lambda strike: abs(strike - spot))
    nearest_legs = [item for item in prepared if item[0].strike == settlement_strike]
    reference_iv = sum(item[2] for item in nearest_legs) / max(len(nearest_legs), 1)
    direct_position_leg_count = sum(1 for item in prepared if item[4])
    if direct_position_leg_count == len(prepared):
        position_recovery = "direct_flow_positions"
    elif direct_position_leg_count > 0:
        position_recovery = "mixed"
    else:
        position_recovery = "gex_inversion"
    input_reference_gex = sum(abs(leg.gex0) for leg in legs)
    prepared_reference_gex = sum(abs(item[0].gex0) for item in prepared)
    reference_gex_coverage = (
        min(1.0, prepared_reference_gex / input_reference_gex)
        if input_reference_gex > 0
        else 1.0
    )

    return ForwardGammaSurface(
        times_ms=times_ms,
        prices=prices,
        values=values,
        spot=spot,
        settle_ms=settle_ms,
        as_of_ms=now_ms,
        expiry=expiry,
        meta={
            "version": FORWARD_SURFACE_VERSION,
            "methodology": (
                f"forward BS {metric} revaluation; taker-flow inventory frozen at snapshot; "
                "single selected expiry; r=q=0; position recovered algebraically from flow GEX"
            ),
            "note": "Pure forward projection from now to expiry; frozen inventory and IV smile",
            "leg_count": len(prepared),
            "n_times": n_t,
            "n_prices": n_p,
            "price_window_pct": float(price_window_pct),
            "tau0_years": tau0,
            "tau0_hours": tau0 * 365.25 * 24,
            "metric": metric,
            "unit": METRIC_UNITS[metric],
            "iv_shift": shift,
            "reference_iv": reference_iv,
            "settlement_strike": settlement_strike,
            "positioning_source": "flow",
            "position_recovery": position_recovery,
            "direct_position_leg_count": direct_position_leg_count,
            "reference_gex_coverage": reference_gex_coverage,
            "expiry_scope": expiry_scope,
        },
    )


def _forward_time_grid(*, now_ms: int, settle_ms: int, n_times: int) -> list[int]:
    """Monotonic grid with extra density near the nonlinear expiry cliff."""
    n = max(2, int(n_times))
    span = settle_ms - now_ms
    out: list[int] = []
    for i in range(n):
        u = i / (n - 1)
        # A linear/nonlinear blend retains broad session coverage while giving
        # charm/gamma enough samples in the final residual hour.
        progress = 0.55 * u + 0.45 * (1.0 - (1.0 - u) ** 2.2)
        out.append(int(now_ms + span * progress))
    out[0] = int(now_ms)
    out[-1] = int(settle_ms - 1)
    return out


def _material_strike_bounds(
    prepared: Sequence[tuple[ChainLeg, float, float, float, bool]],
) -> tuple[float | None, float | None]:
    """Return the central 99% of reference |GEX| by strike."""
    by_strike: dict[float, float] = {}
    for leg, position_units, _, _, _ in prepared:
        # Reference GEX is the right salience weight.  Direct-position-only
        # zero-gamma wings receive a tiny position fallback so they are modeled
        # without forcing an enormous chart domain.
        weight = abs(leg.gex0)
        if weight <= 0:
            weight = abs(position_units) * 1e-9
        by_strike[leg.strike] = by_strike.get(leg.strike, 0.0) + weight
    points = sorted(by_strike.items())
    total = sum(weight for _, weight in points)
    if not points or total <= 0:
        return None, None

    def quantile_strike(q: float) -> float:
        target = total * q
        cumulative = 0.0
        for strike, weight in points:
            cumulative += weight
            if cumulative >= target:
                return strike
        return points[-1][0]

    return quantile_strike(0.005), quantile_strike(0.995)


def _finite_float(value: Any, default: float = 0.0) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _optional_finite_float(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _is_nonzero(value: float | None) -> bool:
    return value is not None and math.isfinite(value) and abs(value) > 0
