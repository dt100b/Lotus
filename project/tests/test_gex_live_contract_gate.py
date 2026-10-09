"""Lightweight GEX materialize must keep 0DTE until Deribit 08:00 UTC settle."""

from __future__ import annotations

from datetime import UTC, datetime

from pipeline.dashboard_snapshot import (
    deribit_settle_ms_from_expiry_ts,
    is_live_gex_contract,
)
from pipeline.forward_gamma_surface import (
    build_forward_gamma_surface,
    select_front_0dte_expiry,
    settle_ms_from_expiry,
)


def _midnight_utc_ms(year: int, month: int, day: int) -> int:
    return int(datetime(year, month, day, 0, 0, 0, tzinfo=UTC).timestamp() * 1000)


def test_deribit_settle_ms_is_08_utc_on_expiry_date() -> None:
    expiry_ts = _midnight_utc_ms(2026, 7, 31)
    settle = deribit_settle_ms_from_expiry_ts(expiry_ts)
    assert settle == settle_ms_from_expiry("2026-07-31")
    assert datetime.fromtimestamp(settle / 1000, tz=UTC).hour == 8


def test_0dte_live_between_midnight_and_settle() -> None:
    """After 00:00 UTC on expiry day but before 08:00, strip is still live."""
    expiry_ts = _midnight_utc_ms(2026, 7, 31)
    settle = deribit_settle_ms_from_expiry_ts(expiry_ts)

    # Old gate (midnight): would drop as soon as now > midnight.
    now_after_midnight = expiry_ts + 60_000
    assert now_after_midnight > expiry_ts  # naive midnight filter fails here
    assert is_live_gex_contract(expiry_ts, now_after_midnight)

    # Just before settle still live.
    assert is_live_gex_contract(expiry_ts, settle - 1)

    # At / after true settlement → dropped.
    assert not is_live_gex_contract(expiry_ts, settle)
    assert not is_live_gex_contract(expiry_ts, settle + 60_000)


def test_prior_and_future_expiries() -> None:
    today = _midnight_utc_ms(2026, 7, 31)
    yesterday = _midnight_utc_ms(2026, 7, 30)
    tomorrow = _midnight_utc_ms(2026, 8, 1)
    # 04:00 UTC on 2026-07-31 — inside 0DTE pre-settle window.
    now_ms = today + 4 * 3600 * 1000

    assert not is_live_gex_contract(yesterday, now_ms)
    assert is_live_gex_contract(today, now_ms)
    assert is_live_gex_contract(tomorrow, now_ms)


def test_snapshot_with_0dte_selects_short_tau_surface() -> None:
    """Once 0DTE rows remain in the snapshot, surface picks them with short τ."""
    rows = [
        {
            "expiry": "2026-07-31",
            "strike": 65000.0,
            "call_gex": -2_000_000.0,
            "put_gex": 1_500_000.0,
            "call_mark_iv": 45.0,
            "put_mark_iv": 48.0,
        },
        {
            "expiry": "2026-08-01",
            "strike": 65000.0,
            "call_gex": -9_000_000.0,
            "put_gex": 1_000_000.0,
            "call_mark_iv": 40.0,
            "put_mark_iv": 42.0,
        },
    ]
    # 04:00 UTC on 2026-07-31 (after midnight, before Deribit settle).
    as_of_ms = _midnight_utc_ms(2026, 7, 31) + 4 * 3600 * 1000
    front = select_front_0dte_expiry(
        {str(r["expiry"]) for r in rows},
        now_ms=as_of_ms,
    )
    assert front == "2026-07-31"

    surface = build_forward_gamma_surface(
        rows,
        spot=65500.0,
        as_of_ms=as_of_ms,
        front_expiry=front,
        n_times=12,
        n_prices=16,
    )
    assert surface.expiry == "2026-07-31"
    tau_hours = float(surface.meta.get("tau0_hours", 99))
    assert tau_hours < 8.0  # residual life to 08:00 settle, not ~1.3d next daily
    assert tau_hours > 0.0
