"""Versioned desk-surface payload and the history used to read its changes."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

from greeks.types import GreekSnapshot

from vol_surface.surface import (
    FLAT_BAND_VOL_POINTS,
    SurfaceQuote,
    build_slices,
    classify_divergence,
    listed_metrics,
    quotes_from_greeks,
    term_structure,
    TERM_TENORS,
)

SURFACE_VERSION = "desk_vol_surface.v2"
HISTORY_VERSION = "desk_vol_surface_history.v2"
HISTORY_FILENAME = "vol_surface_history_v2.json"
HEADLINE_TENOR = "30d"
DAY_MS = 86_400_000
HOUR_MS = 3_600_000


def empty_vol_surface_payload(*, as_of_ms: int, note: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "version": SURFACE_VERSION,
        "as_of_ms": int(as_of_ms),
        "smile_model": "tv_pchip",
        "day_count": "ACT/365",
        "settlement": "08:00 UTC",
        "forward_source": "ticker_underlying_price",
        "delta_model": "black76_forward_delta",
        "skew_sign": "put_iv_minus_call_iv",
        "body_delta": 0.25,
        "tail_delta": 0.10,
        "validation_scope": "numerical_checks_on_supported_strikes",
        "implied_move_definition": "ATM log-volatility scale about forward; not a probability interval",
        "flat_band_vol_points": FLAT_BAND_VOL_POINTS,
        "listed_expiries": [],
        "term_structure": [{"tenor":name,"target_days":days,"status":"unavailable",
                            "calendar_ok":None,"validation_reasons":[note or "no_quotes"]}
                           for name,days in TERM_TENORS],
        "history": {},
        "atm_vs_rv": _atm_vs_rv(None, None),
        "divergence": {
            "tenor": HEADLINE_TENOR,
            "state": "baseline",
            "window": None,
            "rr_25_change_vol_points": None,
            "rr_10_change_vol_points": None,
        },
    }
    if note:
        payload["note"] = note
    return payload


def build_vol_surface_payload(
    quotes: Sequence[SurfaceQuote],
    *,
    as_of_ms: int,
    history: Sequence[Mapping[str, Any]] | None = None,
    rv_30d_percent: float | None = None,
) -> dict[str, Any]:
    slices = build_slices(quotes, as_of_ms=as_of_ms)
    if not slices:
        return empty_vol_surface_payload(as_of_ms=as_of_ms, note="no_fittable_expiry")

    listed = listed_metrics(slices, as_of_ms=as_of_ms)
    tenors = term_structure(slices)
    prior = [dict(row) for row in (history or ()) if int(row.get("ts_ms") or 0) < as_of_ms]
    _stamp_divergence(tenors, prior, as_of_ms=as_of_ms)
    headline = next((row for row in tenors if row.get("tenor") == HEADLINE_TENOR), None)
    atm_30 = _finite(headline.get("atm_iv_percent")) if headline and headline.get("status") == "ok" else None
    divergence = headline.get("divergence") if headline else None
    if not isinstance(divergence, dict):
        divergence = {
            "tenor": HEADLINE_TENOR,
            "state": "baseline",
            "window": None,
            "rr_25_change_vol_points": None,
            "rr_10_change_vol_points": None,
        }
    return {
        "version": SURFACE_VERSION,
        "as_of_ms": int(as_of_ms),
        "smile_model": "tv_pchip",
        "day_count": "ACT/365",
        "settlement": "08:00 UTC",
        "forward_source": "ticker_underlying_price",
        "delta_model": "black76_forward_delta",
        "skew_sign": "put_iv_minus_call_iv",
        "body_delta": 0.25,
        "tail_delta": 0.10,
        "validation_scope": "numerical_checks_on_supported_strikes",
        "implied_move_definition": "ATM log-volatility scale about forward; not a probability interval",
        "flat_band_vol_points": FLAT_BAND_VOL_POINTS,
        "slice_count": len(slices),
        "listed_expiries": listed,
        "term_structure": tenors,
        "history": {},
        "atm_vs_rv": _atm_vs_rv(atm_30, rv_30d_percent),
        "divergence": divergence,
    }


def build_and_persist_vol_surface(
    artifacts_root: str | Path,
    *,
    as_of_ms: int,
    greeks: Mapping[str, GreekSnapshot],
    rv_30d_percent: float | None = None,
) -> dict[str, Any]:
    """Build the surface from the live greek map and remember it for the next read."""
    root = Path(artifacts_root)
    history = _load_history(root)
    payload = build_vol_surface_payload(
        quotes_from_greeks(greeks, as_of_ms=as_of_ms),
        as_of_ms=as_of_ms,
        history=history,
        rv_30d_percent=rv_30d_percent,
    )
    _append_history(root, payload, prior=history)
    current = _history_row(payload)
    payload["history"] = history_series(_compact(history + ([current] if current else []), now_ms=as_of_ms))
    payload["quote_count"] = len(greeks)
    payload["accepted_quote_count"] = len(quotes_from_greeks(greeks, as_of_ms=as_of_ms))
    return payload


def attach_parkinson_rv(payload: Mapping[str, Any], rv_30d_percent: float | None,
                       *, rv_as_of_ms: int | None = None) -> dict[str, Any]:
    """Fill the 30-day ATM versus Parkinson comparison on a built surface."""
    updated = dict(payload)
    headline = None
    tenors = updated.get("term_structure")
    if isinstance(tenors, list):
        headline = next(
            (row for row in tenors if isinstance(row, dict) and row.get("tenor") == HEADLINE_TENOR),
            None,
        )
    atm = _finite(headline.get("atm_iv_percent")) if isinstance(headline, dict) and headline.get("status") == "ok" else None
    if rv_as_of_ms is not None and abs(int(updated.get("as_of_ms") or 0)-rv_as_of_ms) > 2*HOUR_MS:
        rv_30d_percent = None
    updated["atm_vs_rv"] = _atm_vs_rv(atm, rv_30d_percent)
    updated["atm_vs_rv"]["rv_as_of_ms"] = rv_as_of_ms
    return updated


def attach_atm_rv(payload: Mapping[str, Any], rv_series: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Join independent ATM to a completed RV bar, never to a future observation."""
    stamp = int(payload.get("as_of_ms") or 0)
    eligible = [p for p in rv_series if 0 <= stamp-int(p["ts_ms"]) <= HOUR_MS and _finite(p.get("value")) is not None]
    realized = max(eligible, key=lambda p:p["ts_ms"], default=None)
    row = next((r for r in payload.get("term_structure", []) if r.get("tenor") == "30d"), {})
    atm = _finite(row.get("atm_iv_percent")) if row.get("status") == "ok" and row.get("calendar_ok") is not False else None
    compared = _atm_vs_rv(atm, _finite(realized["value"]) if realized else None)
    compared["rv_as_of_ms"] = realized["ts_ms"] if realized else None
    return {**payload, "atm_vs_rv": compared}


def _atm_vs_rv(atm_iv_percent: float | None, rv_percent: float | None) -> dict[str, Any]:
    spread = None
    if atm_iv_percent is not None and rv_percent is not None:
        spread = atm_iv_percent - rv_percent
    return {
        "tenor_days": 30,
        "atm_iv_percent": atm_iv_percent,
        "rv_percent": rv_percent,
        "spread_percent": spread,
        "iv_definition": "30d constant-maturity ATM IV, total-variance interpolated",
        "rv_estimator": "parkinson",
        "rv_window": "30d",
        "rv_bar": "1h",
        "rv_bars": 720,
        "rv_source": "deribit BTC-PERPETUAL high-low",
    }


def _stamp_divergence(
    tenors: list[dict[str, object]],
    history: Sequence[Mapping[str, Any]],
    *,
    as_of_ms: int,
) -> None:
    reference, window = _reference_row(history, as_of_ms=as_of_ms)
    for row in tenors:
        tenor = str(row.get("tenor") or "")
        current_25 = _finite(row.get("rr_25_vol_points"))
        current_10 = _finite(row.get("rr_10_vol_points"))
        previous_25 = _history_value(reference, "rr_25", tenor)
        previous_10 = _history_value(reference, "rr_10", tenor)
        change_25 = None if current_25 is None or previous_25 is None else current_25 - previous_25
        change_10 = None if current_10 is None or previous_10 is None else current_10 - previous_10
        row["divergence"] = {
            "tenor": tenor,
            "state": classify_divergence(change_25, change_10),
            "window": window if change_25 is not None and change_10 is not None else None,
            "rr_25_change_vol_points": change_25,
            "rr_10_change_vol_points": change_10,
        }


def _reference_row(
    history: Sequence[Mapping[str, Any]],
    *,
    as_of_ms: int,
) -> tuple[Mapping[str, Any] | None, str | None]:
    target = as_of_ms - DAY_MS
    day = [
        row
        for row in history
        if abs(int(row.get("ts_ms") or 0) - target) <= 6 * HOUR_MS
        and int(row.get("ts_ms") or 0) <= as_of_ms - 20 * HOUR_MS
    ]
    if day:
        return min(day, key=lambda row: abs(int(row["ts_ms"]) - target)), "24h"
    older = [row for row in history if int(row.get("ts_ms") or 0) <= as_of_ms - 15 * 60 * 1000]
    if older:
        return max(older, key=lambda row: int(row["ts_ms"])), "previous"
    return None, None


def _history_value(row: Mapping[str, Any] | None, field: str, tenor: str) -> float | None:
    if row is None:
        return None
    bucket = row.get(field)
    if not isinstance(bucket, dict):
        return None
    return _finite(bucket.get(tenor))


def _append_history(root: Path, payload: Mapping[str, Any], *, prior: list[dict[str, Any]]) -> None:
    row = _history_row(payload)
    if row is None:
        return
    rows = [item for item in prior if int(item.get("ts_ms") or 0) != row["ts_ms"]]
    rows.append(row)
    rows.sort(key=lambda item: int(item["ts_ms"]))
    document = {
        "version": HISTORY_VERSION,
        "samples": _compact(rows, now_ms=int(payload["as_of_ms"])),
    }
    path = root / HISTORY_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    temp.replace(path)


def _history_row(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    tenors = payload.get("term_structure")
    if not isinstance(tenors, list):
        return None
    atm: dict[str, float] = {}
    rr_25: dict[str, float] = {}
    rr_10: dict[str, float] = {}
    for row in tenors:
        if not isinstance(row, dict) or row.get("status") != "ok":
            continue
        tenor = str(row.get("tenor") or "")
        if not tenor:
            continue
        atm_iv = _finite(row.get("atm_iv_percent"))
        body = _finite(row.get("rr_25_vol_points"))
        tail = _finite(row.get("rr_10_vol_points"))
        if atm_iv is not None:
            atm[tenor] = atm_iv
        if body is not None:
            rr_25[tenor] = body
        if tail is not None:
            rr_10[tenor] = tail
    if not atm and not rr_25:
        return None
    return {"ts_ms": int(payload["as_of_ms"]), "atm": atm, "rr_25": rr_25, "rr_10": rr_10}


def _load_history(root: Path) -> list[dict[str, Any]]:
    path = root / HISTORY_FILENAME
    if not path.exists():
        return []
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    samples = document.get("samples") if isinstance(document, dict) else None
    if not isinstance(document,dict) or document.get("version") != HISTORY_VERSION:
        return []
    if not isinstance(samples, list):
        return []
    return [row for row in samples if isinstance(row, dict) and row.get("ts_ms")]


def _compact(rows: Sequence[Mapping[str, Any]], *, now_ms: int) -> list[dict[str, Any]]:
    """Keep every print for two days, then thin the older book."""
    fine_cut = now_ms - 2 * DAY_MS
    mid_cut = now_ms - 30 * DAY_MS
    retain_cut = now_ms - 400 * DAY_MS
    fine: list[dict[str, Any]] = []
    buckets: dict[tuple[str, int], dict[str, Any]] = {}
    unique = {int(row.get("ts_ms") or 0): row for row in rows}
    for _, source in sorted(unique.items()):
        row = dict(source)
        ts = int(row.get("ts_ms") or 0)
        if ts < retain_cut:
            continue
        if ts >= fine_cut:
            fine.append(row)
            continue
        if ts >= mid_cut:
            buckets[("m", ts // (30 * 60 * 1000))] = row
        else:
            buckets[("a", ts // (6 * HOUR_MS))] = row
    merged = fine + list(buckets.values())
    merged.sort(key=lambda item: int(item["ts_ms"]))
    return merged[-4096:]


def _finite(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def history_series(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, list[dict[str, float | int]]]]:
    """Only v2 gated samples; never mix in the old marks/legacy histories."""
    result = {name: {} for name in ("atm", "skew_25", "skew_10", "tail_gap")}
    for row in rows:
        ts = int(row["ts_ms"])
        for tenor, atm in (row.get("atm") or {}).items():
            result["atm"].setdefault(tenor,[]).append({"ts_ms":ts,"value":atm})
            body = (row.get("rr_25") or {}).get(tenor)
            tail = (row.get("rr_10") or {}).get(tenor)
            if atm > 0 and body is not None:
                result["skew_25"].setdefault(tenor,[]).append({"ts_ms":ts,"value":body/atm})
            if atm > 0 and tail is not None:
                result["skew_10"].setdefault(tenor,[]).append({"ts_ms":ts,"value":tail/atm})
            if body is not None and tail is not None:
                result["tail_gap"].setdefault(tenor,[]).append({"ts_ms":ts,"value":tail-body})
    return result
