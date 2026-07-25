"""Unit tests for live refresher sync-window self-heal logic."""

from __future__ import annotations

from scripts.refresh_dashboard_live import resolve_live_sync_window


def test_empty_db_uses_lookback_only() -> None:
    now = 1_800_000_000_000
    start, end, meta = resolve_live_sync_window(
        now_ms=now,
        lookback_minutes=180,
        db_max_timestamp_ms=None,
    )
    assert end == now
    assert start == now - 180 * 60_000
    assert meta["sync_window_source"] == "lookback_only"


def test_fresh_db_uses_lookback_not_watermark() -> None:
    """When DB max is inside the lookback window, keep the normal lookback start."""
    now = 1_800_000_000_000
    lookback = 180
    db_max = now - 10 * 60_000  # 10 minutes ago
    start, end, meta = resolve_live_sync_window(
        now_ms=now,
        lookback_minutes=lookback,
        db_max_timestamp_ms=db_max,
    )
    assert end == now
    assert start == now - lookback * 60_000
    assert meta["sync_window_source"] == "lookback"


def test_stale_db_self_heals_from_watermark() -> None:
    """Multi-hour outage: start from DB max (minus overlap), not pure lookback."""
    now = 1_800_000_000_000
    lookback = 180
    db_max = now - 12 * 3600_000  # 12h behind
    start, end, meta = resolve_live_sync_window(
        now_ms=now,
        lookback_minutes=lookback,
        db_max_timestamp_ms=db_max,
        watermark_overlap_ms=1_000,
    )
    assert end == now
    assert start == db_max - 1_000
    assert meta["sync_window_source"] == "db_watermark"
    # Earlier than pure lookback
    assert start < now - lookback * 60_000


def test_main_host_cap_clamps_ancient_watermark() -> None:
    """Gaps beyond main-host hot store are clamped; deep catch-up is history host."""
    now = 1_800_000_000_000
    cap = 20 * 3600_000
    db_max = now - 48 * 3600_000  # 48h behind
    start, end, meta = resolve_live_sync_window(
        now_ms=now,
        lookback_minutes=180,
        db_max_timestamp_ms=db_max,
        main_host_cap_ms=cap,
    )
    assert end == now
    assert start == now - cap
    assert meta["sync_window_source"] == "db_watermark"
    assert start > db_max  # clamped forward off the ancient watermark
