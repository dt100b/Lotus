"""Signed cumulative flow inventory — secondary Regime analytics.

Modes (Velocity / Horizon / Active Strikes) are derived **only** from the
taker-flow dealer book. They do **not** alter core inventory, GEX formula,
Levels, or the main Regime Dealer Γ polarity path.

Cumulative window Δ (1h / 4h / 24h summary)::

    ΔGEX(window) = GEX_now − GEX_at_(now − window)

Fixed 1h period Δ history (Velocity bars, last ~24 complete UTC hours)::

    Δ_period[h] = NetGEX(end of hour h) − NetGEX(start of hour h)

where both sides are strike-aggregated signed net GEX from the production
flow book (blocks/combos excluded). Edge samples use nearest history point
within a 20-minute tolerance.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo

from pipeline.skew_25d import empty_skew_25d_payload

FLOW_REGIME_VERSION = "flow_regime.v1"
HISTORY_VERSION = "gex_window_history.v1"
HISTORY_FILENAME = "gex_window_history.json"

# Velocity windows (seconds)
VELOCITY_WINDOWS_S: dict[str, int] = {
    "1h": 3600,
    "4h": 4 * 3600,
    "24h": 24 * 3600,
}

# How far a history sample may miss the target timestamp and still count.
_WINDOW_TOLERANCE_S: dict[str, int] = {
    "1h": 20 * 60,
    "4h": 45 * 60,
    "24h": 2 * 3600,
}

# Fixed 1h period-Δ history (Velocity bars): last N complete UTC hours.
PERIOD_DELTA_HOURS = 24
PERIOD_BUCKET_MS = 3600 * 1000
# Edge lookup tolerance matches the 1h cumulative window (20 min).
PERIOD_EDGE_TOLERANCE_MS = _WINDOW_TOLERANCE_S["1h"] * 1000

NEAR_SPOT_PCT = 2.5  # Velocity near-spot band (legacy; unused by period bars)
ACTIVE_STRIKE_BAND_PCT = 10.0  # Active Strikes preferred distance from spot
ACTIVE_STRIKE_TOP_N = 8
SPARKLINE_POINTS = 48
HISTORY_RETENTION_MS = 26 * 3600 * 1000
HISTORY_MAX_SAMPLES = 900
EPSILON = 1.0  # floor for relative magnitude
AGREEMENT_THRESHOLD = 0.12  # matches Regime mild Dealer Γ band
NY_TZ = ZoneInfo("America/New_York")
NY_OPEN_HOUR = 8
NY_OPEN_MINUTE = 0


def history_path(artifacts_dir: str | Path) -> Path:
    return Path(artifacts_dir) / HISTORY_FILENAME


def ny_session_anchor_ms(as_of_ms: int) -> int:
    """Return today's 08:00 America/New_York as UTC epoch ms (DST-aware).

    "Today" is the America/New_York calendar day of ``as_of_ms``. If as-of is
    before 08:00 NY, the anchor is still that calendar day's 08:00 (future relative
    to as-of) — callers should treat session inventory as empty in that case.
    """
    as_of = datetime.fromtimestamp(as_of_ms / 1000.0, tz=UTC)
    local = as_of.astimezone(NY_TZ)
    anchor_local = local.replace(
        hour=NY_OPEN_HOUR,
        minute=NY_OPEN_MINUTE,
        second=0,
        microsecond=0,
    )
    return int(anchor_local.timestamp() * 1000)


def dealer_gamma_score(net_gex: float, by_strike: Mapping[float, float] | Iterable[float]) -> float:
    """full_score / session_score = NetGEX / Σ|netGEX| clipped to [-1, 1]."""
    if isinstance(by_strike, Mapping):
        values = list(by_strike.values())
    else:
        values = list(by_strike)
    total_abs = sum(abs(v) for v in values if math.isfinite(v))
    if not (total_abs > 0) or not math.isfinite(net_gex):
        return 0.0
    return max(-1.0, min(1.0, net_gex / total_abs))


def agreement_label(full_score: float, session_score: float) -> str:
    """Aligned / Fighting / Mixed from full vs session polarity scores."""
    if not math.isfinite(full_score) or not math.isfinite(session_score):
        return "Mixed"
    same_sign = (full_score > 0 and session_score > 0) or (full_score < 0 and session_score < 0)
    both_strong = abs(full_score) > AGREEMENT_THRESHOLD and abs(session_score) > AGREEMENT_THRESHOLD
    if same_sign and both_strong:
        return "Aligned"
    opposite = (full_score > 0 and session_score < 0) or (full_score < 0 and session_score > 0)
    if opposite and abs(full_score) > 1e-9 and abs(session_score) > 1e-9:
        return "Fighting"
    return "Mixed"


def agreement_read(full_score: float, session_score: float, agreement: str) -> str | None:
    if agreement != "Fighting":
        return None
    if full_score < 0 and session_score > 0:
        return "Session long while full book short"
    if full_score > 0 and session_score < 0:
        return "Session short while full book long"
    return "Full vs session polarity diverge"


def strike_gex_map_from_profile_rows(
    by_strike: Iterable[Any],
) -> dict[float, float]:
    """Accept StrikeProfileRow objects or dicts with strike/net_gex."""
    out: dict[float, float] = {}
    for row in by_strike:
        if hasattr(row, "strike") and hasattr(row, "net_gex"):
            strike = float(row.strike)
            net = float(row.net_gex)
        else:
            strike = float(row["strike"])
            net = float(row["net_gex"])
        if math.isfinite(strike) and math.isfinite(net):
            out[strike] = out.get(strike, 0.0) + net
    return out


def append_history_sample(
    artifacts_dir: str | Path,
    *,
    ts_ms: int,
    spot: float,
    net_gex: float,
    by_strike: Mapping[float, float],
) -> dict[str, Any]:
    """Append a compact GEX sample and prune retention. Returns the history doc."""
    path = history_path(artifacts_dir)
    doc = _load_history(path)
    sample = {
        "ts_ms": int(ts_ms),
        "spot": float(spot) if math.isfinite(spot) else 0.0,
        "net_gex": float(net_gex) if math.isfinite(net_gex) else 0.0,
        "by_strike": {
            _strike_key(k): float(v)
            for k, v in by_strike.items()
            if math.isfinite(float(v)) and abs(float(v)) > 0.0
        },
    }
    samples = list(doc.get("samples") or [])
    # Replace last sample if same second (rapid re-materialize) to avoid dupes.
    if samples and abs(int(samples[-1].get("ts_ms", 0)) - int(ts_ms)) < 5_000:
        samples[-1] = sample
    else:
        samples.append(sample)

    cutoff = int(ts_ms) - HISTORY_RETENTION_MS
    samples = [s for s in samples if int(s.get("ts_ms", 0)) >= cutoff]
    if len(samples) > HISTORY_MAX_SAMPLES:
        samples = samples[-HISTORY_MAX_SAMPLES:]

    # Preserve provenance from real backfill (or other non-sample keys) so live
    # append does not erase the source-of-truth marker.
    preserved = {
        key: value
        for key, value in doc.items()
        if key
        not in {
            "version",
            "delta_definition",
            "methodology",
            "samples",
            "seed",  # drop deprecated synthetic seed marker on next live write
        }
    }
    out = {
        "version": HISTORY_VERSION,
        "delta_definition": "GEX_now - GEX_at_(now - window)",
        "methodology": "signed cumulative flow inventory; production ledger (blocks/combos excluded)",
        **preserved,
        "samples": samples,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_json_atomic(path, out)
    return out


def build_flow_regime_payload(
    *,
    as_of_ms: int,
    spot: float,
    net_gex_now: float,
    by_strike_now: Mapping[float, float],
    history_doc: Mapping[str, Any] | None,
    session_by_strike: Mapping[float, float] | None,
    session_available: bool,
    session_anchor_ms: int | None,
    full_score: float | None = None,
    session_status: str | None = None,
    session_reason: str | None = None,
) -> dict[str, Any]:
    """Precompute Velocity / Horizon / Active Strikes for the terminal snapshot."""
    samples = list((history_doc or {}).get("samples") or [])
    score_full = (
        float(full_score)
        if full_score is not None and math.isfinite(full_score)
        else dealer_gamma_score(net_gex_now, by_strike_now)
    )

    velocity = _build_velocity(
        as_of_ms=as_of_ms,
        spot=spot,
        net_gex_now=net_gex_now,
        by_strike_now=by_strike_now,
        samples=samples,
    )
    horizon = _build_horizon(
        full_score=score_full,
        session_by_strike=session_by_strike,
        session_available=session_available,
        session_anchor_ms=session_anchor_ms,
        session_status=session_status,
        session_reason=session_reason,
    )
    active = _build_active_strikes(
        as_of_ms=as_of_ms,
        spot=spot,
        by_strike_now=by_strike_now,
        samples=samples,
    )

    return {
        "version": FLOW_REGIME_VERSION,
        "as_of_ms": int(as_of_ms),
        "spot": float(spot) if math.isfinite(spot) else None,
        "delta_gex_definition": "GEX_now - GEX_at_(now - window)",
        "history_sample_count": len(samples),
        "velocity": velocity,
        "horizon": horizon,
        "active_strikes": active,
        # Skew is attached by dashboard materialize (needs live greeks). Placeholder
        # keeps payload shape stable when callers build flow_regime without greeks.
        "skew_25d": empty_skew_25d_payload(as_of_ms=int(as_of_ms)),
    }


def empty_flow_regime_payload(*, as_of_ms: int = 0, spot: float | None = None) -> dict[str, Any]:
    """Clean missing-data shape so the API/FE can always render '—'."""
    return {
        "version": FLOW_REGIME_VERSION,
        "as_of_ms": int(as_of_ms),
        "spot": float(spot) if spot is not None and math.isfinite(spot) else None,
        "delta_gex_definition": "GEX_now - GEX_at_(now - window)",
        "history_sample_count": 0,
        "velocity": {
            "windows": {
                key: _empty_velocity_window() for key in VELOCITY_WINDOWS_S
            },
            # Fixed 1h period Δ bars: NetGEX(end) − NetGEX(start) per UTC hour.
            "period_deltas": [],
            "sparkline_24h": [],
        },
        "horizon": {
            "full_score": None,
            "session_score": None,
            "session_net_gex": None,
            "agreement": None,
            "read": None,
            "session_available": False,
            "session_anchor_ts_ms": None,
            "session_status": "unavailable",
            "session_reason": "flow_regime payload missing or failed to build",
        },
        "active_strikes": {
            "primary_window": "4h",
            "windows": {
                "4h": {"window": "4h", "strikes": []},
                "24h": {"window": "24h", "strikes": []},
            },
        },
        "skew_25d": empty_skew_25d_payload(as_of_ms=int(as_of_ms)),
    }


# ── internal builders ────────────────────────────────────────────────────────


def _empty_velocity_window() -> dict[str, Any]:
    return {
        "delta_net_gex": None,
        "rel": None,
        "near_spot_delta_net_gex": None,
        "near_spot_rel": None,
        "sample_age_s": None,
    }


def _build_velocity(
    *,
    as_of_ms: int,
    spot: float,
    net_gex_now: float,
    by_strike_now: Mapping[float, float],
    samples: list[dict[str, Any]],
) -> dict[str, Any]:
    denom = max(abs(net_gex_now), EPSILON) if math.isfinite(net_gex_now) else EPSILON
    windows: dict[str, Any] = {}
    for key, seconds in VELOCITY_WINDOWS_S.items():
        target_ms = int(as_of_ms) - seconds * 1000
        past = _nearest_sample(samples, target_ms, _WINDOW_TOLERANCE_S[key] * 1000)
        if past is None:
            windows[key] = _empty_velocity_window()
            continue
        past_net = float(past.get("net_gex", 0.0))
        delta = net_gex_now - past_net
        past_strikes = _parse_by_strike(past.get("by_strike") or {})
        near_now = _sum_near_spot(by_strike_now, spot, NEAR_SPOT_PCT)
        near_past = _sum_near_spot(past_strikes, spot, NEAR_SPOT_PCT)
        near_delta = near_now - near_past
        near_denom = max(abs(near_now), EPSILON)
        age_s = abs(int(as_of_ms) - int(past.get("ts_ms", as_of_ms))) / 1000.0
        windows[key] = {
            "delta_net_gex": delta,
            "rel": delta / denom,
            "near_spot_delta_net_gex": near_delta,
            "near_spot_rel": near_delta / near_denom,
            "sample_age_s": age_s,
        }

    period_deltas = _build_period_deltas(samples, as_of_ms)
    # Keep sparkline empty for payload shape compat; FE uses period_deltas now.
    return {
        "windows": windows,
        "period_deltas": period_deltas,
        "sparkline_24h": [],
    }


def _build_period_deltas(
    samples: list[dict[str, Any]],
    as_of_ms: int,
) -> list[dict[str, Any]]:
    """Fixed 1h period ΔGEX bars over the last ~24 complete UTC hours.

    Definition (per bar)::

        Δ = NetGEX(end of hour) − NetGEX(start of hour)

    Bucket edges align to UTC hour boundaries. The rightmost complete hour ends
    at ``floor(as_of_ms / 1h) * 1h``. Each edge uses the nearest history sample
    within ``PERIOD_EDGE_TOLERANCE_MS`` (20 min); missing edges yield null Δ.

    Always returns ``PERIOD_DELTA_HOURS`` buckets when ``as_of_ms`` is valid so
    the FE can render a stable grid (null bars until history warms).
    """
    if as_of_ms <= 0:
        return []

    # Right edge of the latest *complete* UTC hour at or before as_of.
    end_of_latest = (int(as_of_ms) // PERIOD_BUCKET_MS) * PERIOD_BUCKET_MS
    if end_of_latest <= 0:
        return []

    out: list[dict[str, Any]] = []
    # Oldest → newest: 24 complete hours ending at end_of_latest.
    for i in range(PERIOD_DELTA_HOURS, 0, -1):
        start_ms = end_of_latest - i * PERIOD_BUCKET_MS
        end_ms = end_of_latest - (i - 1) * PERIOD_BUCKET_MS
        start_sample = _nearest_sample(samples, start_ms, PERIOD_EDGE_TOLERANCE_MS)
        end_sample = _nearest_sample(samples, end_ms, PERIOD_EDGE_TOLERANCE_MS)
        if start_sample is None or end_sample is None:
            out.append(
                {
                    "start_ts_ms": start_ms,
                    "end_ts_ms": end_ms,
                    "delta_net_gex": None,
                    "start_net_gex": None,
                    "end_net_gex": None,
                }
            )
            continue
        start_net = float(start_sample.get("net_gex", 0.0))
        end_net = float(end_sample.get("net_gex", 0.0))
        if not math.isfinite(start_net) or not math.isfinite(end_net):
            out.append(
                {
                    "start_ts_ms": start_ms,
                    "end_ts_ms": end_ms,
                    "delta_net_gex": None,
                    "start_net_gex": None,
                    "end_net_gex": None,
                }
            )
            continue
        out.append(
            {
                "start_ts_ms": start_ms,
                "end_ts_ms": end_ms,
                "delta_net_gex": end_net - start_net,
                "start_net_gex": start_net,
                "end_net_gex": end_net,
            }
        )
    return out


def _build_horizon(
    *,
    full_score: float,
    session_by_strike: Mapping[float, float] | None,
    session_available: bool,
    session_anchor_ms: int | None,
    session_status: str | None = None,
    session_reason: str | None = None,
) -> dict[str, Any]:
    """Horizon polarity: full-book score vs NY-session (08:00 America/New_York) score.

    ``session_status`` values:
      ok | empty | pre_open | unavailable | error
    """
    base = {
        "full_score": full_score if math.isfinite(full_score) else None,
        "session_score": None,
        "session_net_gex": None,
        "agreement": None,
        "read": None,
        "session_available": False,
        "session_anchor_ts_ms": session_anchor_ms,
        "session_status": session_status or "unavailable",
        "session_reason": session_reason,
    }

    if not session_available or session_by_strike is None:
        if session_status is None:
            base["session_status"] = "error" if session_reason else "unavailable"
        return base

    session_net = sum(session_by_strike.values())
    session_score = dealer_gamma_score(session_net, session_by_strike)
    # Empty session book (no eligible trades) → scores null, not forced 0.
    # Preserve caller status when pre_open (before 08:00 NY) or an explicit reason.
    if not session_by_strike or all(abs(v) < 1e-12 for v in session_by_strike.values()):
        empty_status = session_status if session_status in {"pre_open", "empty"} else "empty"
        empty_reason = session_reason or (
            "Before 08:00 America/New_York — session book not open"
            if empty_status == "pre_open"
            else "No production-eligible trades since 08:00 America/New_York"
        )
        base.update(
            {
                "session_net_gex": 0.0,
                "session_available": True,
                "session_status": empty_status,
                "session_reason": empty_reason,
            }
        )
        return base

    agreement = agreement_label(full_score, session_score)
    return {
        "full_score": full_score if math.isfinite(full_score) else None,
        "session_score": session_score,
        "session_net_gex": session_net,
        "agreement": agreement,
        "read": agreement_read(full_score, session_score, agreement),
        "session_available": True,
        "session_anchor_ts_ms": session_anchor_ms,
        "session_status": "ok",
        "session_reason": None,
    }


def _build_active_strikes(
    *,
    as_of_ms: int,
    spot: float,
    by_strike_now: Mapping[float, float],
    samples: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "primary_window": "4h",
        "windows": {
            "4h": _rank_active_strikes(
                as_of_ms=as_of_ms,
                spot=spot,
                by_strike_now=by_strike_now,
                samples=samples,
                window_key="4h",
            ),
            "24h": _rank_active_strikes(
                as_of_ms=as_of_ms,
                spot=spot,
                by_strike_now=by_strike_now,
                samples=samples,
                window_key="24h",
            ),
        },
    }


def _rank_active_strikes(
    *,
    as_of_ms: int,
    spot: float,
    by_strike_now: Mapping[float, float],
    samples: list[dict[str, Any]],
    window_key: str,
) -> dict[str, Any]:
    seconds = VELOCITY_WINDOWS_S[window_key]
    target_ms = int(as_of_ms) - seconds * 1000
    past = _nearest_sample(samples, target_ms, _WINDOW_TOLERANCE_S[window_key] * 1000)
    if past is None or not (math.isfinite(spot) and spot > 0):
        return {"window": window_key, "strikes": [], "sample_age_s": None}

    past_strikes = _parse_by_strike(past.get("by_strike") or {})
    all_strikes = set(by_strike_now.keys()) | set(past_strikes.keys())
    deltas: list[dict[str, Any]] = []
    for strike in all_strikes:
        delta = float(by_strike_now.get(strike, 0.0)) - float(past_strikes.get(strike, 0.0))
        if not math.isfinite(delta) or abs(delta) < 1e-9:
            continue
        dist_pct = ((strike - spot) / spot) * 100.0
        deltas.append(
            {
                "strike": float(strike),
                "delta_gex": delta,
                "dist_pct": dist_pct,
            }
        )

    # Prefer tape-relevant strikes (±10%); fall back to full book if thin.
    near = [d for d in deltas if abs(d["dist_pct"]) <= ACTIVE_STRIKE_BAND_PCT]
    pool = near if len(near) >= 4 else deltas
    pool.sort(key=lambda d: abs(d["delta_gex"]), reverse=True)
    top = pool[:ACTIVE_STRIKE_TOP_N]
    total_abs = sum(abs(d["delta_gex"]) for d in top) or 1.0
    ranked = []
    for index, row in enumerate(top, start=1):
        ranked.append(
            {
                "rank": index,
                "strike": row["strike"],
                "delta_gex": row["delta_gex"],
                "share": abs(row["delta_gex"]) / total_abs,
                "dist_pct": row["dist_pct"],
            }
        )
    age_s = abs(int(as_of_ms) - int(past.get("ts_ms", as_of_ms))) / 1000.0
    return {"window": window_key, "strikes": ranked, "sample_age_s": age_s}


def _nearest_sample(
    samples: list[dict[str, Any]],
    target_ms: int,
    tolerance_ms: int,
) -> dict[str, Any] | None:
    if not samples:
        return None
    best: dict[str, Any] | None = None
    best_dist = None
    for sample in samples:
        ts = int(sample.get("ts_ms", 0))
        dist = abs(ts - target_ms)
        if dist > tolerance_ms:
            continue
        if best_dist is None or dist < best_dist:
            best = sample
            best_dist = dist
    return best


def _sum_near_spot(by_strike: Mapping[float, float], spot: float, pct: float) -> float:
    if not (math.isfinite(spot) and spot > 0):
        return 0.0
    lo = spot * (1.0 - pct / 100.0)
    hi = spot * (1.0 + pct / 100.0)
    return sum(v for k, v in by_strike.items() if lo <= k <= hi and math.isfinite(v))


def _downsample_sparkline(
    samples: list[dict[str, Any]],
    as_of_ms: int,
    window_ms: int,
) -> list[dict[str, Any]]:
    cutoff = int(as_of_ms) - int(window_ms)
    series = [
        {"ts_ms": int(s["ts_ms"]), "net_gex": float(s.get("net_gex", 0.0))}
        for s in samples
        if int(s.get("ts_ms", 0)) >= cutoff
    ]
    if len(series) <= SPARKLINE_POINTS:
        return series
    # Even index pick so the sparkline stays cheap for the FE.
    step = (len(series) - 1) / (SPARKLINE_POINTS - 1)
    out: list[dict[str, Any]] = []
    for i in range(SPARKLINE_POINTS):
        idx = int(round(i * step))
        out.append(series[min(idx, len(series) - 1)])
    return out


def _parse_by_strike(raw: Mapping[Any, Any] | list[Any]) -> dict[float, float]:
    out: dict[float, float] = {}
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                out[float(item[0])] = float(item[1])
            elif isinstance(item, dict):
                out[float(item["strike"])] = float(item["net_gex"])
        return out
    for key, value in raw.items():
        try:
            out[float(key)] = float(value)
        except (TypeError, ValueError):
            continue
    return out


def _strike_key(strike: float) -> str:
    # Stable JSON key; avoid long floats when strike is integer-valued.
    if float(strike).is_integer():
        return str(int(strike))
    return str(float(strike))


def _load_history(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": HISTORY_VERSION, "samples": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": HISTORY_VERSION, "samples": []}
    if not isinstance(payload, dict):
        return {"version": HISTORY_VERSION, "samples": []}
    samples = payload.get("samples")
    if not isinstance(samples, list):
        payload["samples"] = []
    return payload


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def load_history_doc(artifacts_dir: str | Path) -> dict[str, Any]:
    return _load_history(history_path(artifacts_dir))
