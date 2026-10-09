"""DVOL vs realized-vol compare series for Regime secondary (replaces 25Δ skew slot).

Units
-----
All series values are **percent** annualized vol (e.g. 37.2), matching
``book_stats.dvol`` and ``book_stats.rv_short`` / ``rv_long``.

Sources
-------
- DVOL: Deribit ``public/get_volatility_index_data`` (BTC, candle close) — ~30d IV index
- Primary RV: Deribit BTC-PERPETUAL 1h high/low — rolling **30d** Parkinson
  (720 bars) annualized with ``sqrt(24 * 365)``
- RV1 / RV7: the same Parkinson estimator on 24 / 168 hourly bars
- spread_t = DVOL_t − Parkinson RV30_t on DVOL timestamps (as-of aligned)

The close-to-close helper remains for tests that still want it. The assembled
payload uses Parkinson only.

Resilience is the caller's job (cache last good / empty payload). This module is
pure series math + payload shaping.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

from vol_surface.parkinson import rolling_parkinson_series

VOL_COMPARE_VERSION = "vol_compare.v1"
VOL_COMPARE_PAYLOAD_KEY = "vol_compare"

# Default chart window: 365d history for DVOL / IV–RV / VRP series.
# RV definition stays matched ~30d (RV30); only the plotted range is longer.
DEFAULT_WINDOW = "365d"
WINDOW_MS: dict[str, int] = {
    "7d": 7 * 86_400_000,
    "30d": 30 * 86_400_000,
    "90d": 90 * 86_400_000,
    "180d": 180 * 86_400_000,
    "365d": 365 * 86_400_000,
}

# Primary: 30d Parkinson RV matched to DVOL maturity (~30d index).
# 720 hourly bars ≈ 30 × 24 hours.
RV30_LOOKBACK_RETURNS = 720
# Short / weekly RV history — not used for primary spread / IV rich-cheap chip.
RV1_LOOKBACK_RETURNS = 24  # 1 × 24 hourly bars
RV7_LOOKBACK_RETURNS = 168  # 7 × 24 hourly bars
# Backward-compatible alias (historical name pointed at 7d).
RV_LOOKBACK_RETURNS = RV30_LOOKBACK_RETURNS
PERIODS_PER_YEAR = 24.0 * 365.0
UNITS = "percent"
RV_ESTIMATOR = "parkinson"

DVOL_SOURCE = (
    "deribit public/get_volatility_index_data "
    "currency=BTC resolution=3600 close (percent) · ~30d IV index (DVOL)"
)
RV30_SOURCE = (
    "deribit BTC-PERPETUAL 1h high-low; Parkinson RV 30d (720 bars) "
    f"* sqrt({int(PERIODS_PER_YEAR)}) * 100 (percent) · primary matched-tenor series"
)
RV7_SOURCE = (
    "deribit BTC-PERPETUAL 1h high-low; Parkinson RV 7d (168 bars) "
    f"* sqrt({int(PERIODS_PER_YEAR)}) * 100 (percent) · secondary overlay only"
)
RV1_SOURCE = (
    "deribit BTC-PERPETUAL 1h high-low; Parkinson RV 24h (24 bars) "
    f"* sqrt({int(PERIODS_PER_YEAR)}) * 100 (percent) · RV trend short leg"
)
# Legacy alias used by older callers / meta fallbacks.
RV_SOURCE = RV30_SOURCE
SPREAD_DEFINITION = "DVOL − Parkinson RV30 (percent points) · matched ~30d tenors"


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
    rv_source: str = RV30_SOURCE,
    rv1_series: Sequence[Mapping[str, Any]] | None = None,
    rv1_source: str = RV1_SOURCE,
    rv7_series: Sequence[Mapping[str, Any]] | None = None,
    rv7_source: str = RV7_SOURCE,
) -> dict[str, Any]:
    """Shape for ``flow_regime.vol_compare`` (or terminal sibling).

    Primary ``rv_series`` / ``spread_series`` are DVOL vs **RV30**.
    Optional ``rv1_series`` / ``rv7_series`` power the 24H / 7D trend view only.
    """
    dvol = _clean_series(dvol_series)
    rv = _clean_series(rv_series)
    spread = _clean_series(spread_series)
    rv1 = _clean_series(rv1_series) if rv1_series is not None else []
    rv7 = _clean_series(rv7_series) if rv7_series is not None else []
    payload: dict[str, Any] = {
        "version": VOL_COMPARE_VERSION,
        "dvol_series": dvol,
        # Primary matched-tenor series (RV30).
        "rv_series": rv,
        "spread_series": spread,
        "meta": {
            "as_of_ms": int(as_of_ms) if as_of_ms else 0,
            "window": window if window in WINDOW_MS else DEFAULT_WINDOW,
            "windows_available": list(WINDOW_MS.keys()),
            "units": UNITS,
            "dvol_source": dvol_source,
            "rv_source": rv_source,
            "rv30_source": RV30_SOURCE,
            "rv1_source": rv1_source,
            "rv7_source": rv7_source,
            "spread_definition": SPREAD_DEFINITION,
            "primary_pair": "DVOL (30d) vs Parkinson RV30",
            "rv_estimator": RV_ESTIMATOR,
            "rv_timestamp": "completed_bar_close",
            "rv_coverage": "unique_contiguous_hourly_windows",
            "rv_lookback_returns": RV30_LOOKBACK_RETURNS,
            "rv30_lookback_returns": RV30_LOOKBACK_RETURNS,
            "rv1_lookback_returns": RV1_LOOKBACK_RETURNS,
            "rv7_lookback_returns": RV7_LOOKBACK_RETURNS,
            "resolution_s": int(resolution_s),
            "show_rv_default": True,
            "show_spread_default": True,
            "dvol_point_count": len(dvol),
            "rv_point_count": len(rv),
            "rv1_point_count": len(rv1),
            "rv7_point_count": len(rv7),
            "spread_point_count": len(spread),
            # Display title for Regime chart header.
            "chart_title": "IV vs RV",
            "history_window": window if window in WINDOW_MS else DEFAULT_WINDOW,
        },
    }
    if rv1_series is not None:
        payload["rv1_series"] = rv1
    # Optional secondary 7d RV overlay (does not drive IV rich/cheap).
    if rv7_series is not None:
        payload["rv7_series"] = rv7
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
    lookback_returns: int = RV30_LOOKBACK_RETURNS,
) -> list[dict[str, float | int]]:
    """Annualized rolling RV (%) at each candle timestamp with enough history.

    ``candles``: ``(ts_ms, close)`` sorted ascending, 1h bars preferred.
    Annualization matches Regime RV Trend: sample stdev × √(24×365) × 100.
    Default lookback is **720** returns (RV30); pass 168 for RV7 overlay.
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
    hl_candles: Sequence[object],
    rv30_candles: Sequence[object] | None = None,
    as_of_ms: int,
    window: str = DEFAULT_WINDOW,
    window_start_ms: int | None = None,
    include_rv7: bool = True,
    include_rv1: bool = True,
) -> dict[str, Any]:
    """End-to-end assembly from raw DVOL candles and OHLC bars.

    Primary pair: DVOL vs Parkinson RV30 (720 hourly high-low bars).
    ``rv30_candles`` can provide a deeper matched-venue history while
    ``hl_candles`` powers the 24H / 7D view. RV30 falls back to ``hl_candles``
    when no separate series is supplied. Each candle must carry a high and a
    low; a close-only pair cannot be turned into a Parkinson estimate.
    """
    dvol_all = parse_dvol_candles(dvol_raw_candles)
    if window_start_ms is not None:
        dvol = [p for p in dvol_all if int(p["ts_ms"]) >= int(window_start_ms)]
    else:
        dvol = dvol_all

    target_ts = [int(p["ts_ms"]) for p in dvol]

    # Primary: matched 30d Parkinson RV.
    rv30_input = rv30_candles if rv30_candles is not None else hl_candles
    rv30_full = rolling_parkinson_series(rv30_input, lookback_bars=RV30_LOOKBACK_RETURNS, as_of_ms=as_of_ms)
    rv30_aligned = align_series_asof(target_ts, rv30_full)
    spread = compute_spread_series(dvol, rv30_aligned)

    rv1_aligned: list[dict[str, float | int]] | None = None
    if include_rv1:
        rv1_full = rolling_parkinson_series(hl_candles, lookback_bars=RV1_LOOKBACK_RETURNS, as_of_ms=as_of_ms)
        rv1_aligned = align_series_asof(target_ts, rv1_full)

    rv7_aligned: list[dict[str, float | int]] | None = None
    if include_rv7:
        rv7_full = rolling_parkinson_series(hl_candles, lookback_bars=RV7_LOOKBACK_RETURNS, as_of_ms=as_of_ms)
        rv7_aligned = align_series_asof(target_ts, rv7_full)

    return build_vol_compare_payload(
        dvol_series=dvol,
        rv_series=rv30_aligned,
        spread_series=spread,
        as_of_ms=as_of_ms,
        window=window if window in WINDOW_MS else DEFAULT_WINDOW,
        rv1_series=rv1_aligned,
        rv7_series=rv7_aligned,
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
