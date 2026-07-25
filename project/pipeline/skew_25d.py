"""25Δ normalized skew for Regime secondary (replaces Velocity UI series).

Definition::

    25Δ Skew Normalized = (IV_25Δ_put − IV_25Δ_call) / ATM_IV

- Positive → puts richer than calls (put skew)
- Negative → calls richer than puts (call skew)

IV points come from the live Greeks map (mark_iv). Absolute delta is taken from
the ticker when present, otherwise Black–Scholes (r=q=0) using mark_iv.

25Δ / ATM IVs are linear-interpolated in |Δ|-space on the chosen expiry.
Tenors: 1W (7d), 1M (30d), 3M (90d); 6M (180d) optional when chain allows.

Primary chart series is 1M, falling back to 1W when 1M is unavailable.
History is a timed ring buffer (same general pattern as gex_window_history).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from greeks.types import GreekSnapshot
from normalizer.instruments import parse_deribit_option_instrument_name

SKEW_HISTORY_VERSION = "skew_25d_history.v1"
SKEW_HISTORY_FILENAME = "skew_25d_history.json"
SKEW_FORMULA = "(IV_25d_put - IV_25d_call) / ATM_IV"
SKEW_PAYLOAD_KEY = "skew_25d"

# Timed ring — aligned with gex_window_history retention defaults.
HISTORY_RETENTION_MS = 26 * 3600 * 1000
HISTORY_MAX_SAMPLES = 900

# Tenor targets (calendar days to expiry).
TENOR_TARGET_DAYS: dict[str, float] = {
    "1w": 7.0,
    "1m": 30.0,
    "3m": 90.0,
    "6m": 180.0,
}
LEVEL_TENORS: tuple[str, ...] = ("1w", "1m", "3m")
OPTIONAL_TENORS: tuple[str, ...] = ("6m",)
PRIMARY_TENOR = "1m"
PRIMARY_FALLBACK_TENOR = "1w"

TARGET_25D = 0.25
ATM_DELTA = 0.50
# Nearest-|Δ| fallback when no bracket exists around the target.
DELTA_NEAREST_TOL = 0.08
# Ignore near-zero residual life (unstable IV/Δ).
MIN_DTE_DAYS = 0.35
# mark_iv > this → treat as percent (Deribit public ticker convention).
IV_PERCENT_THRESHOLD = 3.0

MS_PER_DAY = 86_400_000.0


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
        t_ms = expiry_ts_ms - int(as_of_ms)
        if t_ms < MIN_DTE_DAYS * MS_PER_DAY:
            continue
        t_years = t_ms / (MS_PER_DAY * 365.0)
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
    """Pick expiry whose DTE is closest to ``target_days`` (strictly future)."""
    expiries = {p.expiry_ts_ms for p in points}
    best: int | None = None
    best_dist: float | None = None
    for expiry_ts in expiries:
        dte = (int(expiry_ts) - int(as_of_ms)) / MS_PER_DAY
        if dte < MIN_DTE_DAYS:
            continue
        dist = abs(dte - target_days)
        if best_dist is None or dist < best_dist:
            best = int(expiry_ts)
            best_dist = dist
    return best


def select_front_expiry(
    points: Sequence[ChainPoint],
    *,
    as_of_ms: int,
) -> int | None:
    """Nearest listed expiry with DTE ≥ MIN_DTE (BTC VIX1D-style front).

    Unlike ``select_expiry_for_tenor(..., target_days=7)``, this does **not**
    prefer ~7d — it takes the minimum valid residual life on the chain.
    """
    best: int | None = None
    best_dte: float | None = None
    for expiry_ts in {p.expiry_ts_ms for p in points}:
        dte = (int(expiry_ts) - int(as_of_ms)) / MS_PER_DAY
        if dte < MIN_DTE_DAYS:
            continue
        if best_dte is None or dte < best_dte:
            best = int(expiry_ts)
            best_dte = dte
    return best


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

    Also computes **front** ATM IV on the nearest listed expiry with DTE ≥ MIN_DTE
    (display-only term-structure leg; not used by Environment / Dealer Γ).
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
                "dte_days": (expiry - int(as_of_ms)) / MS_PER_DAY,
            }
            continue
        levels[tenor] = float(computed["value"])
        detail[tenor] = {
            "status": "ok",
            "dte_days": (expiry - int(as_of_ms)) / MS_PER_DAY,
            **computed,
        }

    # Front leg for term structure: nearest expiry ≥ MIN_DTE (not ~7d tenor match).
    front_expiry = select_front_expiry(points, as_of_ms=as_of_ms)
    front: dict[str, Any]
    if front_expiry is None:
        front = {"status": "no_expiry"}
    else:
        dte_days = (front_expiry - int(as_of_ms)) / MS_PER_DAY
        atm_computed = compute_atm_for_expiry(points, expiry_ts_ms=front_expiry)
        if atm_computed is None:
            front = {
                "status": "insufficient_smile",
                "expiry_ts_ms": front_expiry,
                "dte_days": dte_days,
            }
        else:
            front = {
                "status": "ok",
                "dte_days": dte_days,
                **atm_computed,
            }

    return {
        "levels": levels,
        "detail": detail,
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


def append_skew_history_sample(
    artifacts_dir: str | Path,
    *,
    ts_ms: int,
    value: float,
    tenor: str,
) -> dict[str, Any]:
    """Append primary-tenor skew sample and prune retention. Returns history doc."""
    path = history_path(artifacts_dir)
    doc = _load_history(path)
    sample = {
        "ts_ms": int(ts_ms),
        "value": float(value),
        "tenor": str(tenor),
    }
    samples = list(doc.get("samples") or [])
    # Replace last sample if same ~5s window (rapid re-materialize).
    if samples and abs(int(samples[-1].get("ts_ms", 0)) - int(ts_ms)) < 5_000:
        samples[-1] = sample
    else:
        samples.append(sample)

    cutoff = int(ts_ms) - HISTORY_RETENTION_MS
    samples = [s for s in samples if int(s.get("ts_ms", 0)) >= cutoff]
    if len(samples) > HISTORY_MAX_SAMPLES:
        samples = samples[-HISTORY_MAX_SAMPLES:]

    out = {
        "version": SKEW_HISTORY_VERSION,
        "formula": SKEW_FORMULA,
        "primary_tenor_preference": [PRIMARY_TENOR, PRIMARY_FALLBACK_TENOR, "3m"],
        "samples": samples,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_json_atomic(path, out)
    return out


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
    front: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Shape for ``flow_regime.skew_25d`` (levels + primary series + front ATM + meta)."""
    series_raw = list((history_doc or {}).get("samples") or [])
    series: list[dict[str, Any]] = []
    for sample in series_raw:
        try:
            ts = int(sample.get("ts_ms", 0))
            value = float(sample.get("value"))
        except (TypeError, ValueError):
            continue
        if ts <= 0 or not math.isfinite(value):
            continue
        series.append({"ts_ms": ts, "value": value})

    level_out = {
        key: (float(levels[key]) if levels.get(key) is not None and math.isfinite(float(levels[key])) else None)
        for key in (*LEVEL_TENORS, *OPTIONAL_TENORS)
        if key in levels or key in LEVEL_TENORS
    }
    # Always expose 1w/1m/3m keys for the FE.
    for key in LEVEL_TENORS:
        level_out.setdefault(key, None)

    front_out = dict(front or {"status": "no_expiry"})

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
            **(
                {"6m": level_out["6m"]}
                if "6m" in level_out and level_out.get("6m") is not None
                else {}
            ),
        },
        # Display-only term front leg (nearest expiry ≥ MIN_DTE). Not scored.
        "front": front_out,
        "series": series,
        "meta": {
            "as_of_ms": int(as_of_ms),
            "atm_definition": (
                "mean of call/put IV linearly interpolated at |Δ|=0.50; "
                "fallback to strike-nearest call/put mid IV"
            ),
            "delta_interpolation": "linear in |delta|-space to 0.25; nearest within 0.08 if unbracketed",
            "delta_source_preference": "ticker delta when present, else BS |Δ| from mark_iv (r=q=0)",
            "iv_unit": "decimal vol (Deribit mark_iv percent / 100 when needed)",
            "front_definition": (
                f"ATM IV on nearest listed expiry with DTE ≥ {MIN_DTE_DAYS:g}d "
                "(minimum residual life; not closest-to-7d)"
            ),
            "primary_tenor_preference": [PRIMARY_TENOR, PRIMARY_FALLBACK_TENOR, "3m"],
            "chart_tenor": primary_tenor,
            "chain_point_count": int(chain_point_count),
            "history_sample_count": len(series),
            "detail": dict(detail or {}),
        },
    }


def empty_skew_25d_payload(*, as_of_ms: int = 0) -> dict[str, Any]:
    return build_skew_25d_payload(
        as_of_ms=as_of_ms,
        levels={"1w": None, "1m": None, "3m": None},
        history_doc={"samples": []},
        primary_tenor=None,
        chain_point_count=0,
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
    primary_tenor, primary_value = resolve_primary_tenor(levels)

    history_doc: dict[str, Any]
    if primary_tenor is not None and primary_value is not None:
        history_doc = append_skew_history_sample(
            artifacts_dir,
            ts_ms=as_of_ms,
            value=primary_value,
            tenor=primary_tenor,
        )
    else:
        history_doc = load_skew_history_doc(artifacts_dir)

    return build_skew_25d_payload(
        as_of_ms=as_of_ms,
        levels=levels,
        history_doc=history_doc,
        primary_tenor=primary_tenor,
        chain_point_count=int(computed.get("chain_point_count") or 0),
        detail=computed.get("detail"),
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


def _load_history(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": SKEW_HISTORY_VERSION, "samples": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": SKEW_HISTORY_VERSION, "samples": []}
    if not isinstance(payload, dict):
        return {"version": SKEW_HISTORY_VERSION, "samples": []}
    samples = payload.get("samples")
    if not isinstance(samples, list):
        payload["samples"] = []
    return payload


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
