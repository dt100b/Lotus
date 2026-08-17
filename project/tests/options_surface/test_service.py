"""Orchestrator, snapshot persistence, and same-forward consistency."""

from __future__ import annotations

import math

from project.options_surface.market_data.snapshots import OptionsSurfaceSnapshotStore
from project.options_surface.service import build_options_surface
from project.options_surface.types import (
    ForwardSource,
    ModelStatus,
    SourceQuality,
    to_public_dict,
)
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    SIGMA,
    flat_vol_chain,
    listed_future,
)


def test_same_forward_used_everywhere() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.forward.forward_usd == FORWARD
    assert result.forward.source is ForwardSource.MATCHING_FUTURE
    for point in result.smile.observed:
        assert abs(point.log_moneyness - math.log(point.strike_usd / FORWARD)) < 1e-12
    if result.density is not None:
        assert result.density.forward_usd == FORWARD
    assert result.as_of_utc == AS_OF
    assert result.expiry_utc is not None
    assert result.validation.summary
    assert result.model_status in {ModelStatus.ACCEPTED, ModelStatus.DEGRADED, ModelStatus.REJECTED}


def test_sparse_book_fails_closed() -> None:
    rows = flat_vol_chain(forward=FORWARD, strikes=[90_000.0, 100_000.0, 110_000.0])
    result = build_options_surface(
        rows,
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.model_status is ModelStatus.REJECTED
    assert result.analytics.central_range_50 is None
    assert result.analytics.p_below_forward is None
    assert result.density is None or result.density.quantiles == {} or result.density.status is ModelStatus.REJECTED


def test_snapshot_round_trip(tmp_path) -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    store = OptionsSurfaceSnapshotStore(tmp_path)
    path = store.persist(result)
    loaded = store.load_latest("BTC", result.expiry_utc)
    assert loaded is not None
    assert loaded["schema_version"] == result.schema_version
    assert loaded["forward"]["source"] == "matching_future"
    assert loaded["forward"]["source_quality"] == "high"
    assert "as_of_utc" in loaded
    assert "expiry_utc" in loaded
    assert path.exists()
    records = store.iter_jsonl()
    assert len(records) == 1


def test_public_dict_has_no_directional_tokens() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    blob = str(to_public_dict(result)).lower()
    for token in ("long", "short", "bullish", "bearish", "forecast", "verdict", "no_trade"):
        assert token not in blob


def test_baseline_fitter_is_diagnostic() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.fitter_name == "constrained_svi"
    assert result.fitter_grade.value == "diagnostic_candidate"
    assert result.model_status is not ModelStatus.ACCEPTED
    assert result.display.surface_display_status.value != "ready"
