"""Parkinson high-low realized volatility.

Parkinson (1980) estimates the variance of a bar from its high and low:

    sigma^2 = (1 / (4 N ln 2)) * sum(ln(H_i / L_i)^2)

The result is the variance of one bar. Annualized volatility multiplies by the
number of bars in a year. This book uses hourly BTC-PERPETUAL bars and
sqrt(24 * 365), the same year-count the close-to-close estimator used.

Equal high and low is a real zero-range bar and stays in the sum. A bar with
a non-positive price or a high below the low stays in the series as a hole:
any window that contains it is skipped rather than shortened.
"""

from __future__ import annotations

import math
from typing import Sequence

LN2 = math.log(2.0)
PERIODS_PER_YEAR = 24.0 * 365.0
PARKINSON_BARS_30D = 720
PARKINSON_BARS_7D = 168
PARKINSON_BARS_1D = 24


def parkinson_variance(highs: Sequence[float], lows: Sequence[float]) -> float | None:
    """Per-bar Parkinson variance. None when the window is empty or invalid."""
    if len(highs) != len(lows) or len(highs) < 2:
        return None
    total = 0.0
    for high, low in zip(highs, lows):
        if not _valid_range(high, low):
            return None
        if high == low:
            continue
        log_range = math.log(high / low)
        total += log_range * log_range
    return total / (4.0 * len(highs) * LN2)


def parkinson_vol_percent(
    highs: Sequence[float],
    lows: Sequence[float],
    *,
    periods_per_year: float = PERIODS_PER_YEAR,
) -> float | None:
    """Annualized Parkinson volatility in percent."""
    variance = parkinson_variance(highs, lows)
    if variance is None or variance < 0 or periods_per_year <= 0:
        return None
    annualized = math.sqrt(variance * periods_per_year) * 100.0
    if not math.isfinite(annualized) or annualized < 0:
        return None
    return annualized


def rolling_parkinson_series(
    candles: Sequence[object],
    *,
    lookback_bars: int,
    periods_per_year: float = PERIODS_PER_YEAR,
    as_of_ms: int | None = None,
) -> list[dict[str, float | int]]:
    """Parkinson vol (%) at each bar that completes a full lookback window.

    A window that contains an invalid range is omitted. The bad bar keeps its
    place, so the next window is not filled with an older bar.
    """
    bars = _series_with_holes(candles)
    if as_of_ms is not None:
        bars = [bar for bar in bars if bar[0] + 3_600_000 <= as_of_ms]
    if lookback_bars < 2 or len(bars) < lookback_bars:
        return []
    out: list[dict[str, float | int]] = []
    for end in range(lookback_bars - 1, len(bars)):
        window = bars[end - lookback_bars + 1 : end + 1]
        if any(b[0]-a[0] != 3_600_000 for a,b in zip(window,window[1:])):
            continue
        highs = [bar[1] for bar in window]
        lows = [bar[2] for bar in window]
        vol = parkinson_vol_percent(highs, lows, periods_per_year=periods_per_year)
        if vol is None:
            continue
        # Availability is bar close, not bar open (prevents lookahead joins).
        out.append({"ts_ms": bars[end][0] + 3_600_000, "value": round(vol, 4)})
    return out


def parse_ranges(candles: Sequence[object]) -> list[tuple[int, float, float]]:
    """Valid ``(ts_ms, high, low)`` rows only.

    Invalid ranges are omitted here. ``rolling_parkinson_series`` keeps those
    rows as holes so a bad bar cannot be replaced by an older one.

    Accepted shapes:

    - ``(ts, high, low)``
    - ``(ts, high, low, close)``
    - ``(ts, open, high, low, close)``
    - mapping with ``high`` and ``low`` and ``ts_ms`` or ``timestamp``
    """
    out: list[tuple[int, float, float]] = []
    for row in candles:
        parsed = _parse_one(row)
        if parsed is None:
            continue
        out.append(parsed)
    out.sort(key=lambda item: item[0])
    return out


def _series_with_holes(candles: Sequence[object]) -> list[tuple[int, float, float]]:
    """Candles in time order. Invalid ranges stay as NaN holes."""
    bars: list[tuple[int, float, float]] = []
    for row in candles:
        slot = _candle_slot(row)
        if slot is not None:
            bars.append(slot)
    bars.sort(key=lambda item: item[0])
    by_time: dict[int, tuple[int,float,float]] = {}
    for bar in bars:
        # Ambiguous duplicate bars invalidate their slot; don't count it twice.
        by_time[bar[0]] = (bar[0],float("nan"),float("nan")) if bar[0] in by_time else bar
    bars = list(by_time.values())
    return bars


def _candle_slot(row: object) -> tuple[int, float, float] | None:
    parsed = _extract_high_low(row)
    if parsed is None:
        return None
    ts_ms, high, low = parsed
    if ts_ms <= 0:
        return None
    if not _valid_range(high, low):
        return ts_ms, float("nan"), float("nan")
    return ts_ms, high, low


def _parse_one(row: object) -> tuple[int, float, float] | None:
    parsed = _extract_high_low(row)
    if parsed is None:
        return None
    ts_ms, high, low = parsed
    if ts_ms <= 0 or not _valid_range(high, low):
        return None
    return ts_ms, high, low


def _extract_high_low(row: object) -> tuple[int, float, float] | None:
    try:
        if isinstance(row, dict):
            ts_ms = int(row.get("ts_ms") or row.get("timestamp") or 0)
            high = float(row["high"])
            low = float(row["low"])
        elif isinstance(row, (list, tuple)):
            if len(row) == 3:
                ts_ms, high, low = int(row[0]), float(row[1]), float(row[2])
            elif len(row) == 4:
                ts_ms, high, low = int(row[0]), float(row[1]), float(row[2])
            elif len(row) >= 5:
                ts_ms, high, low = int(row[0]), float(row[2]), float(row[3])
            else:
                return None
        else:
            return None
    except (TypeError, ValueError, KeyError, IndexError):
        try:
            ts = int((row.get("ts_ms") or row.get("timestamp") or 0) if isinstance(row,dict) else row[0])
            return ts, float("nan"), float("nan")
        except (TypeError,ValueError,KeyError,IndexError):
            return None
    return ts_ms, high, low


def _valid_range(high: float, low: float) -> bool:
    return (
        math.isfinite(high)
        and math.isfinite(low)
        and high > 0
        and low > 0
        and high >= low
    )
