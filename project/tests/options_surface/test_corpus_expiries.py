"""Curated expiry selection."""

from __future__ import annotations

from datetime import UTC, datetime

from project.options_surface.corpus.expiries import listed_expiry_dates, select_curated_expiries


def test_curated_eow_weekly_eom_quarterly() -> None:
    as_of = datetime(2026, 8, 16, 12, tzinfo=UTC)
    listed = [
        "2026-08-14",  # expired Friday
        "2026-08-21",  # nearest EOW
        "2026-08-28",  # following weekly / also EOM (last Friday of August)
        "2026-09-25",  # following monthly (last Friday of September, quarterly)
        "2026-10-30",
        "2026-08-17",  # Monday daily, ignored for curated roles
    ]
    chosen = select_curated_expiries(listed, as_of_utc=as_of, max_count=4)
    by_expiry = {item["expiry"]: item for item in chosen}
    assert by_expiry["2026-08-21"]["role"] == "nearest_eow"
    assert "following_weekly" in by_expiry["2026-08-28"]["roles"]
    assert "nearest_eom" in by_expiry["2026-08-28"]["roles"]
    assert by_expiry["2026-09-25"]["role"] == "following_monthly_or_quarterly"
    kinds = {item["expiry"]: item["kind"] for item in chosen}
    assert kinds["2026-08-21"] == "weekly"
    assert kinds["2026-09-25"] == "quarterly"


def test_expired_and_unlisted_are_skipped() -> None:
    as_of = datetime(2026, 8, 22, 12, tzinfo=UTC)
    chosen = select_curated_expiries(
        ["2026-08-21", "2026-08-28"],
        as_of_utc=as_of,
        max_count=4,
    )
    expiries = [item["expiry"] for item in chosen]
    assert "2026-08-21" not in expiries
    assert "2026-08-28" in expiries


def test_listed_dates_from_instrument_names() -> None:
    dates = listed_expiry_dates(
        [
            {"instrument_name": "BTC-21AUG26-60000-C"},
            {"instrument_name": "BTC-21AUG26-62000-P"},
            {"instrument_name": "ETH-21AUG26-3000-C"},
            "2026-08-28",
        ],
        underlying="BTC",
    )
    assert dates[0].isoformat() == "2026-08-21"
    assert dates[-1].isoformat() == "2026-08-28"
