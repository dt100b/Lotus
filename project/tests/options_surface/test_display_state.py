"""Display-state and metric-eligibility contract."""

from __future__ import annotations

from project.options_surface.display import (
    ALLOWED_DISPLAY_COMBINATIONS,
    build_display_state,
    eligibility_map,
)
from project.options_surface.service import build_options_surface
from project.options_surface.types import (
    DensityDisplayStatus,
    ModelStatus,
    QuoteStatus,
    SurfaceDisplayStatus,
)
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    flat_vol_chain,
    listed_future,
    option_row,
)


def test_rejected_density_has_no_probability_headlines() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD, strikes=[90_000.0, 100_000.0, 110_000.0]),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.display.density_status in {
        DensityDisplayStatus.REJECTED,
        DensityDisplayStatus.UNAVAILABLE,
    }
    assert result.display.surface_display_status in {
        SurfaceDisplayStatus.REJECTED,
        SurfaceDisplayStatus.UNAVAILABLE,
    }
    eligible = eligibility_map(result.display)
    assert eligible["median"].available is False
    assert eligible["mode"].available is False
    assert eligible["mode"].reason_code in {"density_rejected", "density_not_built", "mode_not_served"}
    assert eligible["central_range_50"].available is False
    assert eligible["central_range_90"].available is False
    assert eligible["tail_probabilities"].available is False
    assert eligible["density_chart"].available is False
    assert result.analytics.central_range_50 is None
    assert result.analytics.risk_neutral_mean is None
    assert result.display.human_readable_reason
    assert result.display.reason_codes


def test_degraded_smile_rejected_density_keeps_forward_and_atm() -> None:
    # Dense enough to fit, but a kinked smile that typically fails convexity.
    strikes = [70_000, 80_000, 90_000, 95_000, 100_000, 105_000, 110_000, 120_000, 130_000]
    rows = []
    for strike in strikes:
        iv = 80.0 if strike < 95_000 else 40.0 if strike > 105_000 else 50.0
        for side in ("call", "put"):
            rows.append(option_row(strike, side, iv))
    result = build_options_surface(
        rows,
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    eligible = eligibility_map(result.display)
    assert result.forward.forward_usd == FORWARD
    assert eligible["forward"].available is True
    if result.display.density_status is DensityDisplayStatus.REJECTED:
        assert eligible["median"].available is False
        assert eligible["density_chart"].available is False
        assert result.density is None or result.density.quantiles == {}
    if result.analytics.atm_iv is not None:
        assert eligible["atm_iv"].available is True


def test_rr_and_bf_share_one_delta_gate() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    eligible = eligibility_map(result.display)
    assert eligible["rr_25"].available == eligible["bf_25"].available
    if eligible["rr_25"].available:
        assert result.analytics.rr_25 is not None
        assert result.analytics.bf_25 is not None
        assert result.analytics.k_25_call is not None
        assert result.analytics.k_25_put is not None
    else:
        assert eligible["rr_25"].reason_code == eligible["bf_25"].reason_code
        assert result.analytics.rr_25 is None
        assert result.analytics.bf_25 is None


def test_rr_bf_both_absent_when_one_root_missing() -> None:
    # Only downside quotes: 25d call cannot solve inside coverage.
    strikes = [70_000, 80_000, 85_000, 90_000, 95_000, 99_000]
    rows = []
    for strike in strikes:
        for side in ("call", "put"):
            rows.append(option_row(strike, side, 50.0))
    result = build_options_surface(
        rows,
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    eligible = eligibility_map(result.display)
    assert eligible["rr_25"].available is False
    assert eligible["bf_25"].available is False
    assert eligible["rr_25"].reason_code == eligible["bf_25"].reason_code
    assert result.analytics.rr_25 is None
    assert result.analytics.bf_25 is None


def test_allowed_display_combinations_cover_live_rejected_case() -> None:
    assert (
        "degraded",
        "degraded",
        "rejected",
        "rejected",
    ) in ALLOWED_DISPLAY_COMBINATIONS
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    combo = (
        result.display.quote_status.value,
        result.display.smile_status.value,
        result.display.density_status.value,
        result.display.surface_display_status.value,
    )
    assert combo in ALLOWED_DISPLAY_COMBINATIONS


def test_forward_unavailable_is_unavailable_display() -> None:
    from datetime import UTC, datetime

    from project.options_surface.types import (
        ArbitrageReport,
        ForwardEstimate,
        ForwardSource,
        QuoteQualitySummary,
        SmileFitDiagnostics,
        SmileSlice,
        SourceQuality,
        SurfaceAnalytics,
        FitterGrade,
    )

    forward = ForwardEstimate(
        as_of_utc=AS_OF,
        expiry_utc=datetime(2030, 8, 16, 8, tzinfo=UTC),
        underlying="BTC",
        forward_usd=None,
        source=None,
        source_quality=SourceQuality.UNAVAILABLE,
        supporting_instruments=(),
        parity_pair_count=0,
        parity_dispersion=None,
        futures_option_difference=None,
        fallback_reason="no_source",
        validation_flags=(),
    )
    quotes = QuoteQualitySummary(
        input_rows=0,
        accepted_rows=0,
        rejected_rows=0,
        accepted_strikes=0,
        preferred_side_selections=0,
        opposite_side_fallbacks=0,
        atm_merged=0,
        synthetic_atm_added=False,
        reason_counts={},
        lower_strikes=0,
        upper_strikes=0,
        center_log_gap=None,
        tenor_bucket="unknown",
    )
    empty_arb = ArbitrageReport(
        positive_variance=False,
        call_monotone=False,
        call_convex=False,
        butterfly_ok=False,
        calendar_ok=None,
        min_total_variance=None,
        min_call_step=None,
        min_butterfly=None,
        min_calendar_dw=None,
        violations=("forward_unavailable",),
    )
    smile = SmileSlice(
        as_of_utc=AS_OF,
        expiry_utc=datetime(2030, 8, 16, 8, tzinfo=UTC),
        underlying="BTC",
        forward=forward,
        time_to_expiry_years=0.01,
        observed=(),
        synthetic=(),
        fit=(),
        diagnostics=SmileFitDiagnostics(
            fitter_name="none",
            fitter_grade=FitterGrade.DIAGNOSTIC,
            status=ModelStatus.REJECTED,
            residual_rms=None,
            weighted_residual_rms=None,
            optimizer_status="not_run",
            parameter_count=0,
            parameters={},
            observation_count=0,
            k_min=None,
            k_max=None,
            extrapolated=False,
            notes=("forward_unavailable",),
        ),
        arbitrage=empty_arb,
    )
    analytics = SurfaceAnalytics(
        atm_iv=None,
        implied_move_1sd_up=None,
        implied_move_1sd_down=None,
        rr_25=None,
        bf_25=None,
        iv_25_call=None,
        iv_25_put=None,
        downside_wing_richness=None,
        upside_wing_richness=None,
        futures_option_basis=None,
        p_below_forward=None,
        p_above_forward=None,
        p_left_5=None,
        p_right_5=None,
        p_left_sigma=None,
        p_right_sigma=None,
        central_range_50=None,
        central_range_90=None,
        risk_neutral_mean=None,
    )
    state = build_display_state(
        forward=forward,
        quotes=quotes,
        smile=smile,
        density=None,
        analytics=analytics,
        fitter_grade=FitterGrade.DIAGNOSTIC,
        warnings=("forward_unavailable",),
        sparse=True,
    )
    assert state.surface_display_status is SurfaceDisplayStatus.UNAVAILABLE
    assert eligibility_map(state)["forward"].available is False


def test_customer_mode_is_not_sourced_from_median() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    eligible = eligibility_map(result.display)
    assert eligible["mode"].available is False
    assert eligible["mode"].reason_code == "mode_not_served"
    if result.density is not None and result.display.density_status.value in {
        "accepted",
        "degraded",
    }:
        assert "p50" in result.density.quantiles
        # The median remains available; it must not be aliased as a mode.
        assert eligible["median"].available is True
        assert result.density.quantiles["p50"] != getattr(result.density, "mode", None)
