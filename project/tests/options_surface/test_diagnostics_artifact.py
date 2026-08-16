"""Runtime-debug report generation is testable from a frozen fixture."""

from __future__ import annotations

import json
from pathlib import Path

from project.options_surface.api_adapter import to_options_surface_response
from project.options_surface.diagnostics import write_live_rejection_artifact
from project.options_surface.service import build_options_surface
from project.options_surface.types import ModelStatus
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    flat_vol_chain,
    listed_future,
)
from project.api.schemas import IvSignalFeedHealth, IvSignalFreshness


def _feed() -> IvSignalFeedHealth:
    return IvSignalFeedHealth(
        source="test",
        transport="snapshot",
        channel_interval=None,
        status="READY",
        connected=True,
        warmup_complete=True,
        universe_is_current=True,
        expected_expiry_instruments=1,
        subscribed_expiry_instruments=1,
        initialized_expiry_instruments=1,
        fresh_expiry_instruments=1,
        completeness_ratio=1.0,
        last_message_at=AS_OF,
        last_message_age_seconds=0.0,
        reconnect_count=0,
        connection_generation=1,
        last_error=None,
    )


def _freshness() -> IvSignalFreshness:
    return IvSignalFreshness(snapshot_age_seconds=1.0, threshold_seconds=180, is_fresh=True)


def test_rejected_density_default_payload_has_no_curve() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD, strikes=[90_000.0, 100_000.0, 110_000.0]),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    body = to_options_surface_response(result, expiry=EXPIRY, feed=_feed(), freshness=_freshness())
    assert body.display.density_status in {"rejected", "unavailable"}
    if body.density is None:
        return
    assert body.density.strikes_usd == []
    assert body.density.raw_density == []
    assert body.density.quantiles == {}
    if body.density.diagnostic is not None:
        assert body.density.diagnostic.is_valid_distribution is False
        assert "not a valid probability distribution" in body.density.diagnostic.label.lower()


def test_frozen_snapshot_writes_redacted_artifact(tmp_path: Path) -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    from project.options_surface.types import to_public_dict

    snapshot = to_public_dict(result)
    snapshot["expiry"] = EXPIRY
    docs = tmp_path / "docs"
    runtime = tmp_path / "runtime"
    paths = write_live_rejection_artifact(
        snapshot=snapshot,
        output_root=runtime,
        docs_dir=docs,
        stamp="testrun",
    )
    assert paths["report"].exists()
    text = paths["report"].read_text(encoding="utf-8")
    assert "Request and market context" in text
    assert "Quote acceptance" in text
    assert "Smile calibration" in text
    assert "density" in text.lower()
    extra = json.loads(paths["extra"].read_text(encoding="utf-8"))
    assert "quote_rows" in extra
    assert "failed_gates" in extra.get("density", {}) or extra.get("density", {}).get("built") is False
    blob = paths["snapshot"].read_text(encoding="utf-8").lower()
    assert "api_key" not in blob
    assert "authorization" not in blob


def test_frozen_live_rejection_snapshot_still_fail_closed() -> None:
    path = (
        Path(__file__).resolve().parents[3]
        / "runtime"
        / "options_surface_debug"
        / "20260816T230839Z"
        / "snapshot.json"
    )
    if not path.exists():
        return
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    from project.options_surface.diagnostics import rebuild_from_snapshot

    result = rebuild_from_snapshot(snapshot)
    assert result.display.density_status.value == "rejected"
    assert result.analytics.central_range_50 is None
    assert result.display.human_readable_reason
    body = to_options_surface_response(result, expiry="2026-08-21", feed=_feed(), freshness=_freshness())
    assert body.density is not None
    assert body.density.strikes_usd == []
    assert body.density.diagnostic is not None
    assert body.density.diagnostic.is_valid_distribution is False
    assert any(gate.code == "cdf_not_monotone" for gate in body.density.failed_gates)


def test_accepted_density_still_publishes_curve() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    body = to_options_surface_response(result, expiry=EXPIRY, feed=_feed(), freshness=_freshness())
    if result.density is not None and result.density.status is not ModelStatus.REJECTED:
        assert body.density is not None
        assert len(body.density.strikes_usd) > 0
        assert body.density.diagnostic is None
        assert body.display.metric_eligibility
