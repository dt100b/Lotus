"""25Δ normalized skew for Regime secondary (replaces Velocity UI series).

Definition::

    25Δ Skew Normalized = (IV_25Δ_put − IV_25Δ_call) / ATM_IV

- Positive → puts richer than calls (put skew)
- Negative → calls richer than puts (call skew)

IV points come from the live Greeks map (mark_iv). Absolute delta is taken from
the ticker when present, otherwise Black–Scholes (r=q=0) using mark_iv.

25Δ / ATM IVs are linear-interpolated in |Δ|-space on the chosen expiry.
Tenors: 1W (7d), 1M (30d), 3M (90d); 6M (180d) optional when chain allows.

History persists 1W / 1M / 3M / 6M independently in a tier-compacted,
400-day ring. The legacy chart series remains the currently resolved primary
tenor (1M, then 1W, then 3M) without mixing fallback values across tenors.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from greeks.types import GreekSnapshot
from normalizer.instruments import parse_deribit_option_instrument_name

SKEW_HISTORY_VERSION = "skew_25d_history.v2"
SKEW_HISTORY_LEGACY_VERSION = "skew_25d_history.v1"
SKEW_HISTORY_FILENAME = "skew_25d_history.json"
SKEW_FORMULA = "(IV_25d_put - IV_25d_call) / ATM_IV"
SKEW_PAYLOAD_KEY = "skew_25d"

# Tiered history keeps enough data for a one-year view without carrying
# minute-resolution rows for the entire period. Each persisted row contains all
# stable tenors independently; compaction retains the newest row in each bucket.
HISTORY_FINE_WINDOW_MS = 48 * 3600 * 1000
HISTORY_MID_WINDOW_MS = 30 * 24 * 3600 * 1000
HISTORY_RETENTION_MS = 400 * 24 * 3600 * 1000
HISTORY_FINE_BUCKET_MS = 5 * 60 * 1000
HISTORY_MID_BUCKET_MS = 30 * 60 * 1000
HISTORY_ARCHIVE_BUCKET_MS = 6 * 3600 * 1000
# The tier policy yields roughly 3,400 rows at steady state. Leave headroom for
# boundary buckets / migrated data while keeping corrupt artifacts bounded.
HISTORY_MAX_SAMPLES = 4_096

# Tenor targets (calendar days to expiry).
TENOR_TARGET_DAYS: dict[str, float] = {
    "1w": 7.0,
    "1m": 30.0,
    "3m": 90.0,
    "6m": 180.0,
}
# Exact constant-maturity targets used only by the ATM term-structure curve.
# The normalized 25-delta skew levels above remain expiry-specific.
TERM_ATM_TARGET_DAYS: dict[str, float] = {
    "1d": 1.0,
    **TENOR_TARGET_DAYS,
}
LEVEL_TENORS: tuple[str, ...] = ("1w", "1m", "3m")
OPTIONAL_TENORS: tuple[str, ...] = ("6m",)
HISTORY_TENORS: tuple[str, ...] = (*LEVEL_TENORS, *OPTIONAL_TENORS)
PRIMARY_TENOR = "1m"
PRIMARY_FALLBACK_TENOR = "1w"

TARGET_25D = 0.25
ATM_DELTA = 0.50
# Nearest-|Δ| fallback when no bracket exists around the target.
DELTA_NEAREST_TOL = 0.08
# Ignore near-zero residual life (unstable IV/Δ).
MIN_DTE_DAYS = 0.35
# Constant-maturity ATM needs the lower daily expiry until it settles. Retain
# positive-lived chain points down to one minute; expiry-specific skew selection
# still enforces ``MIN_DTE_DAYS`` independently.
TERM_MIN_DTE_DAYS = 1.0 / (24.0 * 60.0)
# mark_iv > this → treat as percent (Deribit public ticker convention).
IV_PERCENT_THRESHOLD = 3.0

MS_PER_DAY = 86_400_000.0
# Deribit options settle 08:00 UTC. Instrument ``expiry_ts_ms`` is midnight UTC
# of the expiry date (parser convention) — residual life must use real settle.
DERIBIT_SETTLE_HOUR_UTC = 8


def deribit_settle_ms_from_expiry_ts(expiry_ts_ms: int) -> int:
    """Map parser midnight ``expiry_ts_ms`` → Deribit settlement epoch ms."""
    day = datetime.fromtimestamp(int(expiry_ts_ms) / 1000, tz=UTC).date()
    return int(
        datetime(
            day.year,
            day.month,
            day.day,
            DERIBIT_SETTLE_HOUR_UTC,
            0,
            0,
            tzinfo=UTC,
        ).timestamp()
        * 1000
    )


def residual_dte_days(expiry_ts_ms: int, as_of_ms: int) -> float:
    """Calendar days of residual life until Deribit settle (not midnight)."""
    return (deribit_settle_ms_from_expiry_ts(expiry_ts_ms) - int(as_of_ms)) / MS_PER_DAY


@dataclass(frozen=True, slots=True)
class ChainPoint:
    instrument_name: str
    option_type: str  # call | put
    strike: float
    expiry_ts_ms: int
    spot: float
    mark_iv: float  # decimal vol (e.g. 0.55)
    abs_delta: float
    delta_source: str  # ticker | bs


def history_path(artifacts_dir: str | Path) -> Path:
    return Path(artifacts_dir) / SKEW_HISTORY_FILENAME


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


def bs_abs_delta(
    *,
    spot: float,
    strike: float,
    t_years: float,
    iv: float,
    option_type: str,
) -> float | None:
    """|Δ| under Black–Scholes with r = q = 0 (stable ATM crypto approximation)."""
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
    if sqrt_t <= 0:
        return None
    d1 = (math.log(spot / strike) + 0.5 * iv * iv * t_years) / (iv * sqrt_t)
    call_delta = _norm_cdf(d1)
    if option_type == "call":
        delta = call_delta
    elif option_type == "put":
        delta = call_delta - 1.0
    else:
        return None
    if not math.isfinite(delta):
        return None
    return abs(delta)


def interpolate_iv_at_abs_delta(
    points: Sequence[tuple[float, float]],
    target: float,
    *,
    nearest_tol: float = DELTA_NEAREST_TOL,
) -> float | None:
    """Linear IV interpolation in |Δ|-space; nearest fallback within ``nearest_tol``."""
    cleaned: list[tuple[float, float]] = []
    for abs_delta, iv in points:
        if (
            math.isfinite(abs_delta)
            and 0.0 < abs_delta < 1.0
            and math.isfinite(iv)
            and iv > 0
        ):
            cleaned.append((float(abs_delta), float(iv)))
    if not cleaned:
        return None
    cleaned.sort(key=lambda p: p[0])

    for abs_delta, iv in cleaned:
        if abs(abs_delta - target) < 1e-9:
            return iv

    below = [p for p in cleaned if p[0] < target]
    above = [p for p in cleaned if p[0] > target]
    if below and above:
        d0, iv0 = max(below, key=lambda p: p[0])
        d1, iv1 = min(above, key=lambda p: p[0])
        if d1 <= d0:
            return iv0
        weight = (target - d0) / (d1 - d0)
        return iv0 + weight * (iv1 - iv0)

    nearest_d, nearest_iv = min(cleaned, key=lambda p: abs(p[0] - target))
    if abs(nearest_d - target) <= nearest_tol:
        return nearest_iv
    return None


def build_chain_points(
    greeks: Mapping[str, GreekSnapshot],
    *,
    as_of_ms: int,
) -> list[ChainPoint]:
    """Materialize IV / |Δ| points from the live Greeks map."""
    out: list[ChainPoint] = []
    for name, snap in greeks.items():
        parsed = parse_deribit_option_instrument_name(str(name))
        if parsed is None:
            continue
        iv = normalize_mark_iv(snap.mark_iv)
        if iv is None:
            continue
        spot = float(snap.spot_price) if snap.spot_price is not None else 0.0
        if not (math.isfinite(spot) and spot > 0):
            continue
        expiry_ts_ms = int(parsed.expiry_ts_ms)
        # Residual life to real Deribit settle (08:00 UTC), not midnight stamp.
        dte = residual_dte_days(expiry_ts_ms, as_of_ms)
        if dte < TERM_MIN_DTE_DAYS:
            continue
        t_years = dte / 365.0
        option_type = parsed.option_type
        strike = float(parsed.strike)

        abs_delta: float | None = None
        delta_source = "bs"
        raw_delta = getattr(snap, "delta", None)
        if raw_delta is not None:
            try:
                d = float(raw_delta)
            except (TypeError, ValueError):
                d = float("nan")
            if math.isfinite(d) and abs(d) > 0 and abs(d) < 1.0:
                abs_delta = abs(d)
                delta_source = "ticker"

        if abs_delta is None:
            abs_delta = bs_abs_delta(
                spot=spot,
                strike=strike,
                t_years=t_years,
                iv=iv,
                option_type=option_type,
            )
            delta_source = "bs"

        if abs_delta is None:
            continue

        out.append(
            ChainPoint(
                instrument_name=str(name),
                option_type=option_type,
                strike=strike,
                expiry_ts_ms=expiry_ts_ms,
                spot=spot,
                mark_iv=iv,
                abs_delta=float(abs_delta),
                delta_source=delta_source,
            )
        )
    return out


def select_expiry_for_tenor(
    points: Sequence[ChainPoint],
    *,
    as_of_ms: int,
    target_days: float,
) -> int | None:
    """Pick expiry whose residual life to Deribit settle is closest to ``target_days``."""
    expiries = {p.expiry_ts_ms for p in points}
    best: int | None = None
    best_dist: float | None = None
    for expiry_ts in expiries:
        dte = residual_dte_days(int(expiry_ts), as_of_ms)
        if dte < MIN_DTE_DAYS:
            continue
        dist = abs(dte - target_days)
        if best_dist is None or dist < best_dist:
            best = int(expiry_ts)
            best_dist = dist
    return best


# Legacy nearest-expiry helper retained for compatibility and skew diagnostics.
# The production ATM term curve uses ``compute_constant_maturity_atm`` below.
FRONT_TENOR_TARGET_DAYS = 1.0


def select_front_expiry(
    points: Sequence[ChainPoint],
    *,
    as_of_ms: int,
    target_days: float = FRONT_TENOR_TARGET_DAYS,
) -> int | None:
    """Fixed ~1d term-structure front (not rolling nearest, not ~7d).

    Picks the listed expiry whose residual life is closest to ``target_days``
    (default 1.0), among contracts with DTE ≥ MIN_DTE. Same selection primitive
    as tenor skew legs (``select_expiry_for_tenor``).

    Production term-structure values do not use this nearest-expiry helper.
    """
    return select_expiry_for_tenor(
        points,
        as_of_ms=as_of_ms,
        target_days=float(target_days),
    )


def compute_atm_for_expiry(
    points: Sequence[ChainPoint],
    *,
    expiry_ts_ms: int,
) -> dict[str, Any] | None:
    """ATM IV on a single expiry (no 25Δ required). None when incomplete."""
    bucket = [p for p in points if p.expiry_ts_ms == expiry_ts_ms]
    if not bucket:
        return None

    call_pts = [(p.abs_delta, p.mark_iv) for p in bucket if p.option_type == "call"]
    put_pts = [(p.abs_delta, p.mark_iv) for p in bucket if p.option_type == "put"]
    atm_iv = _atm_iv(call_pts, put_pts, bucket)
    if atm_iv is None or atm_iv <= 0:
        return None

    spot = next((p.spot for p in bucket if p.spot > 0), None)
    return {
        "atm_iv": float(atm_iv),
        "expiry_ts_ms": int(expiry_ts_ms),
        "spot": float(spot) if spot is not None else None,
        "n_calls": len(call_pts),
        "n_puts": len(put_pts),
    }


def compute_constant_maturity_atm(
    points: Sequence[ChainPoint],
    *,
    as_of_ms: int,
    target_days: float,
) -> dict[str, Any]:
    """Return an exact fixed-maturity ATM IV using total-variance interpolation.

    ATM IV is first resolved independently on every usable listed expiry. The
    two valid expiries bracketing ``target_days`` are then interpolated in total
    variance (``iv² * time``), which is the standard way to construct a smooth
    constant-maturity volatility point. Extrapolation is deliberately refused:
    a fixed-tenor label must never silently represent a materially different
    listed expiry.
    """
    target = float(target_days)
    if not math.isfinite(target) or target <= 0:
        return {"status": "invalid_target", "target_days": target_days}

    samples: list[dict[str, Any]] = []
    for expiry_ts_ms in sorted({point.expiry_ts_ms for point in points}):
        dte_days = residual_dte_days(expiry_ts_ms, as_of_ms)
        if dte_days < TERM_MIN_DTE_DAYS:
            continue
        computed = compute_atm_for_expiry(points, expiry_ts_ms=expiry_ts_ms)
        if computed is None:
            continue
        samples.append(
            {
                "expiry_ts_ms": int(expiry_ts_ms),
                "dte_days": float(dte_days),
                "atm_iv": float(computed["atm_iv"]),
            }
        )

    lower = max(
        (sample for sample in samples if sample["dte_days"] <= target),
        key=lambda sample: sample["dte_days"],
        default=None,
    )
    upper = min(
        (sample for sample in samples if sample["dte_days"] >= target),
        key=lambda sample: sample["dte_days"],
        default=None,
    )

    if lower is None or upper is None:
        return {
            "status": "no_bracket",
            "target_days": target,
            "lower_expiry_ts_ms": lower["expiry_ts_ms"] if lower else None,
            "lower_dte_days": lower["dte_days"] if lower else None,
            "upper_expiry_ts_ms": upper["expiry_ts_ms"] if upper else None,
            "upper_dte_days": upper["dte_days"] if upper else None,
        }

    lower_dte = float(lower["dte_days"])
    upper_dte = float(upper["dte_days"])
    lower_iv = float(lower["atm_iv"])
    upper_iv = float(upper["atm_iv"])

    if abs(upper_dte - lower_dte) < 1e-12:
        weight = 0.0
        atm_iv = lower_iv
        method = "exact_expiry"
    else:
        weight = (target - lower_dte) / (upper_dte - lower_dte)
        lower_total_variance = lower_iv * lower_iv * (lower_dte / 365.0)
        upper_total_variance = upper_iv * upper_iv * (upper_dte / 365.0)
        target_total_variance = (
            lower_total_variance
            + weight * (upper_total_variance - lower_total_variance)
        )
        target_years = target / 365.0
        if target_total_variance <= 0 or target_years <= 0:
            return {"status": "invalid_variance", "target_days": target}
        atm_iv = math.sqrt(target_total_variance / target_years)
        method = "total_variance_interpolation"

    return {
        "status": "ok",
        "method": method,
        "atm_iv": float(atm_iv),
        # This is an exact constant-maturity point, not either source expiry.
        "dte_days": target,
        "target_days": target,
        "interpolation_weight": float(weight),
        "lower_expiry_ts_ms": int(lower["expiry_ts_ms"]),
        "lower_dte_days": lower_dte,
        "lower_atm_iv": lower_iv,
        "upper_expiry_ts_ms": int(upper["expiry_ts_ms"]),
        "upper_dte_days": upper_dte,
        "upper_atm_iv": upper_iv,
    }


def compute_skew_for_expiry(
    points: Sequence[ChainPoint],
    *,
    expiry_ts_ms: int,
) -> dict[str, Any] | None:
    """Normalized 25Δ skew on a single expiry; None when inputs are incomplete."""
    bucket = [p for p in points if p.expiry_ts_ms == expiry_ts_ms]
    if not bucket:
        return None

    call_pts = [(p.abs_delta, p.mark_iv) for p in bucket if p.option_type == "call"]
    put_pts = [(p.abs_delta, p.mark_iv) for p in bucket if p.option_type == "put"]

    iv_25_call = interpolate_iv_at_abs_delta(call_pts, TARGET_25D)
    iv_25_put = interpolate_iv_at_abs_delta(put_pts, TARGET_25D)
    if iv_25_call is None or iv_25_put is None:
        return None

    atm_iv = _atm_iv(call_pts, put_pts, bucket)
    if atm_iv is None or atm_iv <= 0:
        return None

    skew = (iv_25_put - iv_25_call) / atm_iv
    if not math.isfinite(skew):
        return None

    spot = next((p.spot for p in bucket if p.spot > 0), None)
    return {
        "value": float(skew),
        "iv_25d_put": float(iv_25_put),
        "iv_25d_call": float(iv_25_call),
        "atm_iv": float(atm_iv),
        "expiry_ts_ms": int(expiry_ts_ms),
        "spot": float(spot) if spot is not None else None,
        "n_calls": len(call_pts),
        "n_puts": len(put_pts),
    }


def compute_skew_levels(
    greeks: Mapping[str, GreekSnapshot],
    *,
    as_of_ms: int,
) -> dict[str, Any]:
    """Current normalized 25Δ skew for 1W / 1M / 3M (+ optional 6M).

    Also computes a display-only, exact constant-maturity ATM curve. These ATM
    points are not used by Environment / Dealer Γ or the normalized skew lines.
    """
    points = build_chain_points(greeks, as_of_ms=as_of_ms)
    levels: dict[str, float | None] = {k: None for k in LEVEL_TENORS}
    for key in OPTIONAL_TENORS:
        levels[key] = None
    detail: dict[str, Any] = {}

    for tenor, target_days in TENOR_TARGET_DAYS.items():
        expiry = select_expiry_for_tenor(points, as_of_ms=as_of_ms, target_days=target_days)
        if expiry is None:
            detail[tenor] = {"status": "no_expiry"}
            continue
        computed = compute_skew_for_expiry(points, expiry_ts_ms=expiry)
        if computed is None:
            detail[tenor] = {
                "status": "insufficient_smile",
                "expiry_ts_ms": expiry,
                "dte_days": residual_dte_days(expiry, as_of_ms),
            }
            continue
        levels[tenor] = float(computed["value"])
        detail[tenor] = {
            "status": "ok",
            "dte_days": residual_dte_days(expiry, as_of_ms),
            **computed,
        }

    term = {
        tenor: compute_constant_maturity_atm(
            points,
            as_of_ms=as_of_ms,
            target_days=target_days,
        )
        for tenor, target_days in TERM_ATM_TARGET_DAYS.items()
    }
    # Backward-compatible alias for consumers that predate the full term map.
    front = dict(term["1d"])

    return {
        "levels": levels,
        "detail": detail,
        "term": term,
        "front": front,
        "chain_point_count": len(points),
    }


def resolve_primary_tenor(levels: Mapping[str, float | None]) -> tuple[str | None, float | None]:
    """Primary skew tenor for display/history: 1M → 1W → 3M."""
    for key in (PRIMARY_TENOR, PRIMARY_FALLBACK_TENOR, "3m"):
        value = levels.get(key)
        if value is not None and math.isfinite(float(value)):
            return key, float(value)
    return None, None


def append_skew_history_levels(
    artifacts_dir: str | Path,
    *,
    ts_ms: int,
    levels: Mapping[str, float | None],
) -> dict[str, Any]:
    """Append one all-tenor row and apply tiered retention/compaction.

    Missing or non-finite values are persisted as ``None`` in their own tenor
    slot. They are intentionally omitted from that tenor's payload series later,
    so one unavailable smile never suppresses or contaminates another tenor.
    """
    path = history_path(artifacts_dir)
    doc = _load_history(path)
    sample = {
        "ts_ms": int(ts_ms),
        "values": _normalize_tenor_values(levels),
    }
    samples = list(doc.get("samples") or [])

    # Exact-timestamp rematerialization replaces the row atomically. Ordinary
    # rapid cycles are collapsed by the age-appropriate bucket policy below.
    replaced = False
    for index, existing in enumerate(samples):
        if int(existing.get("ts_ms", 0)) == int(ts_ms):
            samples[index] = sample
            replaced = True
            break
    if not replaced:
        samples.append(sample)

    newest_ts = max((int(row.get("ts_ms", 0)) for row in samples), default=int(ts_ms))
    samples = _compact_history_samples(samples, reference_ts_ms=newest_ts)
    out = _build_history_doc(samples)
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_json_atomic(path, out)
    return out


def append_skew_history_sample(
    artifacts_dir: str | Path,
    *,
    ts_ms: int,
    value: float,
    tenor: str,
) -> dict[str, Any]:
    """Backward-compatible single-tenor append wrapper.

    New production code writes all levels with ``append_skew_history_levels``.
    This wrapper maps the value only to the named tenor and never clones it into
    any other history series.
    """
    key = str(tenor).lower()
    if key not in HISTORY_TENORS:
        raise ValueError(f"Unsupported skew tenor: {tenor}")

    # Preserve other values if a compatibility caller fills the same timestamp
    # one tenor at a time.
    values: dict[str, float | None] = {name: None for name in HISTORY_TENORS}
    current = _load_history(history_path(artifacts_dir))
    for row in current.get("samples") or []:
        if int(row.get("ts_ms", 0)) == int(ts_ms):
            values.update(_normalize_tenor_values(row.get("values")))
            break
    values[key] = _finite_float_or_none(value)
    return append_skew_history_levels(
        artifacts_dir,
        ts_ms=ts_ms,
        levels=values,
    )


def load_skew_history_doc(artifacts_dir: str | Path) -> dict[str, Any]:
    return _load_history(history_path(artifacts_dir))


def build_skew_25d_payload(
    *,
    as_of_ms: int,
    levels: Mapping[str, float | None],
    history_doc: Mapping[str, Any] | None,
    primary_tenor: str | None,
    chain_point_count: int = 0,
    detail: Mapping[str, Any] | None = None,
    term: Mapping[str, Any] | None = None,
    front: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Shape for ``flow_regime.skew_25d`` including exact ATM term points."""
    history_rows = _normalize_history_samples((history_doc or {}).get("samples"))
    series_by_tenor: dict[str, list[dict[str, Any]]] = {
        key: [] for key in HISTORY_TENORS
    }
    for sample in history_rows:
        ts = int(sample["ts_ms"])
        values = sample["values"]
        for key in HISTORY_TENORS:
            value = _finite_float_or_none(values.get(key))
            if value is not None:
                series_by_tenor[key].append({"ts_ms": ts, "value": value})

    # Legacy consumers still receive one semantically stable series: the
    # currently resolved primary tenor only. Historical fallback rows from a
    # different tenor are never mixed into it.
    series = list(series_by_tenor.get(str(primary_tenor), [])) if primary_tenor else []

    level_out = {
        key: _finite_float_or_none(levels.get(key)) for key in HISTORY_TENORS
    }

    front_out = dict(front or {"status": "no_expiry"})
    term_out = {
        key: dict((term or {}).get(key) or {"status": "no_bracket"})
        for key in TERM_ATM_TARGET_DAYS
    }

    return {
        "formula": SKEW_FORMULA,
        "primary_tenor": primary_tenor,
        "sign": {
            "positive": "puts richer than calls (put skew)",
            "negative": "calls richer than puts (call skew)",
        },
        "levels": {
            "1w": level_out.get("1w"),
            "1m": level_out.get("1m"),
            "3m": level_out.get("3m"),
            "6m": level_out.get("6m"),
        },
        # Display-only exact constant-maturity ATM curve. Not scored.
        "term": term_out,
        # Backward-compatible 1d alias.
        "front": front_out,
        "series": series,
        "series_by_tenor": series_by_tenor,
        "meta": {
            "as_of_ms": int(as_of_ms),
            "atm_definition": (
                "mean of call/put IV linearly interpolated at |Δ|=0.50; "
                "fallback to strike-nearest call/put mid IV"
            ),
            "delta_interpolation": "linear in |delta|-space to 0.25; nearest within 0.08 if unbracketed",
            "delta_source_preference": "ticker delta when present, else BS |Δ| from mark_iv (r=q=0)",
            "iv_unit": "decimal vol (Deribit mark_iv percent / 100 when needed)",
            "term_atm_definition": (
                "Exact constant-maturity ATM IV from linear interpolation of total variance "
                "between bracketing Deribit expiries; source-expiry ATM is the mean of call/put "
                "IV at |delta|=0.50. No maturity extrapolation."
            ),
            "front_definition": "Exact 1d constant-maturity ATM from the term map.",
            "front_target_days": FRONT_TENOR_TARGET_DAYS,
            "term_target_days": dict(TERM_ATM_TARGET_DAYS),
            "primary_tenor_preference": [PRIMARY_TENOR, PRIMARY_FALLBACK_TENOR, "3m"],
            "chart_tenor": primary_tenor,
            "chain_point_count": int(chain_point_count),
            "history_sample_count": len(series),
            "history_row_count": len(history_rows),
            "history_point_count_by_tenor": {
                key: len(series_by_tenor[key]) for key in HISTORY_TENORS
            },
            "detail": dict(detail or {}),
        },
    }


def empty_skew_25d_payload(*, as_of_ms: int = 0) -> dict[str, Any]:
    return build_skew_25d_payload(
        as_of_ms=as_of_ms,
        levels={key: None for key in HISTORY_TENORS},
        history_doc={"samples": []},
        primary_tenor=None,
        chain_point_count=0,
        term={key: {"status": "no_bracket"} for key in TERM_ATM_TARGET_DAYS},
        front={"status": "no_expiry"},
    )


def build_and_persist_skew_25d(
    artifacts_dir: str | Path,
    *,
    as_of_ms: int,
    greeks: Mapping[str, GreekSnapshot],
) -> dict[str, Any]:
    """Compute live levels, append primary sample to the ring, return payload."""
    computed = compute_skew_levels(greeks, as_of_ms=as_of_ms)
    levels = computed["levels"]
    primary_tenor, _primary_value = resolve_primary_tenor(levels)

    # Persist every tenor independently on every calculation. The primary value
    # is intentionally not used for history writes: a fallback tenor must never
    # be relabeled or mixed into another tenor's line.
    history_doc = append_skew_history_levels(
        artifacts_dir,
        ts_ms=as_of_ms,
        levels=levels,
    )

    return build_skew_25d_payload(
        as_of_ms=as_of_ms,
        levels=levels,
        history_doc=history_doc,
        primary_tenor=primary_tenor,
        chain_point_count=int(computed.get("chain_point_count") or 0),
        detail=computed.get("detail"),
        term=computed.get("term"),
        front=computed.get("front"),
    )


# ── internals ────────────────────────────────────────────────────────────────


def _atm_iv(
    call_pts: Sequence[tuple[float, float]],
    put_pts: Sequence[tuple[float, float]],
    bucket: Sequence[ChainPoint],
) -> float | None:
    atm_call = interpolate_iv_at_abs_delta(call_pts, ATM_DELTA)
    atm_put = interpolate_iv_at_abs_delta(put_pts, ATM_DELTA)
    if atm_call is not None and atm_put is not None:
        return 0.5 * (atm_call + atm_put)
    if atm_call is not None:
        return atm_call
    if atm_put is not None:
        return atm_put

    # Strike-nearest-to-spot mid (call + put) when |Δ|=0.50 smile is thin.
    spot = next((p.spot for p in bucket if p.spot > 0), None)
    if spot is None:
        return None
    by_strike: dict[float, dict[str, float]] = {}
    for p in bucket:
        slot = by_strike.setdefault(p.strike, {})
        slot[p.option_type] = p.mark_iv
    if not by_strike:
        return None
    nearest_strike = min(by_strike.keys(), key=lambda k: abs(k - spot))
    pair = by_strike[nearest_strike]
    if "call" in pair and "put" in pair:
        return 0.5 * (pair["call"] + pair["put"])
    return pair.get("call") or pair.get("put")


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _finite_float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _normalize_tenor_values(values: Any) -> dict[str, float | None]:
    source = values if isinstance(values, Mapping) else {}
    return {
        key: _finite_float_or_none(source.get(key))
        for key in HISTORY_TENORS
    }


def _normalize_history_samples(samples: Any) -> list[dict[str, Any]]:
    """Normalize v2 rows and migrate v1 rows without cross-tenor cloning."""
    if not isinstance(samples, list):
        return []

    by_timestamp: dict[int, dict[str, float | None]] = {}
    for raw in samples:
        if not isinstance(raw, Mapping):
            continue
        try:
            ts_ms = int(raw.get("ts_ms", 0))
        except (TypeError, ValueError):
            continue
        if ts_ms <= 0:
            continue

        if isinstance(raw.get("values"), Mapping):
            values = _normalize_tenor_values(raw.get("values"))
        else:
            # v1: one value explicitly belongs only to its recorded tenor.
            tenor = str(raw.get("tenor") or "").lower()
            value = _finite_float_or_none(raw.get("value"))
            if tenor not in HISTORY_TENORS or value is None:
                continue
            values = {key: None for key in HISTORY_TENORS}
            values[tenor] = value

        existing = by_timestamp.get(ts_ms)
        if existing is None:
            by_timestamp[ts_ms] = values
            continue
        # Multiple legacy rows can share a timestamp. Merge only explicit finite
        # values into their own slots; never copy a value across tenors.
        for key, value in values.items():
            if value is not None:
                existing[key] = value

    return [
        {"ts_ms": ts_ms, "values": by_timestamp[ts_ms]}
        for ts_ms in sorted(by_timestamp)
    ]


def _history_bucket_for_age(age_ms: int) -> tuple[str, int]:
    if age_ms <= HISTORY_FINE_WINDOW_MS:
        return "fine", HISTORY_FINE_BUCKET_MS
    if age_ms <= HISTORY_MID_WINDOW_MS:
        return "mid", HISTORY_MID_BUCKET_MS
    return "archive", HISTORY_ARCHIVE_BUCKET_MS


def _compact_history_samples(
    samples: Any,
    *,
    reference_ts_ms: int,
) -> list[dict[str, Any]]:
    """Retain the newest row per age-tier bucket through the 400-day horizon."""
    normalized = _normalize_history_samples(samples)
    reference = int(reference_ts_ms)
    cutoff = reference - HISTORY_RETENTION_MS
    newest_by_bucket: dict[tuple[str, int], dict[str, Any]] = {}

    for sample in normalized:
        sample_ts = int(sample["ts_ms"])
        if sample_ts < cutoff or sample_ts > reference:
            continue
        tier, bucket_ms = _history_bucket_for_age(reference - sample_ts)
        bucket_key = (tier, sample_ts // bucket_ms)
        prior = newest_by_bucket.get(bucket_key)
        if prior is None or sample_ts >= int(prior["ts_ms"]):
            newest_by_bucket[bucket_key] = sample

    compacted = sorted(newest_by_bucket.values(), key=lambda row: int(row["ts_ms"]))
    if len(compacted) > HISTORY_MAX_SAMPLES:
        compacted = compacted[-HISTORY_MAX_SAMPLES:]
    return compacted


def _build_history_doc(samples: Any) -> dict[str, Any]:
    return {
        "version": SKEW_HISTORY_VERSION,
        "formula": SKEW_FORMULA,
        "tenors": list(HISTORY_TENORS),
        "primary_tenor_preference": [PRIMARY_TENOR, PRIMARY_FALLBACK_TENOR, "3m"],
        "retention_ms": HISTORY_RETENTION_MS,
        "compaction": {
            "within_48h_ms": HISTORY_FINE_BUCKET_MS,
            "within_30d_ms": HISTORY_MID_BUCKET_MS,
            "within_400d_ms": HISTORY_ARCHIVE_BUCKET_MS,
        },
        "samples": _normalize_history_samples(samples),
    }


def _load_history(path: Path) -> dict[str, Any]:
    if not path.exists():
        return _build_history_doc([])
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _build_history_doc([])
    if not isinstance(payload, dict):
        return _build_history_doc([])
    samples = _normalize_history_samples(payload.get("samples"))
    if samples:
        samples = _compact_history_samples(
            samples,
            reference_ts_ms=max(int(row["ts_ms"]) for row in samples),
        )
    return _build_history_doc(samples)


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def chain_points_from_rows(
    rows: Iterable[Mapping[str, Any]],
    *,
    as_of_ms: int,
    default_spot: float | None = None,
) -> list[ChainPoint]:
    """Test helper: build chain points from plain dict rows."""
    synthetic: dict[str, GreekSnapshot] = {}
    for row in rows:
        name = str(row["instrument_name"])
        spot = float(row.get("spot_price") or default_spot or 0.0)
        synthetic[name] = GreekSnapshot(
            instrument_name=name,
            gamma=float(row.get("gamma") or 0.0),
            spot_price=spot,
            snapshot_ts=int(row.get("snapshot_ts") or as_of_ms),
            open_interest=_maybe_float(row.get("open_interest")),
            mark_iv=_maybe_float(row.get("mark_iv")),
            delta=_maybe_float(row.get("delta")),
        )
    return build_chain_points(synthetic, as_of_ms=as_of_ms)


def _maybe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None
