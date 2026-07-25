"""Unit tests for 25Δ normalized skew (Regime Velocity replacement)."""

from __future__ import annotations

from pathlib import Path

import pytest

from greeks.types import GreekSnapshot
from pipeline.skew_25d import (
    append_skew_history_sample,
    build_and_persist_skew_25d,
    bs_abs_delta,
    compute_skew_for_expiry,
    compute_skew_levels,
    interpolate_iv_at_abs_delta,
    normalize_mark_iv,
    resolve_primary_tenor,
    select_expiry_for_tenor,
    select_front_expiry,
    build_chain_points,
)


def test_normalize_mark_iv_percent_and_decimal() -> None:
    assert normalize_mark_iv(55.0) == pytest.approx(0.55)
    assert normalize_mark_iv(0.55) == pytest.approx(0.55)
    assert normalize_mark_iv(0) is None
    assert normalize_mark_iv(-1) is None
    assert normalize_mark_iv(None) is None


def test_interpolate_iv_linear_in_delta_space() -> None:
    points = [(0.10, 0.70), (0.20, 0.60), (0.40, 0.50)]
    # Between 0.20 and 0.40 → target 0.25: weight = (0.25-0.20)/(0.40-0.20) = 0.25
    iv = interpolate_iv_at_abs_delta(points, 0.25)
    assert iv == pytest.approx(0.60 + 0.25 * (0.50 - 0.60))


def test_interpolate_nearest_fallback() -> None:
    points = [(0.22, 0.58)]
    assert interpolate_iv_at_abs_delta(points, 0.25) == pytest.approx(0.58)
    assert interpolate_iv_at_abs_delta(points, 0.50) is None


def test_bs_abs_delta_atm_near_half() -> None:
    d = bs_abs_delta(spot=100.0, strike=100.0, t_years=30 / 365, iv=0.5, option_type="call")
    assert d is not None
    assert abs(d - 0.5) < 0.05


def _synthetic_smile_greeks(
    *,
    as_of_ms: int,
    expiry_ts_ms: int,
    spot: float,
    label: str,
) -> dict[str, GreekSnapshot]:
    """Build a put-skew smile (OTM puts richer) with explicit ticker deltas."""
    # Strikes spanning deep put → deep call with |Δ| near 0.10…0.90
    # Put wing richer: put IV elevated vs call wing.
    specs: list[tuple[float, float, float, float]] = [
        # strike, call_iv, put_iv, approx call |Δ|
        (spot * 0.80, 0.52, 0.72, 0.85),
        (spot * 0.88, 0.50, 0.66, 0.72),
        (spot * 0.94, 0.48, 0.60, 0.60),
        (spot * 0.98, 0.47, 0.54, 0.52),
        (spot * 1.00, 0.46, 0.52, 0.48),
        (spot * 1.04, 0.48, 0.50, 0.40),
        (spot * 1.10, 0.50, 0.49, 0.28),
        (spot * 1.18, 0.52, 0.48, 0.18),
        (spot * 1.28, 0.54, 0.47, 0.10),
    ]
    out: dict[str, GreekSnapshot] = {}
    for strike, call_iv, put_iv, call_abs_d in specs:
        strike_i = int(round(strike / 1000.0) * 1000)
        put_abs_d = 1.0 - call_abs_d
        c_name = f"BTC-{label}-{strike_i}-C"
        p_name = f"BTC-{label}-{strike_i}-P"
        out[c_name] = GreekSnapshot(
            instrument_name=c_name,
            gamma=0.0001,
            spot_price=spot,
            snapshot_ts=as_of_ms,
            mark_iv=call_iv * 100.0,  # Deribit percent form
            delta=call_abs_d,
        )
        out[p_name] = GreekSnapshot(
            instrument_name=p_name,
            gamma=0.0001,
            spot_price=spot,
            snapshot_ts=as_of_ms,
            mark_iv=put_iv * 100.0,
            delta=-put_abs_d,
        )
    # Force expiry via instrument names that parse; override by rebuilding with
    # real Deribit labels is hard for arbitrary ts — use parseable dates near targets.
    return out


def _greeks_for_dates(
    as_of_ms: int,
    spot: float,
    dated: list[tuple[str, int]],
) -> dict[str, GreekSnapshot]:
    """dated: list of (DDMMMYY label, expiry_ts_ms)."""
    merged: dict[str, GreekSnapshot] = {}
    for label, _exp in dated:
        part = _synthetic_smile_greeks(
            as_of_ms=as_of_ms,
            expiry_ts_ms=_exp,
            spot=spot,
            label=label,
        )
        # parse_deribit_option_instrument_name derives expiry from label; ensure
        # labels match real calendar dates used in the test.
        merged.update(part)
    return merged


def test_put_skew_positive_on_synthetic_smile() -> None:
    # 30d tenor ~ 31JUL26 relative to mid-July 2026.
    # as_of: 2026-07-01 00:00 UTC
    as_of_ms = 1_783_000_000_000  # rough; we use parseable labels below
    # Use fixed known labels from instruments parser (DDMMMYY UTC midnight).
    from datetime import datetime, timezone

    as_of = datetime(2026, 7, 1, tzinfo=timezone.utc)
    as_of_ms = int(as_of.timestamp() * 1000)
    exp_1m = datetime(2026, 7, 31, tzinfo=timezone.utc)
    exp_1w = datetime(2026, 7, 8, tzinfo=timezone.utc)
    exp_3m = datetime(2026, 10, 2, tzinfo=timezone.utc)

    greeks = _greeks_for_dates(
        as_of_ms,
        70_000.0,
        [
            ("8JUL26", int(exp_1w.timestamp() * 1000)),
            ("31JUL26", int(exp_1m.timestamp() * 1000)),
            ("2OCT26", int(exp_3m.timestamp() * 1000)),
        ],
    )

    levels = compute_skew_levels(greeks, as_of_ms=as_of_ms)
    assert levels["levels"]["1m"] is not None
    # Put wing richer → positive normalized skew
    assert levels["levels"]["1m"] > 0.0
    assert levels["levels"]["1w"] is not None
    assert levels["levels"]["3m"] is not None

    primary, value = resolve_primary_tenor(levels["levels"])
    assert primary == "1m"
    assert value == levels["levels"]["1m"]


def test_history_ring_and_payload(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    as_of = datetime(2026, 7, 1, tzinfo=timezone.utc)
    as_of_ms = int(as_of.timestamp() * 1000)
    exp_1m = datetime(2026, 7, 31, tzinfo=timezone.utc)
    greeks = _greeks_for_dates(
        as_of_ms,
        70_000.0,
        [("31JUL26", int(exp_1m.timestamp() * 1000))],
    )

    payload = build_and_persist_skew_25d(tmp_path, as_of_ms=as_of_ms, greeks=greeks)
    assert payload["formula"].startswith("(IV_25d_put")
    assert payload["primary_tenor"] in {"1m", "1w"}
    assert payload["levels"]["1m"] is not None or payload["levels"]["1w"] is not None
    assert len(payload["series"]) == 1
    assert payload["series"][0]["value"] == pytest.approx(
        payload["levels"][payload["primary_tenor"]]
    )

    # Second sample a minute later appends (not replaces — >5s gap).
    payload2 = build_and_persist_skew_25d(
        tmp_path,
        as_of_ms=as_of_ms + 60_000,
        greeks=greeks,
    )
    assert len(payload2["series"]) == 2

    # Rapid rematerialize replaces last.
    payload3 = build_and_persist_skew_25d(
        tmp_path,
        as_of_ms=as_of_ms + 61_000,
        greeks=greeks,
    )
    assert len(payload3["series"]) == 2


def test_cold_start_levels_without_history(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    as_of = datetime(2026, 7, 1, tzinfo=timezone.utc)
    as_of_ms = int(as_of.timestamp() * 1000)
    greeks = _greeks_for_dates(
        as_of_ms,
        70_000.0,
        [("31JUL26", int(datetime(2026, 7, 31, tzinfo=timezone.utc).timestamp() * 1000))],
    )
    # Empty artifacts dir: series grows from first sample only.
    assert not (tmp_path / "skew_25d_history.json").exists()
    payload = build_and_persist_skew_25d(tmp_path, as_of_ms=as_of_ms, greeks=greeks)
    assert payload["levels"]["1m"] is not None
    assert len(payload["series"]) >= 1


def test_select_expiry_nearest_tenor() -> None:
    from datetime import datetime, timezone

    as_of = datetime(2026, 7, 1, tzinfo=timezone.utc)
    as_of_ms = int(as_of.timestamp() * 1000)
    spot = 70_000.0
    greeks = _greeks_for_dates(
        as_of_ms,
        spot,
        [
            ("8JUL26", int(datetime(2026, 7, 8, tzinfo=timezone.utc).timestamp() * 1000)),
            ("31JUL26", int(datetime(2026, 7, 31, tzinfo=timezone.utc).timestamp() * 1000)),
        ],
    )
    points = build_chain_points(greeks, as_of_ms=as_of_ms)
    exp_1w = select_expiry_for_tenor(points, as_of_ms=as_of_ms, target_days=7.0)
    exp_1m = select_expiry_for_tenor(points, as_of_ms=as_of_ms, target_days=30.0)
    assert exp_1w == int(datetime(2026, 7, 8, tzinfo=timezone.utc).timestamp() * 1000)
    assert exp_1m == int(datetime(2026, 7, 31, tzinfo=timezone.utc).timestamp() * 1000)


def test_select_front_expiry_is_minimum_dte_not_seven_day() -> None:
    """Front = nearest listed expiry ≥ MIN_DTE, not closest-to-7d tenor match."""
    from datetime import datetime, timezone

    as_of = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
    as_of_ms = int(as_of.timestamp() * 1000)
    # Near front (~1d) vs ~7d vs ~30d — front must pick the ~1d contract.
    exp_1d = datetime(2026, 7, 2, tzinfo=timezone.utc)
    exp_1w = datetime(2026, 7, 8, tzinfo=timezone.utc)
    exp_1m = datetime(2026, 7, 31, tzinfo=timezone.utc)
    greeks = _greeks_for_dates(
        as_of_ms,
        70_000.0,
        [
            ("2JUL26", int(exp_1d.timestamp() * 1000)),
            ("8JUL26", int(exp_1w.timestamp() * 1000)),
            ("31JUL26", int(exp_1m.timestamp() * 1000)),
        ],
    )
    points = build_chain_points(greeks, as_of_ms=as_of_ms)
    front = select_front_expiry(points, as_of_ms=as_of_ms)
    assert front == int(exp_1d.timestamp() * 1000)
    # Closest-to-7d still picks the weekly, proving front ≠ 1w tenor match.
    weekly = select_expiry_for_tenor(points, as_of_ms=as_of_ms, target_days=7.0)
    assert weekly == int(exp_1w.timestamp() * 1000)
    assert front != weekly

    levels = compute_skew_levels(greeks, as_of_ms=as_of_ms)
    assert levels["front"]["status"] == "ok"
    assert levels["front"]["expiry_ts_ms"] == front
    assert levels["front"]["atm_iv"] is not None
    assert levels["front"]["dte_days"] < 2.0


def test_append_history_prunes(tmp_path: Path) -> None:
    now = 2_000_000_000_000
    for i in range(5):
        append_skew_history_sample(
            tmp_path,
            ts_ms=now - (4 - i) * 3600_000,
            value=0.01 * i,
            tenor="1m",
        )
    # Same-second rematerialize replaces last sample (not a sixth row).
    doc = append_skew_history_sample(tmp_path, ts_ms=now + 1_000, value=0.05, tenor="1m")
    assert len(doc["samples"]) == 5
    assert doc["samples"][-1]["value"] == pytest.approx(0.05)
    # Distinct hour later appends.
    doc2 = append_skew_history_sample(tmp_path, ts_ms=now + 3600_000, value=0.06, tenor="1m")
    assert len(doc2["samples"]) == 6
