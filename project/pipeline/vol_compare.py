"""DVOL vs realized-vol compare series for Regime secondary (replaces 25Δ skew slot).

Units
-----
All series values are **percent** annualized vol (e.g. 37.2), matching
``book_stats.dvol`` and ``book_stats.rv_short`` / ``rv_long``.

Sources
-------
- DVOL: Deribit ``public/get_volatility_index_data`` (BTC, candle close)
- RV: Hyperliquid BTC 1h closes — rolling 7d (168 × 1h returns) sample stdev
  annualized with ``sqrt(24 * 365)``, same definition as Regime RV Trend long window
- spread_t = DVOL_t − RV_t on DVOL timestamps (as-of aligned)

Resilience is the caller's job (cache last good / empty payload). This module is
pure series math + payload shaping.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

VOL_COMPARE_VERSION = "vol_compare.v1"
VOL_COMPARE_PAYLOAD_KEY = "vol_compare"

# Default chart window; 30d optional when caller fetches a longer DVOL range.
DEFAULT_WINDOW = "7d"
WINDOW_MS: dict[str, int] = {
    "7d": 7 * 86_400_000,
    "30d": 30 * 86_400_000,
}

# Matches repository._compute_rv_trend_from_closes long window.
RV_LOOKBACK_RETURNS = 168  # 7 × 24 hourly bars
PERIODS_PER_YEAR = 24.0 * 365.0
UNITS = "percent"

DVOL_SOURCE = (
    "deribit public/get_volatility_index_data "
    "currency=BTC resolution=3600 close (percent)"
)
RV_SOURCE = (
    "hyperliquid BTC 1h closes; rolling 7d annualized sample stdev "
    f"* sqrt({int(PERIODS_PER_YEAR)}) * 100 (percent)"
)
SPREAD_DEFINITION = "DVOL − RV (percent points)"


def empty_vol_compare_payload(
    *,
    as_of_ms: int = 0,
    window: str = DEFAULT_WINDOW,
    error: str | None = None,
) -> dict[str, Any]:
    """Honest empty shape for FE '—' rendering."""
    return build_vol_compare_payload(
        dvol_series=[],
        rv_series=[],
        spread_series=[],
        as_of_ms=as_of_ms,
        window=window,
        error=error,
    )


def build_vol_compare_payload(
    *,
    dvol_series: Sequence[Mapping[str, Any]],
    rv_series: Sequence[Mapping[str, Any]],
    spread_series: Sequence[Mapping[str, Any]],
    as_of_ms: int = 0,
    window: str = DEFAULT_WINDOW,
    resolution_s: int = 3600,
    error: str | None = None,
    dvol_source: str = DVOL_SOURCE,
    rv_source: str = RV_SOURCE,
) -> dict[str, Any]:
    """Shape for ``flow_regime.vol_compare`` (or terminal sibling)."""
    dvol = _clean_series(dvol_series)
    rv = _clean_series(rv_series)
    spread = _clean_series(spread_series)
    payload: dict[str, Any] = {
        "version": VOL_COMPARE_VERSION,
        "dvol_series": dvol,
        "rv_series": rv,
        "spread_series": spread,
        "meta": {
            "as_of_ms": int(as_of_ms) if as_of_ms else 0,
            "window": window if window in WINDOW_MS else DEFAULT_WINDOW,
            "windows_available": list(WINDOW_MS.keys()),
            "units": UNITS,
            "dvol_source": dvol_source,
            "rv_source": rv_source,
            "spread_definition": SPREAD_DEFINITION,
            "rv_lookback_returns": RV_LOOKBACK_RETURNS,
            "resolution_s": int(resolution_s),
            "show_rv_default": True,
            "show_spread_default": True,
            "dvol_point_count": len(dvol),
            "rv_point_count": len(rv),
            "spread_point_count": len(spread),
        },
    }
    if error:
        payload["meta"]["error"] = str(error)[:240]
        payload["error"] = str(error)[:240]
    return payload


def parse_dvol_candles(raw_rows: Sequence[Any]) -> list[dict[str, float | int]]:
    """Parse Deribit volatility-index candles → ``[{ts_ms, value}]`` in percent.

    Candle row: ``[timestamp_ms, open, high, low, close]``.
    Live API returns percent levels (e.g. 37.2); docs occasionally show decimal
    fractions — values in (0, 5] are treated as decimal and scaled ×100.
    """
    out: list[dict[str, float | int]] = []
    for row in raw_rows:
        try:
            if isinstance(row, (list, tuple)) and len(row) >= 5:
                ts_ms = int(row[0])
                close = float(row[4])
            elif isinstance(row, Mapping):
                ts_ms = int(row.get("ts_ms") or row.get("timestamp") or 0)
                close = float(row.get("close") if row.get("close") is not None else row.get("value"))
            else:
                continue
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        if ts_ms <= 0 or not math.isfinite(close) or close <= 0:
            continue
        value = _normalize_vol_percent(close)
        if value is None:
            continue
        out.append({"ts_ms": ts_ms, "value": value})
    out.sort(key=lambda p: int(p["ts_ms"]))
    return out


def rolling_rv_series_from_closes(
    candles: Sequence[tuple[int, float]],
    *,
    lookback_returns: int = RV_LOOKBACK_RETURNS,
) -> list[dict[str, float | int]]:
    """Annualized rolling RV (%) at each candle timestamp with enough history.

    ``candles``: ``(ts_ms, close)`` sorted ascending, 1h bars preferred.
    Annualization matches Regime RV Trend: sample stdev × √(24×365) × 100.
    """
    cleaned: list[tuple[int, float]] = []
    for ts_ms, close in candles:
        try:
            t = int(ts_ms)
            c = float(close)
        except (TypeError, ValueError):
            continue
        if t <= 0 or not math.isfinite(c) or c <= 0:
            continue
        cleaned.append((t, c))
    cleaned.sort(key=lambda p: p[0])
    if len(cleaned) < lookback_returns + 1:
        return []

    log_returns: list[float] = []
    for i in range(1, len(cleaned)):
        prev_c = cleaned[i - 1][1]
        cur_c = cleaned[i][1]
        if prev_c <= 0 or cur_c <= 0:
            log_returns.append(float("nan"))
        else:
            log_returns.append(math.log(cur_c / prev_c))

    out: list[dict[str, float | int]] = []
    # return index i corresponds to candle cleaned[i+1]
    for end_ret in range(lookback_returns - 1, len(log_returns)):
        window = log_returns[end_ret - lookback_returns + 1 : end_ret + 1]
        if any(not math.isfinite(r) for r in window):
            continue
        rv = _sample_stdev(window) * math.sqrt(PERIODS_PER_YEAR) * 100.0
        if not math.isfinite(rv) or rv <= 0:
            continue
        candle_idx = end_ret + 1
        out.append({"ts_ms": cleaned[candle_idx][0], "value": round(rv, 4)})
    return out


def align_series_asof(
    target_ts: Sequence[int],
    source: Sequence[Mapping[str, Any]],
    *,
    max_lag_ms: int = 3_600_000,
) -> list[dict[str, float | int]]:
    """As-of join: for each target ts, last source point with ts ≤ target.

    Points with lag > ``max_lag_ms`` are dropped (default 1h for hourly series).
    """
    src = _clean_series(source)
    if not target_ts or not src:
        return []

    out: list[dict[str, float | int]] = []
    j = 0
    n = len(src)
    for raw_t in target_ts:
        t = int(raw_t)
        while j + 1 < n and int(src[j + 1]["ts_ms"]) <= t:
            j += 1
        src_t = int(src[j]["ts_ms"])
        if src_t > t:
            continue
        if t - src_t > max_lag_ms:
            continue
        out.append({"ts_ms": t, "value": float(src[j]["value"])})
    return out


def compute_spread_series(
    dvol_series: Sequence[Mapping[str, Any]],
    rv_series: Sequence[Mapping[str, Any]],
) -> list[dict[str, float | int]]:
    """spread = DVOL − RV on shared timestamps (exact ts match after alignment)."""
    dvol = {int(p["ts_ms"]): float(p["value"]) for p in _clean_series(dvol_series)}
    rv = {int(p["ts_ms"]): float(p["value"]) for p in _clean_series(rv_series)}
    out: list[dict[str, float | int]] = []
    for ts in sorted(set(dvol) & set(rv)):
        spread = dvol[ts] - rv[ts]
        if math.isfinite(spread):
            out.append({"ts_ms": ts, "value": round(spread, 4)})
    return out


def assemble_vol_compare(
    *,
    dvol_raw_candles: Sequence[Any],
    hl_candles: Sequence[tuple[int, float]],
    as_of_ms: int,
    window: str = DEFAULT_WINDOW,
    window_start_ms: int | None = None,
) -> dict[str, Any]:
    """End-to-end pure assembly from raw DVOL candles + HL (ts, close) pairs."""
    dvol_all = parse_dvol_candles(dvol_raw_candles)
    if window_start_ms is not None:
        dvol = [p for p in dvol_all if int(p["ts_ms"]) >= int(window_start_ms)]
    else:
        dvol = dvol_all

    rv_full = rolling_rv_series_from_closes(hl_candles)
    target_ts = [int(p["ts_ms"]) for p in dvol]
    rv_aligned = align_series_asof(target_ts, rv_full)
    spread = compute_spread_series(dvol, rv_aligned)

    return build_vol_compare_payload(
        dvol_series=dvol,
        rv_series=rv_aligned,
        spread_series=spread,
        as_of_ms=as_of_ms,
        window=window if window in WINDOW_MS else DEFAULT_WINDOW,
    )


# ── internals ────────────────────────────────────────────────────────────────


def _normalize_vol_percent(value: float) -> float | None:
    if not math.isfinite(value) or value <= 0:
        return None
    # Live Deribit history/index are percent; decimal fractions scale up.
    if value <= 5.0:
        value = value * 100.0
    if not math.isfinite(value) or value <= 0 or value > 500.0:
        return None
    return round(float(value), 4)


def _clean_series(series: Sequence[Mapping[str, Any]]) -> list[dict[str, float | int]]:
    out: list[dict[str, float | int]] = []
    for p in series:
        try:
            ts = int(p.get("ts_ms", 0))  # type: ignore[arg-type]
            value = float(p.get("value"))  # type: ignore[arg-type]
        except (TypeError, ValueError, AttributeError):
            continue
        if ts <= 0 or not math.isfinite(value):
            continue
        out.append({"ts_ms": ts, "value": value})
    out.sort(key=lambda row: int(row["ts_ms"]))
    return out


def _sample_stdev(values: Sequence[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    variance = sum((v - mean) ** 2 for v in values) / (n - 1)
    return math.sqrt(max(variance, 0.0))
