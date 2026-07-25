"""Unit tests for DVOL vs RV vol_compare series assembly."""

from __future__ import annotations

import math

from pipeline.vol_compare import (
    align_series_asof,
    assemble_vol_compare,
    build_vol_compare_payload,
    compute_spread_series,
    empty_vol_compare_payload,
    parse_dvol_candles,
    rolling_rv_series_from_closes,
)


def test_parse_dvol_candles_percent_and_decimal() -> None:
    rows = [
        [1_700_000_000_000, 36.0, 37.0, 35.5, 36.5],
        [1_700_003_600_000, 0.40, 0.41, 0.39, 0.405],  # decimal → percent
    ]
    series = parse_dvol_candles(rows)
    assert len(series) == 2
    assert series[0]["value"] == 36.5
    assert abs(float(series[1]["value"]) - 40.5) < 1e-9


def test_rolling_rv_and_align_spread() -> None:
    # Synthetic geometric random walk with enough 1h bars for 7d lookback.
    n = 200
    base_ts = 1_700_000_000_000
    price = 50_000.0
    candles: list[tuple[int, float]] = []
    for i in range(n):
        price *= 1.0 + (0.001 if i % 2 == 0 else -0.0008)
        candles.append((base_ts + i * 3_600_000, price))

    rv = rolling_rv_series_from_closes(candles)
    assert len(rv) > 0
    assert all(p["value"] > 0 for p in rv)

    # DVOL flat near 40% on last 24 candles of the window.
    dvol_raw = [
        [candles[i][0], 40.0, 40.0, 40.0, 40.0]
        for i in range(n - 24, n)
    ]
    payload = assemble_vol_compare(
        dvol_raw_candles=dvol_raw,
        hl_candles=candles,
        as_of_ms=candles[-1][0],
        window="7d",
        window_start_ms=candles[n - 24][0],
    )
    assert payload["meta"]["units"] == "percent"
    assert len(payload["dvol_series"]) == 24
    assert len(payload["rv_series"]) > 0
    assert len(payload["spread_series"]) > 0
    # Spread = 40 - RV; with small moves RV is modest so spread should be positive-ish.
    last_spread = payload["spread_series"][-1]["value"]
    assert math.isfinite(last_spread)


def test_align_series_asof_respects_max_lag() -> None:
    target = [1000, 2000, 5000]
    source = [
        {"ts_ms": 900, "value": 1.0},
        {"ts_ms": 1900, "value": 2.0},
    ]
    aligned = align_series_asof(target, source, max_lag_ms=200)
    assert [p["ts_ms"] for p in aligned] == [1000, 2000]
    assert aligned[0]["value"] == 1.0
    assert aligned[1]["value"] == 2.0
    # 5000 - 1900 = 3100 > 200 → dropped
    assert all(p["ts_ms"] != 5000 for p in aligned)


def test_compute_spread_exact_ts() -> None:
    dvol = [{"ts_ms": 1, "value": 50.0}, {"ts_ms": 2, "value": 40.0}]
    rv = [{"ts_ms": 1, "value": 45.0}, {"ts_ms": 3, "value": 30.0}]
    spread = compute_spread_series(dvol, rv)
    assert len(spread) == 1
    assert spread[0]["ts_ms"] == 1
    assert spread[0]["value"] == 5.0


def test_empty_payload_shape() -> None:
    empty = empty_vol_compare_payload(as_of_ms=123, error="deribit down")
    assert empty["dvol_series"] == []
    assert empty["rv_series"] == []
    assert empty["spread_series"] == []
    assert empty["meta"]["units"] == "percent"
    assert empty["error"] == "deribit down"


def test_build_payload_cleans_bad_points() -> None:
    payload = build_vol_compare_payload(
        dvol_series=[{"ts_ms": 1, "value": 30.0}, {"ts_ms": -1, "value": 1.0}],
        rv_series=[{"ts_ms": 1, "value": float("nan")}],
        spread_series=[],
        as_of_ms=1,
    )
    assert len(payload["dvol_series"]) == 1
    assert payload["rv_series"] == []
