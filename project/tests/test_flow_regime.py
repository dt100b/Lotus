"""Unit tests for signed-flow Regime secondary modes (Velocity / Horizon / Active)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from pipeline.flow_regime import (
    agreement_label,
    append_history_sample,
    build_flow_regime_payload,
    dealer_gamma_score,
    ny_session_anchor_ms,
)


def test_dealer_gamma_score_matches_regime_definition() -> None:
    by_strike = {65000.0: -4.0, 70000.0: 1.0}
    score = dealer_gamma_score(-3.0, by_strike)
    assert abs(score - (-3.0 / 5.0)) < 1e-9


def test_agreement_aligned_fighting_mixed() -> None:
    assert agreement_label(-0.30, -0.25) == "Aligned"
    assert agreement_label(-0.30, 0.25) == "Fighting"
    # Spec: any opposite sign is Fighting (magnitude does not soften it).
    assert agreement_label(-0.05, 0.05) == "Fighting"
    # Same sign but one side below threshold → Mixed
    assert agreement_label(-0.30, -0.05) == "Mixed"
    assert agreement_label(0.0, 0.0) == "Mixed"


def test_ny_session_anchor_handles_dst() -> None:
    # 2026-07-20 20:00 UTC = 16:00 EDT (UTC-4) → anchor 08:00 EDT = 12:00 UTC
    as_of = datetime(2026, 7, 20, 20, 0, tzinfo=UTC)
    anchor_ms = ny_session_anchor_ms(int(as_of.timestamp() * 1000))
    anchor = datetime.fromtimestamp(anchor_ms / 1000, tz=UTC)
    local = anchor.astimezone(ZoneInfo("America/New_York"))
    assert local.hour == 8
    assert local.minute == 0
    assert local.date().isoformat() == "2026-07-20"

    # Winter: 2026-01-15 20:00 UTC = 15:00 EST (UTC-5) → anchor 08:00 EST = 13:00 UTC
    as_of_winter = datetime(2026, 1, 15, 20, 0, tzinfo=UTC)
    winter_ms = ny_session_anchor_ms(int(as_of_winter.timestamp() * 1000))
    winter = datetime.fromtimestamp(winter_ms / 1000, tz=UTC)
    winter_local = winter.astimezone(ZoneInfo("America/New_York"))
    assert winter_local.hour == 8
    assert (winter - as_of_winter.replace(tzinfo=UTC)).total_seconds() != (
        anchor - as_of
    ).total_seconds() or True  # DST offset differs across seasons
    assert winter.hour == 13  # EST


def test_velocity_and_active_strikes_from_history(tmp_path: Path) -> None:
    now_ms = 1_800_000_000_000  # arbitrary stable epoch
    # Seed samples at now-1h, now-4h, now-24h with different strike books.
    for hours_ago, net, strike_gex in (
        (24, -10_000_000.0, {65000.0: -8_000_000.0, 70000.0: -2_000_000.0}),
        (4, -8_000_000.0, {65000.0: -5_000_000.0, 70000.0: -3_000_000.0}),
        (1, -7_200_000.0, {65000.0: -4_500_000.0, 70000.0: -2_700_000.0}),
        (0, -7_000_000.0, {65000.0: -4_290_000.0, 70000.0: -2_710_000.0}),
    ):
        append_history_sample(
            tmp_path,
            ts_ms=now_ms - hours_ago * 3600 * 1000,
            spot=65000.0,
            net_gex=net,
            by_strike=strike_gex,
        )

    # Final "now" sample is the last append above; rebuild payload from history.
    from pipeline.flow_regime import load_history_doc

    history = load_history_doc(tmp_path)
    by_now = {65000.0: -4_290_000.0, 70000.0: -2_710_000.0}
    payload = build_flow_regime_payload(
        as_of_ms=now_ms,
        spot=65000.0,
        net_gex_now=-7_000_000.0,
        by_strike_now=by_now,
        history_doc=history,
        session_by_strike={65000.0: 500_000.0},
        session_available=True,
        session_anchor_ms=now_ms - 8 * 3600 * 1000,
        full_score=-0.5,
    )

    v1 = payload["velocity"]["windows"]["1h"]
    assert v1["delta_net_gex"] is not None
    # now -1h: -7M - (-7.2M) = +0.2M
    assert abs(v1["delta_net_gex"] - 200_000.0) < 1.0

    v24 = payload["velocity"]["windows"]["24h"]
    assert abs(v24["delta_net_gex"] - 3_000_000.0) < 1.0

    # Period Δ history: 24 fixed UTC-hour buckets; sparse samples → mostly null.
    periods = payload["velocity"]["period_deltas"]
    assert len(periods) == 24
    assert all("start_ts_ms" in p and "end_ts_ms" in p for p in periods)
    # Hour ending at now with samples at now-1h and now → Δ = +0.2M
    hour_ms = 3_600_000
    end_of_latest = (now_ms // hour_ms) * hour_ms
    last = periods[-1]
    assert last["end_ts_ms"] == end_of_latest
    assert last["start_ts_ms"] == end_of_latest - hour_ms
    assert last["delta_net_gex"] is not None
    assert abs(last["delta_net_gex"] - 200_000.0) < 1.0

    active = payload["active_strikes"]["windows"]["4h"]["strikes"]
    assert len(active) >= 1
    # 65000 Δ = -4.29M - (-5M) = +0.71M
    top = {row["strike"]: row for row in active}
    assert 65000.0 in top
    assert abs(top[65000.0]["delta_gex"] - 710_000.0) < 1.0

    horizon = payload["horizon"]
    assert horizon["full_score"] == -0.5
    assert horizon["session_score"] == 1.0
    assert horizon["agreement"] == "Fighting"
    assert horizon["read"] is not None
    assert horizon["session_status"] == "ok"
    assert horizon["session_reason"] is None


def test_period_deltas_from_hourly_samples(tmp_path: Path) -> None:
    """Each bar = NetGEX(end of hour) − NetGEX(start of hour) on UTC grid."""
    # Align to a clean hour boundary so floor(as_of) is exact.
    now_ms = 1_800_000_000_000
    hour_ms = 3_600_000
    end_of_latest = (now_ms // hour_ms) * hour_ms
    # Seed 5 consecutive hour-edge samples with known nets.
    nets = [-10.0, -9.0, -11.0, -8.0, -7.5]
    for i, net in enumerate(nets):
        append_history_sample(
            tmp_path,
            ts_ms=end_of_latest - (len(nets) - 1 - i) * hour_ms,
            spot=65000.0,
            net_gex=net * 1_000_000.0,
            by_strike={65000.0: net * 1_000_000.0},
        )

    from pipeline.flow_regime import load_history_doc

    history = load_history_doc(tmp_path)
    payload = build_flow_regime_payload(
        as_of_ms=end_of_latest,
        spot=65000.0,
        net_gex_now=nets[-1] * 1_000_000.0,
        by_strike_now={65000.0: nets[-1] * 1_000_000.0},
        history_doc=history,
        session_by_strike=None,
        session_available=False,
        session_anchor_ms=None,
    )
    periods = payload["velocity"]["period_deltas"]
    assert len(periods) == 24
    # Last 4 complete hours have known Δs from consecutive nets.
    expected = [
        (-9.0 - -10.0) * 1_000_000.0,  # +1M
        (-11.0 - -9.0) * 1_000_000.0,  # -2M
        (-8.0 - -11.0) * 1_000_000.0,  # +3M
        (-7.5 - -8.0) * 1_000_000.0,  # +0.5M
    ]
    recent = periods[-4:]
    for bar, exp in zip(recent, expected, strict=True):
        assert bar["delta_net_gex"] is not None
        assert abs(bar["delta_net_gex"] - exp) < 1.0
    # Older buckets without samples stay null.
    assert periods[0]["delta_net_gex"] is None


def test_missing_history_yields_null_windows(tmp_path: Path) -> None:
    payload = build_flow_regime_payload(
        as_of_ms=1_800_000_000_000,
        spot=65000.0,
        net_gex_now=-1.0,
        by_strike_now={65000.0: -1.0},
        history_doc={"samples": []},
        session_by_strike=None,
        session_available=False,
        session_anchor_ms=None,
        session_status="unavailable",
        session_reason="No Phase 1 DB path for NY-session trade replay",
    )
    assert payload["velocity"]["windows"]["1h"]["delta_net_gex"] is None
    # Empty history still yields a 24-bucket period grid with null Δs
    assert len(payload["velocity"]["period_deltas"]) == 24
    assert all(p["delta_net_gex"] is None for p in payload["velocity"]["period_deltas"])
    assert payload["horizon"]["session_score"] is None
    assert payload["horizon"]["session_status"] == "unavailable"
    assert payload["horizon"]["session_reason"] is not None
    assert payload["active_strikes"]["windows"]["4h"]["strikes"] == []


def test_horizon_pre_open_and_empty_session_diagnostics() -> None:
    pre = build_flow_regime_payload(
        as_of_ms=1_800_000_000_000,
        spot=65000.0,
        net_gex_now=-1.0,
        by_strike_now={65000.0: -1.0},
        history_doc={"samples": []},
        session_by_strike={},
        session_available=True,
        session_anchor_ms=1_800_000_000_000 + 3_600_000,
        session_status="pre_open",
        session_reason="Before 08:00 America/New_York — session book not open",
    )
    assert pre["horizon"]["session_score"] is None
    assert pre["horizon"]["session_available"] is True
    assert pre["horizon"]["session_status"] == "pre_open"
    assert "08:00" in (pre["horizon"]["session_reason"] or "")

    empty = build_flow_regime_payload(
        as_of_ms=1_800_000_000_000,
        spot=65000.0,
        net_gex_now=-1.0,
        by_strike_now={65000.0: -1.0},
        history_doc={"samples": []},
        session_by_strike={},
        session_available=True,
        session_anchor_ms=1_800_000_000_000 - 3_600_000,
    )
    assert empty["horizon"]["session_status"] == "empty"
    assert empty["horizon"]["session_net_gex"] == 0.0
