"""Orchestrate one as-of options-surface build."""

from __future__ import annotations

from datetime import datetime
import math
from typing import Any, Mapping, Sequence

from project.options_surface.distribution.density import extract_density
from project.options_surface.forward.estimate import estimate_forward
from project.options_surface.market_data.ticker_adapter import quotes_from_scanner_rows
from project.options_surface.normalization.otm import select_otm_observations
from project.options_surface.normalization.quotes import classify_quotes
from project.options_surface.surface.fitters import (
    RawSviFitter,
    SmileFitter,
)
from project.options_surface.config import (
    SurfaceServingConfig,
    default_serving_config,
)
from project.options_surface.surface.selection import (
    attach_density_status,
    select_serving_candidate,
)
from project.options_surface.surface.smile import calibrate_smile
from project.options_surface.timeutil import (
    as_utc,
    hours_to_expiry,
    require_positive_year_fraction,
    resolve_expiry_utc,
    tenor_coverage_floors,
)
from project.options_surface.types import (
    DensityResult,
    DensityValidation,
    FitterGrade,
    ForwardEstimate,
    ModelStatus,
    NativeFutureQuote,
    NativeOptionQuote,
    OptionsSurfaceResult,
    QuoteQualitySummary,
    ResearchFitterReport,
    SourceQuality,
    SurfaceAnalytics,
    ValidationGate,
    ValidationReport,
)
from project.options_surface.analytics.metrics import compute_analytics
from project.options_surface.display import build_display_state
from project.options_surface.market_data.snapshots import SCHEMA_VERSION

MIN_OBSERVED_FOR_FIT = 4


def build_options_surface(
    rows: Sequence[Mapping[str, Any]] | Sequence[NativeOptionQuote],
    *,
    expiry: str,
    as_of_utc: datetime,
    index_usd: float,
    futures: Sequence[NativeFutureQuote] = (),
    underlying: str = "BTC",
    feed: Mapping[str, Any] | None = None,
    fitter: SmileFitter | None = None,
    serving_config: SurfaceServingConfig | None = None,
    max_quote_age_seconds: float = 30.0,
    require_iv_market: bool = True,
    require_open_state: bool = True,
    require_sizes: bool = True,
    rate: float = 0.0,
) -> OptionsSurfaceResult:
    as_of = as_utc(as_of_utc)
    config = serving_config or default_serving_config()
    require_iv_market = config.require_iv_market if serving_config is not None else require_iv_market
    require_open_state = config.require_open_state if serving_config is not None else require_open_state
    require_sizes = config.require_sizes if serving_config is not None else require_sizes
    max_quote_age_seconds = (
        config.max_quote_age_seconds if serving_config is not None else max_quote_age_seconds
    )
    if rows and isinstance(rows[0], NativeOptionQuote):
        quotes = tuple(rows)  # type: ignore[arg-type]
    else:
        quotes = quotes_from_scanner_rows(
            rows,  # type: ignore[arg-type]
            as_of_utc=as_of,
            underlying=underlying,
            default_index_usd=index_usd,
        )
    matching = [quote for quote in quotes if quote.expiry_date == expiry]
    expiry_utc, _inferred = _expiry_utc(matching, expiry)
    tau = require_positive_year_fraction(as_of, expiry_utc)

    observations = classify_quotes(
        matching,
        as_of_utc=as_of,
        expiry_date=expiry,
        max_quote_age_seconds=max_quote_age_seconds,
        require_open_state=require_open_state,
        require_iv_market=require_iv_market,
        require_sizes=require_sizes,
    )
    forward = estimate_forward(
        observations,
        as_of_utc=as_of,
        expiry_utc=expiry_utc,
        expiry_date=expiry,
        underlying=underlying,
        index_usd=index_usd,
        futures=futures,
    )
    warnings: list[str] = []
    if forward.source_quality is SourceQuality.UNAVAILABLE or not forward.forward_usd:
        warnings.append("forward_unavailable")
        return _rejected_result(
            as_of=as_of,
            expiry_utc=expiry_utc,
            underlying=underlying,
            index_usd=index_usd,
            tau=tau,
            forward=forward,
            observations=observations,
            feed=feed or {},
            warnings=warnings,
            reason="forward_unavailable",
            serving_config=config,
        )

    selected = select_otm_observations(
        observations,
        forward_usd=float(forward.forward_usd),
        time_to_expiry_years=tau,
    )
    extra_rejects = selected["extra_rejects"]
    all_obs = tuple(observations) + tuple(extra_rejects)
    observed = selected["observed"]
    synthetic = selected["synthetic"]
    train = list(observed) + list(synthetic)
    min_strikes, min_side, _gap = tenor_coverage_floors(tau)
    sparse = (
        len(observed) < min_strikes
        or int(selected["lower_strikes"]) < min_side
        or int(selected["upper_strikes"]) < min_side
        or bool(selected["center_gap_exceeded"])
        or len(observed) < MIN_OBSERVED_FOR_FIT
    )
    if sparse:
        warnings.append("insufficient_or_sparse_observations")

    engine, selection_reason, comparison, constrained_result, serve_density = select_serving_candidate(
        train,
        time_to_expiry_years=tau,
        forward_usd=float(forward.forward_usd),
        sparse=sparse,
        serving_fitter=fitter,
        serving_config=config,
    )
    smile, fitted = calibrate_smile(
        observed=observed,
        synthetic=synthetic,
        forward=forward,
        time_to_expiry_years=tau,
        as_of_utc=as_of,
        expiry_utc=expiry_utc,
        fitter=engine,
        rate=rate,
    )
    residual_summary = None if constrained_result is None else constrained_result.residual
    fit_converged = bool(fitted.diagnostics.fit_converged)
    if constrained_result is not None and engine.name == "constrained_svi":
        residual_summary = constrained_result.residual
        fit_converged = constrained_result.optimizer.converged
    served_call_monotone = smile.arbitrage.call_monotone
    served_call_convex = smile.arbitrage.call_convex
    served_density_grid = None
    if constrained_result is not None and engine.name == "constrained_svi":
        served_call_monotone = constrained_result.served_call_monotone
        served_call_convex = constrained_result.served_call_convex
        served_density_grid = constrained_result.served_density_grid

    density: DensityResult | None = None
    residual_budget_ok = True
    if constrained_result is not None and engine.name == "constrained_svi":
        residual_budget_ok = constrained_result.residual_budget_ok is not False
    if (
        serve_density
        and fitted.knot_k
        and smile.diagnostics.status is not ModelStatus.REJECTED
        and not sparse
    ):
        def iv_from_strike(strike: float) -> float | None:
            if strike <= 0 or forward.forward_usd is None:
                return None
            k = math.log(float(strike) / float(forward.forward_usd))
            iv, status = fitted.iv(k)
            if status.value == "extrapolated":
                return None
            return iv

        density = extract_density(
            iv_from_strike=iv_from_strike,
            forward_usd=float(forward.forward_usd),
            time_to_expiry_years=tau,
            as_of_utc=as_of,
            expiry_utc=expiry_utc,
            rate=rate,
            k_min=fitted.k_min,
            k_max=fitted.k_max,
        )
        if engine.name == "constrained_svi" and not residual_budget_ok:
            density = _reject_density_residual_budget(density)
            warnings.append("residual_budget_exceeded")
        if density.status is ModelStatus.REJECTED:
            warnings.append("density_rejected")
    elif not serve_density and selection_reason == "serving_disabled":
        warnings.append("serving_disabled")
    elif not serve_density and selection_reason == "shadow_compare_record_only":
        warnings.append("shadow_compare_record_only")
    elif sparse:
        warnings.append("density_skipped_sparse_book")

    analytics = compute_analytics(
        fitted=fitted,
        observed=observed,
        forward=forward,
        density=density,
        rate=rate,
    )
    if density is None or density.status is ModelStatus.REJECTED:
        analytics = _clear_probability_headlines(analytics)

    quote_summary = _quote_summary(all_obs, selected, matching)
    research = _research_candidate(
        observed=observed,
        synthetic=synthetic,
        forward=forward,
        tau=tau,
        as_of=as_of,
        expiry_utc=expiry_utc,
        rate=rate,
        sparse=sparse,
        served_name=engine.name,
    )
    display = build_display_state(
        forward=forward,
        quotes=quote_summary,
        smile=smile,
        density=density,
        analytics=analytics,
        fitter_grade=engine.grade,
        warnings=warnings,
        sparse=sparse,
        fitter_name=engine.name,
        research=research,
        serving_mode=config.mode.value,
        config_version=config.version,
        config_hash=config.config_hash,
    )
    model_status = _combine_status(
        smile_status=smile.diagnostics.status,
        density_status=density.status if density is not None else ModelStatus.REJECTED,
        sparse=sparse,
        forward_quality=forward.source_quality,
        fitter_grade=engine.grade,
    )
    validation = ValidationReport(
        as_of_utc=as_of,
        expiry_utc=expiry_utc,
        model_status=model_status,
        forward_quality=forward.source_quality,
        smile_status=smile.diagnostics.status,
        density_status=density.status if density is not None else ModelStatus.REJECTED,
        arbitrage=smile.arbitrage,
        density=density.validation if density is not None else _empty_density_validation(),
        quote_reason_counts=quote_summary.reason_counts,
        warnings=tuple(warnings),
        summary=_summary_line(model_status, forward, smile.diagnostics.status, density),
    )
    if selected["synthetic"]:
        warnings.append("synthetic_atm_anchor_inserted")
    if int(selected["opposite_side_fallbacks"]) > 0:
        warnings.append(
            f"opposite_side_fallback:{selected['opposite_side_fallbacks']}"
        )

    density_status = density.status if density is not None else ModelStatus.REJECTED
    comparison = attach_density_status(
        comparison,
        served_name=engine.name,
        density_status=density_status,
    )
    selected_model_status = "selected" if any(row.selected for row in comparison if row.fitter_name == engine.name) else (
        "explicit" if fitter is not None else "rejected"
    )
    return OptionsSurfaceResult(
        schema_version=SCHEMA_VERSION,
        as_of_utc=as_of,
        expiry_utc=expiry_utc,
        underlying=underlying,
        index_usd=float(index_usd),
        time_to_expiry_years=float(tau),
        forward=forward,
        quotes=quote_summary,
        smile=smile,
        density=density,
        analytics=analytics,
        validation=validation,
        model_status=model_status,
        fitter_name=engine.name,
        fitter_grade=engine.grade,
        feed=dict(feed or {}),
        warnings=tuple(dict.fromkeys(warnings)),
        display=display,
        rejected_observations=tuple(item for item in all_obs if not item.accepted),
        accepted_observations=tuple(item for item in all_obs if item.accepted),
        research=research,
        selection_reason=selection_reason,
        fit_residual_summary=residual_summary,
        fit_converged=fit_converged,
        served_call_monotone=served_call_monotone,
        served_call_convex=served_call_convex,
        served_density_grid=served_density_grid,
        selected_model_status=selected_model_status,
        candidate_comparison=comparison,
        serving_mode=config.mode.value,
        config_version=config.version,
        config_hash=config.config_hash,
        primary_failure_category=display.primary_failure_category,
    )


def _expiry_utc(quotes: Sequence[NativeOptionQuote], expiry: str):
    for quote in quotes:
        if quote.expiry_utc is not None and not quote.expiry_timestamp_inferred:
            return quote.expiry_utc, False
    return resolve_expiry_utc(expiry)


def _quote_summary(observations, selected, matching) -> QuoteQualitySummary:
    reason_counts: dict[str, int] = {}
    accepted = 0
    for item in observations:
        if item.accepted:
            accepted += 1
        elif item.rejection_reason is not None:
            key = item.rejection_reason.value
            reason_counts[key] = reason_counts.get(key, 0) + 1
    return QuoteQualitySummary(
        input_rows=len(matching),
        accepted_rows=accepted,
        rejected_rows=len(matching) - accepted,
        accepted_strikes=len(selected["observed"]),
        preferred_side_selections=int(selected["preferred_side_selections"]),
        opposite_side_fallbacks=int(selected["opposite_side_fallbacks"]),
        atm_merged=int(selected["atm_merged"]),
        synthetic_atm_added=bool(selected["synthetic"]),
        reason_counts=reason_counts,
        lower_strikes=int(selected["lower_strikes"]),
        upper_strikes=int(selected["upper_strikes"]),
        center_log_gap=selected["center_log_gap"],
        tenor_bucket=str(selected["tenor_bucket"]),
    )


def _combine_status(
    *,
    smile_status: ModelStatus,
    density_status: ModelStatus,
    sparse: bool,
    forward_quality: SourceQuality,
    fitter_grade: FitterGrade,
) -> ModelStatus:
    if fitter_grade is FitterGrade.RESEARCH:
        return ModelStatus.RESEARCH
    if sparse or smile_status is ModelStatus.REJECTED or density_status is ModelStatus.REJECTED:
        return ModelStatus.REJECTED
    if (
        smile_status is ModelStatus.DEGRADED
        or density_status is ModelStatus.DEGRADED
        or forward_quality in {SourceQuality.LOW, SourceQuality.UNAVAILABLE}
        or fitter_grade is FitterGrade.DIAGNOSTIC
        or fitter_grade is FitterGrade.DIAGNOSTIC_CANDIDATE
    ):
        return ModelStatus.DEGRADED
    return ModelStatus.ACCEPTED


def _clear_probability_headlines(analytics: SurfaceAnalytics) -> SurfaceAnalytics:
    return SurfaceAnalytics(
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
        p_below_forward=None,
        p_above_forward=None,
        p_left_5=None,
        p_right_5=None,
        p_left_sigma=None,
        p_right_sigma=None,
        central_range_50=None,
        central_range_90=None,
        risk_neutral_mean=None,
        k_25_call=analytics.k_25_call,
        k_25_put=analytics.k_25_put,
    )


def _research_candidate(
    *,
    observed,
    synthetic,
    forward,
    tau,
    as_of,
    expiry_utc,
    rate,
    sparse: bool,
    served_name: str,
) -> ResearchFitterReport | None:
    if sparse or served_name == "svi_raw" or not observed:
        return None
    try:
        research_smile, _fitted = calibrate_smile(
            observed=observed,
            synthetic=synthetic,
            forward=forward,
            time_to_expiry_years=tau,
            as_of_utc=as_of,
            expiry_utc=expiry_utc,
            fitter=RawSviFitter(),
            rate=rate,
        )
    except Exception:
        return None
    arb = research_smile.arbitrage
    return ResearchFitterReport(
        fitter_name=research_smile.diagnostics.fitter_name,
        fitter_grade=research_smile.diagnostics.fitter_grade,
        status=research_smile.diagnostics.status,
        call_monotone=arb.call_monotone,
        call_convex=arb.call_convex,
        violations=arb.violations,
        worst_convexity_strike=arb.worst_convexity_strike,
        notes=research_smile.diagnostics.notes,
    )


def _reject_density_residual_budget(density: DensityResult) -> DensityResult:
    """Residual budget is a selection gate, not a substitute for convexity."""
    validation = density.validation
    gates = list(validation.failed_gates)
    notes = list(validation.notes)
    if not any(gate.code == "residual_budget_exceeded" for gate in gates):
        gates.append(
            ValidationGate(
                code="residual_budget_exceeded",
                criterion="weighted_iv_rms",
                measured=None,
                threshold=None,
                comparison="gt",
                location=None,
                severity="reject",
                message="Constrained smile residual exceeded the documented quote-quality budget",
            )
        )
    if "residual_budget_exceeded" not in notes:
        notes.append("residual_budget_exceeded")
    if "density_rejected" not in notes:
        notes.append("density_rejected")
    rejected = DensityValidation(
        status=ModelStatus.REJECTED,
        method=validation.method,
        mass=validation.mass,
        raw_negative_mass=validation.raw_negative_mass,
        nonnegative=validation.nonnegative,
        cdf_monotone=validation.cdf_monotone,
        cdf_start=validation.cdf_start,
        cdf_end=validation.cdf_end,
        forward_moment=validation.forward_moment,
        forward_moment_error=validation.forward_moment_error,
        edge_mass=validation.edge_mass,
        truncation_warning=validation.truncation_warning,
        grid_points=validation.grid_points,
        grid_converged=validation.grid_converged,
        digital_atm_error=validation.digital_atm_error,
        notes=tuple(notes),
        failed_gates=tuple(gates),
    )
    return DensityResult(
        as_of_utc=density.as_of_utc,
        expiry_utc=density.expiry_utc,
        forward_usd=density.forward_usd,
        status=ModelStatus.REJECTED,
        strikes_usd=density.strikes_usd,
        raw_density=density.raw_density,
        cdf=density.cdf,
        quantiles={},
        mean=None,
        validation=rejected,
        display_smooth=density.display_smooth,
    )


def _empty_density_validation():
    from project.options_surface.types import DensityMethod, DensityValidation

    return DensityValidation(
        status=ModelStatus.REJECTED,
        method=DensityMethod.BREEDEN_LITZENBERGER_BLACK76,
        mass=None,
        raw_negative_mass=0.0,
        nonnegative=False,
        cdf_monotone=False,
        cdf_start=None,
        cdf_end=None,
        forward_moment=None,
        forward_moment_error=None,
        edge_mass=None,
        truncation_warning=True,
        grid_points=0,
        grid_converged=None,
        digital_atm_error=None,
        notes=("density_not_built",),
    )


def _summary_line(model_status, forward, smile_status, density) -> str:
    dens = density.status.value if density is not None else "absent"
    src = forward.source.value if forward.source else "none"
    return (
        f"{model_status.value} · forward {src}/{forward.source_quality.value} · "
        f"smile {smile_status.value} · density {dens}"
    )


def _rejected_result(
    *,
    as_of,
    expiry_utc,
    underlying,
    index_usd,
    tau,
    forward,
    observations,
    feed,
    warnings,
    reason,
    serving_config: SurfaceServingConfig | None = None,
) -> OptionsSurfaceResult:
    from project.options_surface.types import (
        ArbitrageReport,
        SmileFitDiagnostics,
        SmileSlice,
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
        violations=(reason,),
    )
    empty_fit = SmileFitDiagnostics(
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
        notes=(reason,),
    )
    selected = {
        "observed": (),
        "synthetic": (),
        "preferred_side_selections": 0,
        "opposite_side_fallbacks": 0,
        "atm_merged": 0,
        "lower_strikes": 0,
        "upper_strikes": 0,
        "center_log_gap": None,
        "tenor_bucket": "unknown",
    }
    smile = SmileSlice(
        as_of_utc=as_of,
        expiry_utc=expiry_utc,
        underlying=underlying,
        forward=forward,
        time_to_expiry_years=tau,
        observed=(),
        synthetic=(),
        fit=(),
        diagnostics=empty_fit,
        arbitrage=empty_arb,
    )
    quotes = _quote_summary(observations, selected, observations)
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
        k_25_call=None,
        k_25_put=None,
    )
    config = serving_config or default_serving_config()
    display = build_display_state(
        forward=forward,
        quotes=quotes,
        smile=smile,
        density=None,
        analytics=analytics,
        fitter_grade=FitterGrade.DIAGNOSTIC,
        warnings=warnings,
        sparse=True,
        fitter_name="none",
        research=None,
        serving_mode=config.mode.value,
        config_version=config.version,
        config_hash=config.config_hash,
    )
    validation = ValidationReport(
        as_of_utc=as_of,
        expiry_utc=expiry_utc,
        model_status=ModelStatus.REJECTED,
        forward_quality=forward.source_quality,
        smile_status=ModelStatus.REJECTED,
        density_status=ModelStatus.REJECTED,
        arbitrage=empty_arb,
        density=_empty_density_validation(),
        quote_reason_counts=quotes.reason_counts,
        warnings=tuple(warnings),
        summary=_summary_line(ModelStatus.REJECTED, forward, ModelStatus.REJECTED, None),
    )
    return OptionsSurfaceResult(
        schema_version=SCHEMA_VERSION,
        as_of_utc=as_of,
        expiry_utc=expiry_utc,
        underlying=underlying,
        index_usd=float(index_usd),
        time_to_expiry_years=float(tau),
        forward=forward,
        quotes=quotes,
        smile=smile,
        density=None,
        analytics=analytics,
        validation=validation,
        model_status=ModelStatus.REJECTED,
        fitter_name="none",
        fitter_grade=FitterGrade.DIAGNOSTIC,
        feed=dict(feed),
        warnings=tuple(warnings),
        display=display,
        rejected_observations=tuple(item for item in observations if not item.accepted),
        accepted_observations=tuple(item for item in observations if item.accepted),
        selection_reason="forward_unavailable",
        fit_residual_summary=None,
        fit_converged=False,
        served_call_monotone=None,
        served_call_convex=None,
        served_density_grid=None,
        selected_model_status="rejected",
        candidate_comparison=(),
        serving_mode=config.mode.value,
        config_version=config.version,
        config_hash=config.config_hash,
        primary_failure_category=display.primary_failure_category,
    )
