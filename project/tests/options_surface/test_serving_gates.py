"""Served-curve convexity is a mandatory density serving gate."""

from __future__ import annotations

from project.options_surface.display import (
    RESEARCH_CONVEXITY_REASON,
    build_display_state,
    eligibility_map,
)
from project.options_surface.distribution.density import (
    apply_served_smile_arbitrage,
    extract_density,
)
from project.options_surface.distribution.validate import apply_served_call_curve_gates
from project.options_surface.service import build_options_surface
from project.options_surface.timeutil import inferred_deribit_expiry_utc, require_positive_year_fraction
from project.options_surface.types import (
    ArbitrageReport,
    DensityDisplayStatus,
    FitterGrade,
    ModelStatus,
    ResearchFitterReport,
    SurfaceDisplayStatus,
)
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    SIGMA,
    flat_vol_chain,
    listed_future,
    option_row,
)


def _tau() -> float:
    return require_positive_year_fraction(AS_OF, inferred_deribit_expiry_utc(EXPIRY))


def _flat_iv(_strike: float) -> float:
    return SIGMA


def _passing_density():
    return extract_density(
        iv_from_strike=_flat_iv,
        forward_usd=FORWARD,
        time_to_expiry_years=_tau(),
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        k_min=-1.2,
        k_max=1.2,
        grid_points=201,
        compare_grid_points=101,
    )


def _nonconvex_report() -> ArbitrageReport:
    return ArbitrageReport(
        positive_variance=True,
        call_monotone=True,
        call_convex=False,
        butterfly_ok=False,
        calendar_ok=None,
        min_total_variance=SIGMA * SIGMA * _tau(),
        min_call_step=-1.0,
        min_butterfly=-0.25,
        min_calendar_dw=None,
        violations=("call_not_convex_in_strike",),
        worst_convexity_strike=FORWARD * 0.90,
    )


def _research(convex: bool) -> ResearchFitterReport:
    return ResearchFitterReport(
        fitter_name="svi_raw",
        fitter_grade=FitterGrade.RESEARCH,
        status=ModelStatus.RESEARCH,
        call_monotone=True,
        call_convex=convex,
        violations=() if convex else ("call_not_convex_in_strike",),
        worst_convexity_strike=None if convex else FORWARD * 0.88,
        notes=("Research-grade raw SVI. Not production-ready.",),
    )


def test_served_pchip_convexity_failure_rejects_density_and_headlines() -> None:
    density = _passing_density()
    assert density.status in {ModelStatus.ACCEPTED, ModelStatus.DEGRADED}
    assert density.validation.mass is not None
    assert abs(density.validation.mass - 1.0) < 0.05
    rejected = apply_served_smile_arbitrage(density, _nonconvex_report())
    assert rejected.status is ModelStatus.REJECTED
    assert rejected.quantiles == {}
    assert rejected.mean is None
    assert any(gate.code == "call_not_convex_in_strike" for gate in rejected.validation.failed_gates)


def test_research_svi_convexity_does_not_reject_passing_served_density() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.density is not None
    assert result.density.status is not ModelStatus.REJECTED
    assert result.display.density_status in {
        DensityDisplayStatus.ACCEPTED,
        DensityDisplayStatus.DEGRADED,
    }
    assert "call_not_convex_in_strike" not in {
        gate.code for gate in result.density.validation.failed_gates
    }
    state = build_display_state(
        forward=result.forward,
        quotes=result.quotes,
        smile=result.smile,
        density=result.density,
        analytics=result.analytics,
        fitter_grade=result.fitter_grade,
        warnings=result.warnings,
        sparse=False,
        fitter_name=result.fitter_name,
        research=_research(convex=False),
    )
    assert state.density_status is result.display.density_status
    assert state.density_status is not DensityDisplayStatus.REJECTED
    assert "Call-price convexity failed" not in state.failed_checks
    assert state.research_failed_checks
    assert state.research_human_reason == RESEARCH_CONVEXITY_REASON
    assert state.customer_warning_scope == "research"
    eligible = eligibility_map(state)
    assert eligible["median"].available is True
    assert eligible["mode"].available is True
    assert eligible["central_range_50"].available is True


def test_warning_identifies_served_fitter_and_validation_scope() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    density = apply_served_smile_arbitrage(result.density, _nonconvex_report())  # type: ignore[arg-type]
    state = build_display_state(
        forward=result.forward,
        quotes=result.quotes,
        smile=result.smile,
        density=density,
        analytics=result.analytics,
        fitter_grade=result.fitter_grade,
        warnings=("density_rejected",),
        sparse=False,
        fitter_name="tv_pchip",
        research=_research(convex=False),
    )
    assert state.served_fitter_name == "tv_pchip"
    assert state.served_fitter_grade is FitterGrade.DIAGNOSTIC
    assert state.customer_warning_scope == "served"
    assert "convex" in state.human_readable_reason.lower()
    assert "Call-price convexity failed" in state.failed_checks
    assert state.research_fitter_name == "svi_raw"
    assert "research" in (state.research_human_reason or "").lower()
    assert "tv_pchip" in state.diagnostic_detail
    assert "svi_raw" in state.diagnostic_detail


def test_rejected_density_cannot_return_median_mode_or_ranges() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    density = apply_served_smile_arbitrage(result.density, _nonconvex_report())  # type: ignore[arg-type]
    state = build_display_state(
        forward=result.forward,
        quotes=result.quotes,
        smile=result.smile,
        density=density,
        analytics=result.analytics,
        fitter_grade=result.fitter_grade,
        warnings=("density_rejected",),
        sparse=False,
        fitter_name=result.fitter_name,
        research=_research(convex=True),
    )
    assert state.density_status is DensityDisplayStatus.REJECTED
    assert state.surface_display_status is SurfaceDisplayStatus.REJECTED
    eligible = eligibility_map(state)
    for metric in (
        "density_chart",
        "median",
        "mode",
        "central_range_50",
        "central_range_90",
        "tail_probabilities",
        "digital_probabilities",
    ):
        assert eligible[metric].available is False
        assert eligible[metric].reason_code == "call_not_convex_in_strike"


def test_diagnostic_fitter_is_not_labeled_production() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.fitter_name == "tv_pchip"
    assert result.fitter_grade is FitterGrade.DIAGNOSTIC
    assert result.display.served_fitter_grade is FitterGrade.DIAGNOSTIC
    blob = (result.display.diagnostic_detail + result.display.human_readable_reason).lower()
    assert "production-grade" not in blob
    assert "arbitrage-controlled surface" not in blob
    if result.display.density_status in {
        DensityDisplayStatus.ACCEPTED,
        DensityDisplayStatus.DEGRADED,
    }:
        assert result.display.surface_display_status is not SurfaceDisplayStatus.READY


def test_served_and_research_combinations() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    passing = result.density
    failing = apply_served_smile_arbitrage(passing, _nonconvex_report())  # type: ignore[arg-type]
    cases = (
        (passing, _research(False), False, "research"),
        (failing, _research(True), True, "served"),
        (failing, _research(False), True, "served"),
        (passing, None, False, "none"),
    )
    for density, research, expect_reject, scope in cases:
        state = build_display_state(
            forward=result.forward,
            quotes=result.quotes,
            smile=result.smile,
            density=density,
            analytics=result.analytics,
            fitter_grade=result.fitter_grade,
            warnings=() if not expect_reject else ("density_rejected",),
            sparse=False,
            fitter_name="tv_pchip",
            research=research,
        )
        if expect_reject:
            assert state.density_status is DensityDisplayStatus.REJECTED
            assert eligibility_map(state)["median"].available is False
            assert "convex" in state.human_readable_reason.lower()
        else:
            assert state.density_status is not DensityDisplayStatus.REJECTED
            assert eligibility_map(state)["median"].available is True
            assert "Call-price convexity failed" not in state.failed_checks
        assert state.customer_warning_scope == scope
        assert eligibility_map(state)["forward"].available is True
        assert "forward quality low" not in state.human_readable_reason.lower()


def test_kinked_served_smile_rejects_density() -> None:
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
    if not result.smile.arbitrage.call_convex:
        assert result.display.density_status is DensityDisplayStatus.REJECTED
        assert result.display.surface_display_status is SurfaceDisplayStatus.REJECTED
        assert result.analytics.central_range_50 is None
        assert result.analytics.risk_neutral_mean is None
        assert "convex" in result.display.human_readable_reason.lower()


def test_call_curve_gate_does_not_override_with_mass_or_moment() -> None:
    density = _passing_density()
    validation = apply_served_call_curve_gates(density.validation, _nonconvex_report())
    assert validation.status is ModelStatus.REJECTED
    assert validation.mass is not None
    assert abs(validation.mass - 1.0) < 0.05
    assert any(gate.code == "call_not_convex_in_strike" and gate.severity == "reject" for gate in validation.failed_gates)
