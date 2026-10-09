"""Serving-mode guardrails. No hidden PCHIP fallback."""

from __future__ import annotations

from project.options_surface.config import (
    DisabledBaseline,
    PublishPolicy,
    ServingMode,
    SurfaceServingConfig,
    load_serving_config,
)
from project.options_surface.service import build_options_surface
from project.options_surface.types import DensityDisplayStatus, ModelStatus
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    flat_vol_chain,
    listed_future,
)


def _build(config: SurfaceServingConfig):
    return build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
        serving_config=config,
    )


def test_diagnostic_candidate_may_serve_constrained() -> None:
    result = _build(SurfaceServingConfig(mode=ServingMode.DIAGNOSTIC_CANDIDATE))
    assert result.serving_mode == "diagnostic_candidate"
    assert result.fitter_name == "constrained_svi"
    assert result.fitter_grade.value == "diagnostic_candidate"
    assert result.display.surface_display_status.value == "degraded"
    names = {row.fitter_name: row.selected for row in result.candidate_comparison}
    assert names.get("tv_pchip") is False
    assert names.get("svi_raw") is False


def test_shadow_compare_records_without_hidden_switch() -> None:
    serve = _build(
        SurfaceServingConfig(
            mode=ServingMode.SHADOW_COMPARE,
            publish_policy=PublishPolicy.SERVE,
        )
    )
    assert serve.serving_mode == "shadow_compare"
    assert serve.fitter_name == "constrained_svi"
    withhold = _build(
        SurfaceServingConfig(
            mode=ServingMode.SHADOW_COMPARE,
            publish_policy=PublishPolicy.RECORD_ONLY,
        )
    )
    assert withhold.selection_reason == "shadow_compare_record_only"
    assert withhold.display.density_status in {
        DensityDisplayStatus.UNAVAILABLE,
        DensityDisplayStatus.REJECTED,
    }
    assert withhold.analytics.central_range_50 is None
    pchip = next(row for row in withhold.candidate_comparison if row.fitter_name == "tv_pchip")
    assert pchip.selected is False


def test_disabled_does_not_attempt_constrained_or_pchip() -> None:
    result = _build(
        SurfaceServingConfig(
            mode=ServingMode.DISABLED,
            disabled_baseline=DisabledBaseline.REJECTED,
        )
    )
    assert result.fitter_name == "none"
    assert result.selection_reason == "serving_disabled"
    assert result.display.density_status in {
        DensityDisplayStatus.UNAVAILABLE,
        DensityDisplayStatus.REJECTED,
    }
    constrained = next(
        row for row in result.candidate_comparison if row.fitter_name == "constrained_svi"
    )
    assert constrained.selected is False
    assert "not_attempted" in " ".join(constrained.reason_codes)
    assert all(not row.selected for row in result.candidate_comparison)
    assert result.model_status is ModelStatus.REJECTED


def test_config_hash_changes_with_mode() -> None:
    a = SurfaceServingConfig(mode=ServingMode.DIAGNOSTIC_CANDIDATE)
    b = SurfaceServingConfig(mode=ServingMode.DISABLED)
    assert a.config_hash != b.config_hash
    loaded = load_serving_config({"mode": "shadow_compare", "publish_policy": "record_only"})
    assert loaded.mode is ServingMode.SHADOW_COMPARE
    assert loaded.publish_selected is False


def test_quote_policy_is_versioned_separately_from_gates() -> None:
    from project.options_surface.config import quote_policy_for_source

    ws = SurfaceServingConfig()
    rest = SurfaceServingConfig(**quote_policy_for_source("deribit_book_summary"))
    assert ws.require_sizes is True
    assert rest.require_sizes is False
    assert rest.require_iv_market is False
    assert ws.config_hash != rest.config_hash
