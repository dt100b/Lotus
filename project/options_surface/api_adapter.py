"""Map the options-surface engine onto API schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping

from project.api.schemas import (
    IvBandSignal,
    IvDirectionalSignal,
    IvPeakSignal,
    IvRndDiagnostics,
    IvSignalCoverage,
    IvSignalCurvePoint,
    IvSignalCurveQuality,
    IvSignalEligibility,
    IvSignalEligibilityRequirements,
    IvSignalFeedHealth,
    IvSignalFreshness,
    IvSignalMarkers,
    IvSignalMetrics,
    IvSignalOutlookState,
    IvSignalParameters,
    IvSignalScanResponse,
    IvSignalSelectionDiagnostics,
    IvSignalSmile,
    IvSignalSmileFitPoint,
    IvSignalSmileMetrics,
    IvSignalSmilePoint,
    OptionsSurfaceAnalytics,
    OptionsSurfaceDensity,
    OptionsSurfaceDensityDiagnostic,
    OptionsSurfaceDisplayState,
    OptionsSurfaceFailedGate,
    OptionsSurfaceForward,
    OptionsSurfaceMetricEligibility,
    OptionsSurfaceQuoteSummary,
    OptionsSurfaceResearchCandidate,
    OptionsSurfaceResponse,
    OptionsSurfaceSmile,
    OptionsSurfaceSmilePoint,
    OptionsSurfaceValidation,
)
from project.options_surface.timeutil import hours_to_expiry
from project.options_surface.types import (
    DensityResult,
    ModelStatus,
    OptionsSurfaceResult,
    SmilePoint,
    ValidationGate,
)

_FORWARD_SOURCE_LEGACY = {
    "matching_future": "matching_future",
    "inverse_put_call_parity": "inverse_put_call_parity",
    "venue_underlying_price": "venue_underlying_price",
    "spot_fallback": "spot_fallback",
}


def to_options_surface_response(
    result: OptionsSurfaceResult,
    *,
    expiry: str,
    feed: IvSignalFeedHealth,
    freshness: IvSignalFreshness,
) -> OptionsSurfaceResponse:
    density = None
    if result.density is not None:
        density = _density_schema(result.density)
    analytics = result.analytics
    return OptionsSurfaceResponse(
        schema_version=result.schema_version,
        as_of_utc=result.as_of_utc,
        expiry_utc=result.expiry_utc,
        expiry=expiry,
        underlying=result.underlying,
        index_usd=result.index_usd,
        time_to_expiry_years=result.time_to_expiry_years,
        forward=OptionsSurfaceForward(
            as_of_utc=result.forward.as_of_utc,
            expiry_utc=result.forward.expiry_utc,
            underlying=result.forward.underlying,
            forward_usd=result.forward.forward_usd,
            source=result.forward.source.value if result.forward.source else None,
            source_quality=result.forward.source_quality.value,
            supporting_instruments=list(result.forward.supporting_instruments),
            parity_pair_count=result.forward.parity_pair_count,
            parity_dispersion=result.forward.parity_dispersion,
            futures_option_difference=result.forward.futures_option_difference,
            fallback_reason=result.forward.fallback_reason,
            validation_flags=list(result.forward.validation_flags),
        ),
        quotes=OptionsSurfaceQuoteSummary(
            input_rows=result.quotes.input_rows,
            accepted_rows=result.quotes.accepted_rows,
            rejected_rows=result.quotes.rejected_rows,
            accepted_strikes=result.quotes.accepted_strikes,
            preferred_side_selections=result.quotes.preferred_side_selections,
            opposite_side_fallbacks=result.quotes.opposite_side_fallbacks,
            atm_merged=result.quotes.atm_merged,
            synthetic_atm_added=result.quotes.synthetic_atm_added,
            reason_counts=dict(result.quotes.reason_counts),
            lower_strikes=result.quotes.lower_strikes,
            upper_strikes=result.quotes.upper_strikes,
            center_log_gap=result.quotes.center_log_gap,
            tenor_bucket=result.quotes.tenor_bucket,
        ),
        smile=OptionsSurfaceSmile(
            observed=[_smile_point(point) for point in result.smile.observed],
            synthetic=[_smile_point(point) for point in result.smile.synthetic],
            fit=[_smile_point(point) for point in result.smile.fit],
            fitter_name=result.fitter_name,
            fitter_grade=result.fitter_grade.value,
            status=result.smile.diagnostics.status.value,
            residual_rms=result.smile.diagnostics.residual_rms,
            optimizer_status=result.smile.diagnostics.optimizer_status,
            parameters=dict(result.smile.diagnostics.parameters),
            k_min=result.smile.diagnostics.k_min,
            k_max=result.smile.diagnostics.k_max,
            notes=list(result.smile.diagnostics.notes),
        ),
        density=density,
        analytics=OptionsSurfaceAnalytics(
            atm_iv=analytics.atm_iv,
            implied_move_1sd_up=analytics.implied_move_1sd_up,
            implied_move_1sd_down=analytics.implied_move_1sd_down,
            rr_25=analytics.rr_25,
            bf_25=analytics.bf_25,
            iv_25_call=analytics.iv_25_call,
            iv_25_put=analytics.iv_25_put,
            downside_wing_richness=analytics.downside_wing_richness,
            upside_wing_richness=analytics.upside_wing_richness,
            futures_option_basis=analytics.futures_option_basis,
            p_below_forward=analytics.p_below_forward,
            p_above_forward=analytics.p_above_forward,
            p_left_5=analytics.p_left_5,
            p_right_5=analytics.p_right_5,
            p_left_sigma=analytics.p_left_sigma,
            p_right_sigma=analytics.p_right_sigma,
            central_range_50=(
                list(analytics.central_range_50) if analytics.central_range_50 else None
            ),
            central_range_90=(
                list(analytics.central_range_90) if analytics.central_range_90 else None
            ),
            risk_neutral_mean=analytics.risk_neutral_mean,
            k_25_call=analytics.k_25_call,
            k_25_put=analytics.k_25_put,
        ),
        validation=OptionsSurfaceValidation(
            model_status=result.model_status.value,
            forward_quality=result.forward.source_quality.value,
            smile_status=result.smile.diagnostics.status.value,
            density_status=result.display.density_status.value,
            quote_reason_counts=dict(result.quotes.reason_counts),
            warnings=list(result.warnings),
            summary=result.validation.summary,
            positive_variance=result.smile.arbitrage.positive_variance,
            call_monotone=result.smile.arbitrage.call_monotone,
            call_convex=result.smile.arbitrage.call_convex,
            butterfly_ok=result.smile.arbitrage.butterfly_ok,
            calendar_ok=result.smile.arbitrage.calendar_ok,
            arbitrage_violations=list(result.smile.arbitrage.violations),
            quote_status=result.display.quote_status.value,
            surface_display_status=result.display.surface_display_status.value,
            human_readable_reason=result.display.human_readable_reason,
            failed_checks=list(result.display.failed_checks),
        ),
        model_status=result.model_status.value,
        fitter_name=result.fitter_name,
        fitter_grade=result.fitter_grade.value,
        display=_display_schema(result),
        research=_research_schema(result),
        feed=feed,
        freshness=freshness,
        warnings=list(result.warnings),
    )


def to_legacy_scan_response(
    result: OptionsSurfaceResult,
    *,
    expiry: str,
    feed: IvSignalFeedHealth,
    freshness: IvSignalFreshness,
    tail_threshold: float,
    band_width: float,
    signal_delta: float,
) -> IvSignalScanResponse:
    """Deprecated response. Directional fields are retired and always NO_TRADE."""
    forward = result.forward.forward_usd or result.index_usd
    density_points = []
    # Rejected densities are not a customer-facing probability chart.
    if (
        result.density is not None
        and result.density.status is not ModelStatus.REJECTED
        and result.display.density_status.value in {"accepted", "degraded"}
    ):
        density_points = [
            {"strike": strike, "raw": raw, "smoothed": raw}
            for strike, raw in zip(
                result.density.strikes_usd, result.density.raw_density, strict=True
            )
        ]
    observed = list(result.smile.observed) + list(result.smile.synthetic)
    iv_curve = [_legacy_curve_point(point) for point in observed]
    smile_points = [_legacy_smile_point(point) for point in observed]
    fit_points = [
        IvSignalSmileFitPoint(
            strike=point.strike_usd,
            iv=point.iv,
            iv_percent=point.iv * 100.0,
            log_moneyness=point.log_moneyness,
            delta=point.forward_delta,
        )
        for point in result.smile.fit
    ]
    analytics = result.analytics
    quantiles = result.density.quantiles if result.density is not None else {}
    rejected = result.density is None or result.density.status is ModelStatus.REJECTED
    reasons = {item.rejection_reason.value: 0 for item in ()}
    reasons = dict(result.quotes.reason_counts)
    quality_level = _quality_level(result)
    rnd = IvRndDiagnostics(
        forward=float(forward),
        p_below_forward=0.0 if rejected else float(analytics.p_below_forward or 0.0),
        p_above_forward=0.0 if rejected else float(analytics.p_above_forward or 0.0),
        p_left_5=0.0 if rejected else float(analytics.p_left_5 or 0.0),
        p_right_5=0.0 if rejected else float(analytics.p_right_5 or 0.0),
        p_left_sigma=0.0 if rejected else float(analytics.p_left_sigma or 0.0),
        p_right_sigma=0.0 if rejected else float(analytics.p_right_sigma or 0.0),
        sigma_move=(
            0.0
            if analytics.atm_iv is None
            else float(analytics.atm_iv * (result.time_to_expiry_years**0.5))
        ),
        sigma_left_strike=(
            None
            if analytics.implied_move_1sd_down is None
            else float(forward - analytics.implied_move_1sd_down)
        ),
        sigma_right_strike=(
            None
            if analytics.implied_move_1sd_up is None
            else float(forward + analytics.implied_move_1sd_up)
        ),
        atm_iv=analytics.atm_iv,
        percentile_05=0.0 if rejected else float(quantiles.get("p05") or 0.0),
        percentile_16=None if rejected else quantiles.get("p16"),
        percentile_25=0.0 if rejected else float(quantiles.get("p25") or 0.0),
        percentile_50=0.0 if rejected else float(quantiles.get("p50") or 0.0),
        percentile_75=0.0 if rejected else float(quantiles.get("p75") or 0.0),
        percentile_84=None if rejected else quantiles.get("p84"),
        percentile_95=0.0 if rejected else float(quantiles.get("p95") or 0.0),
        expected_move_up=float(analytics.implied_move_1sd_up or 0.0),
        expected_move_down=float(analytics.implied_move_1sd_down or 0.0),
        mean=float(forward if rejected else (analytics.risk_neutral_mean or forward)),
        normalization_integral=(
            0.0
            if result.density is None or result.density.validation.mass is None
            else float(result.density.validation.mass)
        ),
        negative_area=(
            0.0
            if result.density is None
            else float(result.density.validation.raw_negative_mass)
        ),
        wing_ordering="balanced",
        wing_signal="NO_TRADE",
        sigma_ordering="balanced",
        sigma_signal="NO_TRADE",
    )
    idle = IvDirectionalSignal(signal="NO_TRADE", p_up=0.0, p_down=0.0, difference=0.0)
    hours = hours_to_expiry(result.as_of_utc, result.expiry_utc)
    return IvSignalScanResponse(
        as_of=result.as_of_utc,
        underlying="BTC",
        expiry=expiry,
        settlement_at=result.expiry_utc,
        spot_price=result.index_usd,
        time_to_expiry_years=result.time_to_expiry_years,
        parameters=IvSignalParameters(
            tail_threshold=tail_threshold,
            band_width=band_width,
            signal_delta=signal_delta,
        ),
        density=density_points,
        iv_curve=iv_curve,
        smile=IvSignalSmile(
            points=smile_points,
            fit=fit_points,
            metrics=IvSignalSmileMetrics(
                rr_25=analytics.rr_25,
                bf_25=analytics.bf_25,
                atm_iv=analytics.atm_iv,
                iv_25_call=analytics.iv_25_call,
                iv_25_put=analytics.iv_25_put,
                delta_axis_available=any(
                    point.forward_delta is not None for point in result.smile.observed
                ),
            ),
        ),
        markers=IvSignalMarkers(
            spot=float(forward),
            tail_lower=float(forward * 0.95),
            tail_upper=float(forward * 1.05),
            band_lower=float(forward * 0.97),
            band_upper=float(forward * 1.03),
            peak_strike=float(quantiles.get("p50") or forward),
        ),
        signals=IvSignalMetrics(
            skew=idle,
            tails=idle,
            peak=IvPeakSignal(signal="NO_TRADE", peak_strike=float(forward), shift_percent=0.0),
            band=IvBandSignal(signal="NO_TRADE", p_band=0.0, p_outside=0.0, difference=0.0),
        ),
        selection=IvSignalSelectionDiagnostics(
            policy="options_surface_v1",
            iv_basis="mark_iv",
            source=str((result.feed or {}).get("source") or "options_surface"),
            verified_live_quotes=bool((result.feed or {}).get("transport") == "websocket"),
            input_rows=result.quotes.input_rows,
            expiry_rows=result.quotes.input_rows,
            valid_quote_rows=result.quotes.accepted_rows,
            selected_market_strikes=result.quotes.accepted_strikes,
            preferred_side_selections=result.quotes.preferred_side_selections,
            opposite_side_fallbacks=result.quotes.opposite_side_fallbacks,
            atm_merged_selections=result.quotes.atm_merged,
            atm_single_side_selections=0,
            synthetic_anchor_added=result.quotes.synthetic_atm_added,
            rejected_invalid_contract_rows=reasons.get("malformed_contract", 0),
            rejected_invalid_iv_rows=reasons.get("invalid_iv", 0),
            rejected_missing_quote_rows=reasons.get("missing_quote", 0),
            rejected_zero_bid_rows=reasons.get("zero_bid", 0),
            rejected_crossed_quote_rows=reasons.get("crossed_price", 0),
            rejected_stale_quote_rows=reasons.get("stale_quote", 0),
            rejected_non_open_rows=reasons.get("non_open", 0),
            rejected_missing_size_rows=reasons.get("missing_size", 0),
            rejected_invalid_iv_market_rows=reasons.get("invalid_iv_market", 0)
            + reasons.get("mark_iv_outside_market", 0)
            + reasons.get("crossed_iv", 0),
            rejected_wide_spread_rows=reasons.get("wide_spread", 0),
            rejected_low_delta_rows=reasons.get("low_delta", 0),
            rejected_low_open_interest_rows=reasons.get("low_open_interest", 0),
            methodology="options_surface_v1",
            implied_forward=result.forward.forward_usd,
            forward_source=_FORWARD_SOURCE_LEGACY.get(
                result.forward.source.value if result.forward.source else "",
                result.forward.source.value if result.forward.source else None,
            ),
            forward_pair_count=result.forward.parity_pair_count,
            otm_reference=result.forward.forward_usd,
            median_selected_iv_spread_percentage_points=0.0,
            max_selected_iv_spread_percentage_points=0.0,
            max_quote_age_seconds=30.0,
            oldest_selected_quote_age_seconds=max(
                (
                    point.quote_age_seconds or 0.0
                    for point in result.smile.observed
                ),
                default=0.0,
            ),
        ),
        curve_quality=IvSignalCurveQuality(
            level=quality_level,
            signal_eligible=False,
            negative_grid_points=0,
            grid_point_count=max(
                result.density.validation.grid_points if result.density is not None else 1,
                1,
            ),
            negative_grid_fraction=0.0,
            negative_area=(
                0.0
                if result.density is None
                else float(result.density.validation.raw_negative_mass)
            ),
            positive_area=(
                0.0
                if result.density is None or result.density.validation.mass is None
                else max(float(result.density.validation.mass), 0.0)
            ),
            normalization_integral=(
                0.0
                if result.density is None or result.density.validation.mass is None
                else float(result.density.validation.mass)
            ),
            clipping_required=False,
            sparse_center=result.quotes.center_log_gap is None,
        ),
        rnd=rnd,
        outlook=IvSignalOutlookState(
            raw_verdict="NO_TRADE",
            published_verdict="NO_TRADE",
            forming=False,
            confirmation_window=3,
            confirmation_required=2,
            raw_matches_in_window=0,
        ),
        model_verdict="NO_TRADE",
        verdict="NO_TRADE",
        suppression_reasons=_suppression_reasons(result),
        coverage=IvSignalCoverage(
            total_expiry_rows=result.quotes.input_rows,
            valid_iv_rows=result.quotes.accepted_rows,
            unique_strikes=max(result.quotes.accepted_strikes, 4)
            if result.quotes.accepted_strikes >= 4
            else 4,
            dropped_rows=result.quotes.rejected_rows,
            duplicate_rows=reasons.get("duplicate", 0),
            strike_min=min((point.strike_usd for point in observed), default=forward),
            strike_max=max((point.strike_usd for point in observed), default=forward),
            iv_coverage_ratio=0.0,
            hard_valid_strikes=result.quotes.accepted_strikes,
            hard_valid_coverage_ratio=0.0,
            spot_bracketed=True,
            forward_bracketed=result.quotes.lower_strikes > 0 and result.quotes.upper_strikes > 0,
            implied_forward=result.forward.forward_usd,
            otm_reference=result.forward.forward_usd,
            lower_strikes=result.quotes.lower_strikes,
            upper_strikes=result.quotes.upper_strikes,
            center_log_gap=result.quotes.center_log_gap,
            center_gap_exceeded=False,
            tenor_bucket=result.quotes.tenor_bucket,
        ),
        freshness=freshness,
        eligibility=IvSignalEligibility(
            is_zero_dte=hours < 24.0,
            directional_eligible=False,
            zero_dte_eligible=False,
            recommended_refresh_seconds=120 if hours < 24.0 else 600,
            hours_to_settlement=hours,
            active_signal_count=0,
            aligned_signal_count=0,
            lower_canonical_strikes=result.quotes.lower_strikes,
            upper_canonical_strikes=result.quotes.upper_strikes,
            nearest_lower_gap_percent=None,
            nearest_upper_gap_percent=None,
            requirements=IvSignalEligibilityRequirements(
                settlement_window=hours > 4.0,
                curve_quality=quality_level != "LOW",
                two_sided_coverage=result.quotes.lower_strikes > 0
                and result.quotes.upper_strikes > 0,
                quote_freshness=freshness.is_fresh,
                signal_alignment=False,
            ),
        ),
        feed=feed,
        warnings=list(result.warnings) + ["directional_fields_retired"],
        deprecated=True,
        model_status=result.model_status.value,
    )


def _smile_point(point: SmilePoint) -> OptionsSurfaceSmilePoint:
    return OptionsSurfaceSmilePoint(
        strike_usd=point.strike_usd,
        log_moneyness=point.log_moneyness,
        iv=point.iv,
        total_variance=point.total_variance,
        origin=point.origin.value,
        option_side=point.option_side,
        classification=point.classification,
        bid_iv=point.bid_iv,
        ask_iv=point.ask_iv,
        mark_iv=point.mark_iv,
        quote_age_seconds=point.quote_age_seconds,
        fit_weight=point.fit_weight,
        source=point.source,
        forward_delta=point.forward_delta,
    )


def _legacy_curve_point(point: SmilePoint) -> IvSignalCurvePoint:
    return IvSignalCurvePoint(
        strike=point.strike_usd,
        iv=point.iv,
        iv_percent=point.iv * 100.0,
        source=point.source,
        option_side=point.option_side if point.option_side in {"call", "put", "merged"} else "merged",
        synthetic=point.classification == "synthetic",
        quote_age_seconds=max(point.quote_age_seconds or 0.0, 0.0),
        bid_iv=point.bid_iv,
        ask_iv=point.ask_iv,
        mark_iv=point.mark_iv,
    )


def _legacy_smile_point(point: SmilePoint) -> IvSignalSmilePoint:
    classification = point.classification
    if classification not in {"preferred", "fallback", "synthetic"}:
        classification = "preferred"
    return IvSignalSmilePoint(
        strike=point.strike_usd,
        iv=point.iv,
        iv_percent=point.iv * 100.0,
        log_moneyness=point.log_moneyness,
        delta=point.forward_delta,
        option_side=point.option_side if point.option_side in {"call", "put", "merged", "unknown"} else "unknown",
        classification=classification,
        source=point.source,
        synthetic=classification == "synthetic",
        bid_iv=point.bid_iv,
        ask_iv=point.ask_iv,
        mark_iv=point.mark_iv,
        quote_age_seconds=point.quote_age_seconds,
    )


def _density_schema(density: DensityResult) -> OptionsSurfaceDensity:
    rejected = density.status is ModelStatus.REJECTED
    diagnostic = None
    if rejected:
        diagnostic = OptionsSurfaceDensityDiagnostic(
            label="Diagnostic only — not a valid probability distribution",
            is_valid_distribution=False,
            strikes_usd=list(density.strikes_usd),
            raw_density=list(density.raw_density),
            cdf=list(density.cdf),
        )
    return OptionsSurfaceDensity(
        status=density.status.value,
        method=density.validation.method.value,
        strikes_usd=[] if rejected else list(density.strikes_usd),
        raw_density=[] if rejected else list(density.raw_density),
        cdf=[] if rejected else list(density.cdf),
        quantiles={} if rejected else dict(density.quantiles),
        mean=None if rejected else density.mean,
        mass=density.validation.mass,
        raw_negative_mass=density.validation.raw_negative_mass,
        cdf_monotone=density.validation.cdf_monotone,
        forward_moment=density.validation.forward_moment,
        forward_moment_error=density.validation.forward_moment_error,
        truncation_warning=density.validation.truncation_warning,
        grid_points=density.validation.grid_points,
        grid_converged=density.validation.grid_converged,
        digital_atm_error=density.validation.digital_atm_error,
        notes=list(density.validation.notes),
        failed_gates=[_gate_schema(gate) for gate in density.validation.failed_gates],
        diagnostic=diagnostic,
    )


def _gate_schema(gate: ValidationGate) -> OptionsSurfaceFailedGate:
    return OptionsSurfaceFailedGate(
        code=gate.code,
        criterion=gate.criterion,
        measured=gate.measured,
        threshold=gate.threshold,
        comparison=gate.comparison,
        location=gate.location,
        severity=gate.severity,
        message=gate.message,
    )


def _display_schema(result: OptionsSurfaceResult) -> OptionsSurfaceDisplayState:
    state = result.display
    return OptionsSurfaceDisplayState(
        quote_status=state.quote_status.value,
        smile_status=state.smile_status.value,
        density_status=state.density_status.value,
        surface_display_status=state.surface_display_status.value,
        reason_codes=list(state.reason_codes),
        human_readable_reason=state.human_readable_reason,
        diagnostic_detail=state.diagnostic_detail,
        failed_checks=list(state.failed_checks),
        metric_eligibility=[
            OptionsSurfaceMetricEligibility(
                metric=item.metric,
                available=item.available,
                reason_code=item.reason_code,
                reason=item.reason,
            )
            for item in state.metric_eligibility
        ],
        served_fitter_name=state.served_fitter_name,
        served_fitter_grade=state.served_fitter_grade.value,
        research_fitter_name=state.research_fitter_name,
        research_failed_checks=list(state.research_failed_checks),
        research_human_reason=state.research_human_reason,
        customer_warning_scope=state.customer_warning_scope
        if state.customer_warning_scope in {"served", "research", "none"}
        else "none",
    )


def _research_schema(result: OptionsSurfaceResult) -> OptionsSurfaceResearchCandidate | None:
    report = result.research
    if report is None:
        return None
    return OptionsSurfaceResearchCandidate(
        fitter_name=report.fitter_name,
        fitter_grade=report.fitter_grade.value,
        status=report.status.value,
        call_monotone=report.call_monotone,
        call_convex=report.call_convex,
        violations=list(report.violations),
        worst_convexity_strike=report.worst_convexity_strike,
        notes=list(report.notes),
    )


def _quality_level(result: OptionsSurfaceResult) -> str:
    if result.model_status is ModelStatus.REJECTED:
        return "LOW"
    if result.model_status is ModelStatus.DEGRADED:
        return "CAUTION"
    return "HIGH"


def _suppression_reasons(result: OptionsSurfaceResult) -> list[str]:
    reasons = []
    if result.model_status is ModelStatus.REJECTED:
        reasons.append("surface_rejected")
    reasons.extend(result.warnings)
    return reasons
