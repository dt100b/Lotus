"""Desk vol surface and Parkinson realized vol."""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime

import pytest

from greeks.types import GreekSnapshot
from vol_surface.parkinson import (
    parkinson_variance,
    parkinson_vol_percent,
    rolling_parkinson_series,
)
from vol_surface.snapshot import (
    attach_parkinson_rv,
    build_and_persist_vol_surface,
    build_vol_surface_payload,
)
from vol_surface.surface import (
    SurfaceQuote,
    classify_divergence,
    quotes_from_greeks,
)

DAY_MS = 86_400_000
HOUR_MS = 3_600_000
AS_OF_MS = 1_780_000_000_000
FORWARD = 100_000.0
WING = (0.60, 0.70, 0.80, 0.90, 0.96, 1.00, 1.04, 1.10, 1.20, 1.30, 1.40)


def _quotes(
    *,
    expiry_ts_ms: int,
    iv_at_k,
    forward: float = FORWARD,
    multiples: tuple[float, ...] = WING,
) -> list[SurfaceQuote]:
    quotes: list[SurfaceQuote] = []
    for multiple in multiples:
        strike = forward * multiple
        k = math.log(strike / forward)
        quotes.append(
            SurfaceQuote(
                underlying="BTC",
                expiry_ts_ms=expiry_ts_ms,
                strike=strike,
                option_type="call" if multiple >= 1.0 else "put",
                mark_iv=float(iv_at_k(k)),
                forward_usd=forward,
                open_interest=1.0,
            )
        )
    return quotes


def _flat(expiry_ts_ms: int, iv: float) -> list[SurfaceQuote]:
    return _quotes(expiry_ts_ms=expiry_ts_ms, iv_at_k=lambda _k: iv)


def _skewed(expiry_ts_ms: int) -> list[SurfaceQuote]:
    return _quotes(expiry_ts_ms=expiry_ts_ms, iv_at_k=lambda k: 0.50 - 1.2 * k)


def _tenor(payload: dict, name: str) -> dict:
    return next(row for row in payload["term_structure"] if row["tenor"] == name)


def test_parkinson_constant_range_matches_closed_form() -> None:
    log_range = 0.01
    highs = [100.0 * math.exp(log_range)] * 48
    lows = [100.0] * 48
    variance = (log_range * log_range) / (4.0 * math.log(2.0))
    expected = math.sqrt(variance * 24.0 * 365.0) * 100.0
    assert parkinson_vol_percent(highs, lows) == pytest.approx(expected)


def test_zero_range_bar_stays_in_the_sum() -> None:
    highs = [110.0] * 10
    lows = [100.0] * 10
    full = parkinson_vol_percent(highs, lows)
    mixed_highs = highs.copy()
    mixed_lows = lows.copy()
    mixed_highs[3] = 100.0
    mixed_lows[3] = 100.0
    mixed = parkinson_vol_percent(mixed_highs, mixed_lows)
    assert full is not None and mixed is not None
    assert mixed < full
    assert parkinson_vol_percent([100.0] * 24, [100.0] * 24) == 0.0
    assert parkinson_variance([101.0, 90.0], [100.0, 100.0]) is None


def test_invalid_bar_skips_the_window_without_shortening_it() -> None:
    bars: list[tuple[int, float, float]] = []
    for index in range(10):
        bars.append((1_700_000_000_000 + index * HOUR_MS, 101.0, 100.0))
    bars[5] = (bars[5][0], 90.0, 100.0)
    series = rolling_parkinson_series(bars, lookback_bars=4)
    published = {point["ts_ms"] for point in series}
    # Windows ending at indexes 5..8 contain the bad bar. Indexes 3, 4, and 9 do not.
    assert published == {bars[3][0]+HOUR_MS, bars[4][0]+HOUR_MS, bars[9][0]+HOUR_MS}
    assert all(point["value"] > 0 for point in series)


def test_close_only_rows_are_not_a_parkinson_window() -> None:
    closes = [(1_700_000_000_000 + index * HOUR_MS, 100.0 + index) for index in range(30)]
    assert rolling_parkinson_series(closes, lookback_bars=24) == []


def test_one_ulp_past_a_wing_stays_on_the_smile() -> None:
    from project.options_surface.types import QueryStatus
    from vol_surface.surface import build_slices

    fitted = build_slices(_flat(AS_OF_MS + 30 * DAY_MS, 0.50), as_of_ms=AS_OF_MS)[0]
    below = math.nextafter(fitted.k_min, -math.inf)
    above = math.nextafter(fitted.k_max, math.inf)
    for slipped in (below, above):
        value, status = fitted.total_variance(slipped)
        assert value is not None and math.isfinite(value)
        assert status is QueryStatus.AVAILABLE
        iv, _iv_status = fitted.iv(slipped)
        assert iv is not None and iv > 0


def test_flat_smile_atm_move_and_zero_skew() -> None:
    expiry = AS_OF_MS + 30 * DAY_MS
    payload = build_vol_surface_payload(_flat(expiry, 0.50), as_of_ms=AS_OF_MS)
    row = _tenor(payload, "30d")
    sigma_move = 0.50 * math.sqrt(30.0 / 365.0)
    up = math.exp(sigma_move) - 1.0
    down = 1.0 - math.exp(-sigma_move)

    assert row["status"] == "ok"
    assert row["method"] == "exact_expiry"
    assert row["calendar_ok"] is True
    assert row["atm_iv"] == pytest.approx(0.50)
    assert row["atm_iv_percent"] == pytest.approx(50.0)
    assert row["rr_25_vol_points"] == pytest.approx(0.0, abs=1e-6)
    assert row["rr_10_vol_points"] == pytest.approx(0.0, abs=1e-6)
    assert row["tail_gap_vol_points"] == pytest.approx(0.0, abs=1e-6)
    assert row["implied_move_1sd_log"] == pytest.approx(sigma_move)
    assert row["implied_move_1sd_up_percent"] == pytest.approx(up * 100.0)
    assert row["implied_move_1sd_down_percent"] == pytest.approx(down * 100.0)
    assert row["implied_move_1sd_up_usd"] == pytest.approx(FORWARD * up)
    assert row["implied_move_1sd_down_usd"] == pytest.approx(FORWARD * down)
    assert payload["smile_model"] == "tv_pchip"
    assert "DVOL" not in payload["atm_vs_rv"]["iv_definition"]
    assert payload["divergence"]["state"] == "baseline"


def test_skewed_smile_tail_richer_than_25_delta() -> None:
    payload = build_vol_surface_payload(
        _skewed(AS_OF_MS + 30 * DAY_MS),
        as_of_ms=AS_OF_MS,
    )
    row = _tenor(payload, "30d")
    assert row["rr_25_vol_points"] > 0
    assert row["rr_10_vol_points"] > row["rr_25_vol_points"]
    assert row["tail_gap_vol_points"] == pytest.approx(
        row["rr_10_vol_points"] - row["rr_25_vol_points"]
    )
    assert row["skew_25_normalized"] > 0


def test_constant_maturity_interpolates_total_variance() -> None:
    quotes = _flat(AS_OF_MS + 7 * DAY_MS, 0.40) + _flat(AS_OF_MS + 90 * DAY_MS, 0.60)
    payload = build_vol_surface_payload(quotes, as_of_ms=AS_OF_MS)
    row = _tenor(payload, "30d")
    t1, t2, target = 7.0 / 365.0, 90.0 / 365.0, 30.0 / 365.0
    weight = (target - t1) / (t2 - t1)
    total_var = (0.40**2) * t1 + weight * ((0.60**2) * t2 - (0.40**2) * t1)
    expected_iv = math.sqrt(total_var / target)

    assert row["status"] == "ok"
    assert row["method"] == "total_variance_interpolation"
    assert row["calendar_ok"] is True
    assert row["atm_iv"] == pytest.approx(expected_iv, rel=1e-6)
    assert row["forward_usd"] == pytest.approx(FORWARD)
    target_60 = 60.0 / 365.0
    weight_60 = (target_60 - t1) / (t2 - t1)
    variance_60 = 0.40**2 * t1 + weight_60 * (0.60**2 * t2 - 0.40**2 * t1)
    sixty = _tenor(payload, "60d")
    assert sixty["status"] == "ok"
    assert sixty["atm_iv"] == pytest.approx(math.sqrt(variance_60 / target_60), rel=1e-6)
    assert _tenor(payload, "1d")["status"] == "unavailable"
    assert _tenor(payload, "1d")["method"] == "extrapolated"
    assert "atm_iv_percent" not in _tenor(payload, "180d")
    assert _tenor(payload, "180d")["method"] == "extrapolated"


def test_calendar_violation_is_flagged_and_withheld() -> None:
    quotes = _flat(AS_OF_MS + 7 * DAY_MS, 0.90) + _flat(AS_OF_MS + 90 * DAY_MS, 0.15)
    payload = build_vol_surface_payload(quotes, as_of_ms=AS_OF_MS)
    row = _tenor(payload, "30d")
    assert row["status"] == "unavailable"
    assert row["calendar_ok"] is False
    assert "atm_iv_percent" not in row


def test_divergence_names() -> None:
    assert classify_divergence(None, 1.0) == "baseline"
    assert classify_divergence(0.1, 1.2) == "tail_acceleration"
    assert classify_divergence(0.5, 0.51) == "tail_acceleration"
    assert classify_divergence(-1.0, -1.2) == "fear_unwinding"
    assert classify_divergence(1.0, 1.2) == "fear_building"
    assert classify_divergence(0.1, -0.1) == "unchanged"
    assert classify_divergence(0.5, 0.5) == "unchanged"
    assert classify_divergence(-1.0, 0.1) == "divergent"


def test_divergence_prefers_the_24h_sample() -> None:
    quotes = _flat(AS_OF_MS + 30 * DAY_MS, 0.50)
    history = [
        {
            "ts_ms": AS_OF_MS - DAY_MS,
            "atm": {"30d": 50.0},
            "rr_25": {"30d": 0.0},
            "rr_10": {"30d": 3.0},
        },
        {
            "ts_ms": AS_OF_MS - 2 * HOUR_MS,
            "atm": {"30d": 50.0},
            "rr_25": {"30d": 10.0},
            "rr_10": {"30d": 10.0},
        },
    ]
    payload = build_vol_surface_payload(quotes, as_of_ms=AS_OF_MS, history=history)
    divergence = payload["divergence"]
    assert divergence["window"] == "24h"
    assert divergence["state"] == "divergent"
    assert divergence["rr_25_change_vol_points"] == pytest.approx(0.0, abs=1e-6)
    assert divergence["rr_10_change_vol_points"] == pytest.approx(-3.0, abs=1e-4)


def test_divergence_previous_sample_and_fresh_print_is_baseline() -> None:
    quotes = _flat(AS_OF_MS + 30 * DAY_MS, 0.50)
    previous = build_vol_surface_payload(
        quotes,
        as_of_ms=AS_OF_MS,
        history=[
            {
                "ts_ms": AS_OF_MS - 2 * HOUR_MS,
                "atm": {"30d": 50.0},
                "rr_25": {"30d": 4.0},
                "rr_10": {"30d": 9.0},
            }
        ],
    )
    assert previous["divergence"]["window"] == "previous"
    assert previous["divergence"]["state"] == "fear_unwinding"

    fresh = build_vol_surface_payload(
        quotes,
        as_of_ms=AS_OF_MS,
        history=[
            {
                "ts_ms": AS_OF_MS - 5 * 60 * 1000,
                "atm": {"30d": 50.0},
                "rr_25": {"30d": 4.0},
                "rr_10": {"30d": 9.0},
            }
        ],
    )
    assert fresh["divergence"]["state"] == "baseline"
    assert fresh["divergence"]["window"] is None


def test_attach_parkinson_rv_does_not_restore_invalid_atm() -> None:
    updated = attach_parkinson_rv(
        {"term_structure": [], "atm_vs_rv": {"atm_iv_percent": 48.0}},
        30.0,
    )
    assert updated["atm_vs_rv"]["atm_iv_percent"] is None
    assert updated["atm_vs_rv"]["rv_percent"] == 30.0
    assert updated["atm_vs_rv"]["spread_percent"] is None
    assert updated["atm_vs_rv"]["rv_estimator"] == "parkinson"
    assert updated["atm_vs_rv"]["rv_bars"] == 720


def test_quotes_from_greeks_use_08_utc_settlement_and_percent_iv() -> None:
    greeks = {
        "BTC-6OCT26-80000-C": GreekSnapshot(
            instrument_name="BTC-6OCT26-80000-C",
            gamma=0.0,
            spot_price=85_000.0,
            snapshot_ts=1,
            mark_iv=46.0,
            open_interest=3.0,
        ),
        "BTC-6OCT26-90000-P": GreekSnapshot(
            instrument_name="BTC-6OCT26-90000-P",
            gamma=0.0,
            spot_price=85_000.0,
            snapshot_ts=1,
            mark_iv=55.0,
            open_interest=1.0,
        ),
        "ETH-6OCT26-3000-C": GreekSnapshot(
            instrument_name="ETH-6OCT26-3000-C",
            gamma=0.0,
            spot_price=3_000.0,
            snapshot_ts=1,
            mark_iv=60.0,
        ),
        "BTC-PERPETUAL": GreekSnapshot(
            instrument_name="BTC-PERPETUAL",
            gamma=0.0,
            spot_price=85_000.0,
            snapshot_ts=1,
            mark_iv=40.0,
        ),
    }
    quotes = quotes_from_greeks(greeks)
    assert {quote.underlying for quote in quotes} == {"BTC"}
    assert len(quotes) == 2
    by_strike = {quote.strike: quote for quote in quotes}
    settle = datetime(2026, 10, 6, 8, 0, tzinfo=UTC)
    assert by_strike[80_000.0].expiry_ts_ms == int(settle.timestamp() * 1000)
    assert by_strike[80_000.0].mark_iv == pytest.approx(0.46)
    assert by_strike[90_000.0].mark_iv == pytest.approx(0.55)
    assert by_strike[80_000.0].option_type == "call"


def test_persisted_history_reads_the_prior_day(tmp_path) -> None:
    as_of = datetime(2026, 9, 6, 8, 0, tzinfo=UTC)
    as_of_ms = int(as_of.timestamp() * 1000)

    def greeks_for(iv_percent: float, *, skew: bool, at_ms: int = as_of_ms) -> dict[str, GreekSnapshot]:
        built: dict[str, GreekSnapshot] = {}
        for label in ("13SEP26", "6OCT26", "5DEC26"):
            for multiple in WING:
                strike = int(round(FORWARD * multiple))
                side = "C" if multiple >= 1.0 else "P"
                name = f"BTC-{label}-{strike}-{side}"
                k = math.log(strike / FORWARD)
                iv = (50.0 - 120.0 * k) if skew else iv_percent
                built[name] = GreekSnapshot(
                    instrument_name=name,
                    gamma=0.0001,
                    spot_price=FORWARD,
                    snapshot_ts=at_ms,
                    open_interest=1.0,
                    mark_iv=iv,
                    bid_price=0.01, ask_price=0.011, bid_size=1, ask_size=1,
                    bid_iv=max(iv-1,0.01), ask_iv=iv+1,
                    forward_source="ticker_underlying_price",
                )
        return built

    first = build_and_persist_vol_surface(
        tmp_path,
        as_of_ms=as_of_ms,
        greeks=greeks_for(50.0, skew=True),
    )
    assert first["divergence"]["state"] == "baseline"
    assert _tenor(first, "30d")["rr_10_vol_points"] > _tenor(first, "30d")["rr_25_vol_points"] > 0

    second = build_and_persist_vol_surface(
        tmp_path,
        as_of_ms=as_of_ms + DAY_MS,
        greeks=greeks_for(50.0, skew=False, at_ms=as_of_ms+DAY_MS),
    )
    assert second["divergence"]["window"] == "24h"
    assert second["divergence"]["state"] == "fear_unwinding"
    saved = json.loads((tmp_path / "vol_surface_history_v2.json").read_text(encoding="utf-8"))
    assert [row["ts_ms"] for row in saved["samples"]] == [as_of_ms, as_of_ms + DAY_MS]
    assert saved["version"] == "desk_vol_surface_history.v2"
    assert saved["samples"][-1]["atm"]["60d"] == pytest.approx(50.0)
    assert second["history"]["atm"]["60d"][-1] == {
        "ts_ms": as_of_ms + DAY_MS, "value": pytest.approx(50.0),
    }
