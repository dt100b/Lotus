"""Unit tests for 25Δ normalized skew (Regime Velocity replacement)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from greeks.types import GreekSnapshot
from pipeline.skew_25d import (
    ChainPoint,
    HISTORY_ARCHIVE_BUCKET_MS,
    HISTORY_FINE_BUCKET_MS,
    HISTORY_MID_BUCKET_MS,
    HISTORY_RETENTION_MS,
    SKEW_HISTORY_LEGACY_VERSION,
    SKEW_HISTORY_VERSION,
    append_skew_history_levels,
    append_skew_history_sample,
    build_and_persist_skew_25d,
    build_skew_25d_payload,
    bs_abs_delta,
    compute_skew_for_expiry,
    compute_skew_levels,
    compute_constant_maturity_atm,
    interpolate_iv_at_abs_delta,
    load_skew_history_doc,
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

    # A sample in the next 5-minute bucket appends.
    payload2 = build_and_persist_skew_25d(
        tmp_path,
        as_of_ms=as_of_ms + 6 * 60_000,
        greeks=greeks,
    )
    assert len(payload2["series"]) == 2
    assert set(payload2["series_by_tenor"]) == {"1w", "1m", "3m", "6m"}

    # Rapid rematerialize in the same 5-minute bucket replaces the last row.
    payload3 = build_and_persist_skew_25d(
        tmp_path,
        as_of_ms=as_of_ms + 6 * 60_000 + 1_000,
        greeks=greeks,
    )
    assert len(payload3["series"]) == 2


def test_v2_history_persists_all_tenors_and_stable_series(tmp_path: Path) -> None:
    ts_ms = 2_000_000_000_000
    levels = {"1w": 0.01, "1m": 0.02, "3m": 0.03, "6m": 0.04}

    doc = append_skew_history_levels(tmp_path, ts_ms=ts_ms, levels=levels)

    assert doc["version"] == SKEW_HISTORY_VERSION
    assert doc["tenors"] == ["1w", "1m", "3m", "6m"]
    assert doc["samples"] == [{"ts_ms": ts_ms, "values": levels}]

    payload = build_skew_25d_payload(
        as_of_ms=ts_ms,
        levels=levels,
        history_doc=doc,
        primary_tenor="1m",
    )
    assert set(payload["levels"]) == {"1w", "1m", "3m", "6m"}
    assert set(payload["series_by_tenor"]) == {"1w", "1m", "3m", "6m"}
    for tenor, value in levels.items():
        assert payload["series_by_tenor"][tenor] == [
            {"ts_ms": ts_ms, "value": value}
        ]
    assert payload["series"] == payload["series_by_tenor"]["1m"]


def test_v2_missing_tenor_is_gap_without_suppressing_other_series(tmp_path: Path) -> None:
    first_ts = 2_000_000_000_000
    second_ts = first_ts + HISTORY_FINE_BUCKET_MS
    append_skew_history_levels(
        tmp_path,
        ts_ms=first_ts,
        levels={"1w": 0.01, "1m": 0.02, "3m": 0.03, "6m": 0.04},
    )
    doc = append_skew_history_levels(
        tmp_path,
        ts_ms=second_ts,
        levels={"1w": 0.011, "1m": None, "3m": 0.031, "6m": None},
    )

    assert doc["samples"][-1]["values"]["1m"] is None
    assert doc["samples"][-1]["values"]["6m"] is None
    payload = build_skew_25d_payload(
        as_of_ms=second_ts,
        levels={"1w": 0.011, "1m": None, "3m": 0.031, "6m": None},
        history_doc=doc,
        primary_tenor="1m",
    )
    assert [point["ts_ms"] for point in payload["series_by_tenor"]["1m"]] == [first_ts]
    assert [point["ts_ms"] for point in payload["series_by_tenor"]["6m"]] == [first_ts]
    assert [point["ts_ms"] for point in payload["series_by_tenor"]["1w"]] == [
        first_ts,
        second_ts,
    ]
    assert payload["series"] == payload["series_by_tenor"]["1m"]


def test_v1_history_migrates_each_row_only_to_its_recorded_tenor(tmp_path: Path) -> None:
    first_ts = 2_000_000_000_000
    second_ts = first_ts + HISTORY_FINE_BUCKET_MS
    history_file = tmp_path / "skew_25d_history.json"
    history_file.write_text(
        json.dumps(
            {
                "version": SKEW_HISTORY_LEGACY_VERSION,
                "samples": [
                    {"ts_ms": first_ts, "value": 0.02, "tenor": "1m"},
                    {"ts_ms": second_ts, "value": 0.01, "tenor": "1w"},
                ],
            }
        ),
        encoding="utf-8",
    )

    migrated = load_skew_history_doc(tmp_path)
    assert migrated["version"] == SKEW_HISTORY_VERSION
    assert migrated["samples"][0]["values"] == {
        "1w": None,
        "1m": 0.02,
        "3m": None,
        "6m": None,
    }
    assert migrated["samples"][1]["values"] == {
        "1w": 0.01,
        "1m": None,
        "3m": None,
        "6m": None,
    }

    payload = build_skew_25d_payload(
        as_of_ms=second_ts,
        levels={"1w": 0.01, "1m": 0.02, "3m": None, "6m": None},
        history_doc=migrated,
        primary_tenor="1m",
    )
    assert payload["series_by_tenor"]["1m"] == [
        {"ts_ms": first_ts, "value": 0.02}
    ]
    assert payload["series_by_tenor"]["1w"] == [
        {"ts_ms": second_ts, "value": 0.01}
    ]
    assert payload["series_by_tenor"]["3m"] == []
    assert payload["series_by_tenor"]["6m"] == []

    # The next append rewrites the migrated in-memory form as a v2 artifact.
    append_skew_history_levels(
        tmp_path,
        ts_ms=second_ts + HISTORY_FINE_BUCKET_MS,
        levels={"1w": 0.011, "1m": 0.021, "3m": None, "6m": None},
    )
    assert json.loads(history_file.read_text(encoding="utf-8"))["version"] == SKEW_HISTORY_VERSION


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


def test_select_front_expiry_is_fixed_one_day_not_seven_day() -> None:
    """Legacy selector stays nearest-expiry; production front is exact 1d."""
    from datetime import datetime, timezone

    from pipeline.skew_25d import residual_dte_days

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
    # Same primitive as tenor selection at target_days=1.0.
    assert front == select_expiry_for_tenor(points, as_of_ms=as_of_ms, target_days=1.0)

    levels = compute_skew_levels(greeks, as_of_ms=as_of_ms)
    assert levels["front"]["status"] == "ok"
    assert levels["front"]["atm_iv"] is not None
    assert levels["front"]["method"] == "total_variance_interpolation"
    assert levels["front"]["dte_days"] == 1.0
    assert levels["front"]["target_days"] == 1.0
    assert levels["front"] == levels["term"]["1d"]
    assert levels["front"]["lower_expiry_ts_ms"] == front
    assert levels["front"]["upper_expiry_ts_ms"] == int(exp_1w.timestamp() * 1000)
    # Source DTE uses Deribit 08:00 UTC settle, not midnight stamp (+8h).
    midnight_dte = (front - as_of_ms) / 86_400_000.0
    settle_dte = residual_dte_days(front, as_of_ms)
    assert levels["front"]["lower_dte_days"] == pytest.approx(settle_dte)
    assert settle_dte == pytest.approx(midnight_dte + 8.0 / 24.0, abs=1e-6)


def test_constant_maturity_atm_interpolates_total_variance() -> None:
    from datetime import datetime, timezone

    as_of = datetime(2026, 7, 1, 8, 0, tzinfo=timezone.utc)
    as_of_ms = int(as_of.timestamp() * 1000)
    lower_expiry = int(datetime(2026, 7, 2, tzinfo=timezone.utc).timestamp() * 1000)
    upper_expiry = int(datetime(2026, 7, 4, tzinfo=timezone.utc).timestamp() * 1000)

    points: list[ChainPoint] = []
    for expiry, iv in ((lower_expiry, 0.40), (upper_expiry, 0.60)):
        for option_type in ("call", "put"):
            points.append(
                ChainPoint(
                    instrument_name=f"synthetic-{expiry}-{option_type}",
                    option_type=option_type,
                    strike=70_000.0,
                    expiry_ts_ms=expiry,
                    spot=70_000.0,
                    mark_iv=iv,
                    abs_delta=0.50,
                    delta_source="ticker",
                )
            )

    result = compute_constant_maturity_atm(points, as_of_ms=as_of_ms, target_days=2.0)
    assert result["status"] == "ok"
    assert result["method"] == "total_variance_interpolation"
    assert result["dte_days"] == 2.0
    assert result["lower_dte_days"] == 1.0
    assert result["upper_dte_days"] == 3.0
    assert result["interpolation_weight"] == pytest.approx(0.5)

    expected_total_variance = 0.5 * (0.40**2 * (1.0 / 365.0)) + 0.5 * (
        0.60**2 * (3.0 / 365.0)
    )
    expected_iv = (expected_total_variance / (2.0 / 365.0)) ** 0.5
    assert result["atm_iv"] == pytest.approx(expected_iv)


def test_constant_maturity_atm_refuses_extrapolation() -> None:
    point = ChainPoint(
        instrument_name="synthetic",
        option_type="call",
        strike=70_000.0,
        expiry_ts_ms=2_000_000_000_000,
        spot=70_000.0,
        mark_iv=0.50,
        abs_delta=0.50,
        delta_source="ticker",
    )
    result = compute_constant_maturity_atm(
        [point],
        as_of_ms=point.expiry_ts_ms - int(30 * 86_400_000),
        target_days=60.0,
    )
    assert result["status"] == "no_bracket"
    assert result["upper_expiry_ts_ms"] is None


def test_residual_dte_keeps_pre_settle_expiry_for_term_but_not_skew() -> None:
    """A live daily expiry can anchor ATM interpolation without entering skew."""
    from datetime import datetime, timezone

    from pipeline.skew_25d import residual_dte_days

    # 2026-07-31 04:00 UTC — after midnight, before Deribit settle.
    as_of = datetime(2026, 7, 31, 4, 0, tzinfo=timezone.utc)
    as_of_ms = int(as_of.timestamp() * 1000)
    exp_midnight = datetime(2026, 7, 31, tzinfo=timezone.utc)
    exp_ms = int(exp_midnight.timestamp() * 1000)

    # Midnight residual is already negative; settle residual still ~4h.
    assert (exp_ms - as_of_ms) < 0
    dte = residual_dte_days(exp_ms, as_of_ms)
    assert dte == pytest.approx(4.0 / 24.0, abs=1e-6)
    greeks = _greeks_for_dates(
        as_of_ms,
        70_000.0,
        [
            ("31JUL26", exp_ms),
            ("1AUG26", int(datetime(2026, 8, 1, tzinfo=timezone.utc).timestamp() * 1000)),
            ("2AUG26", int(datetime(2026, 8, 2, tzinfo=timezone.utc).timestamp() * 1000)),
        ],
    )
    points = build_chain_points(greeks, as_of_ms=as_of_ms)
    assert exp_ms in {point.expiry_ts_ms for point in points}
    # Expiry-specific skew keeps the 0.35d quality floor.
    assert select_expiry_for_tenor(points, as_of_ms=as_of_ms, target_days=0.2) != exp_ms
    # Exact 1d ATM uses the still-live daily as its lower variance anchor.
    term = compute_constant_maturity_atm(points, as_of_ms=as_of_ms, target_days=1.0)
    assert term["status"] == "ok"
    assert term["lower_expiry_ts_ms"] == exp_ms
    assert term["dte_days"] == 1.0


def test_append_history_prunes(tmp_path: Path) -> None:
    now = 2_000_000_000_000
    for i in range(5):
        append_skew_history_sample(
            tmp_path,
            ts_ms=now - (4 - i) * 3600_000,
            value=0.01 * i,
            tenor="1m",
        )
    # Same 5-minute bucket keeps only its latest sample (not a sixth row).
    doc = append_skew_history_sample(tmp_path, ts_ms=now + 1_000, value=0.05, tenor="1m")
    assert len(doc["samples"]) == 5
    assert doc["samples"][-1]["values"]["1m"] == pytest.approx(0.05)
    # Distinct hour later appends.
    doc2 = append_skew_history_sample(tmp_path, ts_ms=now + 3600_000, value=0.06, tenor="1m")
    assert len(doc2["samples"]) == 6


def test_history_tier_compaction_and_400_day_retention(tmp_path: Path) -> None:
    six_hours_ms = HISTORY_ARCHIVE_BUCKET_MS
    now = (2_000_000_000_000 // six_hours_ms) * six_hours_ms

    recent_bucket = ((now - 3600_000) // HISTORY_FINE_BUCKET_MS) * HISTORY_FINE_BUCKET_MS
    mid_bucket = ((now - 3 * 24 * 3600_000) // HISTORY_MID_BUCKET_MS) * HISTORY_MID_BUCKET_MS
    archive_bucket = ((now - 40 * 24 * 3600_000) // six_hours_ms) * six_hours_ms
    expired_ts = now - HISTORY_RETENTION_MS - six_hours_ms

    def row(ts_ms: int, value: float) -> dict[str, object]:
        return {
            "ts_ms": ts_ms,
            "values": {"1w": None, "1m": value, "3m": None, "6m": None},
        }

    (tmp_path / "skew_25d_history.json").write_text(
        json.dumps(
            {
                "version": SKEW_HISTORY_VERSION,
                "samples": [
                    row(recent_bucket + 10_000, 0.01),
                    row(recent_bucket + 200_000, 0.02),
                    row(mid_bucket + 10_000, 0.03),
                    row(mid_bucket + 20 * 60_000, 0.04),
                    row(archive_bucket + 10_000, 0.05),
                    row(archive_bucket + 5 * 3600_000, 0.06),
                    row(expired_ts, 0.07),
                ],
            }
        ),
        encoding="utf-8",
    )

    doc = append_skew_history_levels(
        tmp_path,
        ts_ms=now,
        levels={"1w": 0.1, "1m": 0.2, "3m": 0.3, "6m": 0.4},
    )
    points = {
        int(sample["ts_ms"]): sample["values"]["1m"]
        for sample in doc["samples"]
    }
    assert recent_bucket + 10_000 not in points
    assert points[recent_bucket + 200_000] == pytest.approx(0.02)
    assert mid_bucket + 10_000 not in points
    assert points[mid_bucket + 20 * 60_000] == pytest.approx(0.04)
    assert archive_bucket + 10_000 not in points
    assert points[archive_bucket + 5 * 3600_000] == pytest.approx(0.06)
    assert expired_ts not in points
    assert points[now] == pytest.approx(0.2)
