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
    TotalVariancePchipFitter,
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
    FitterGrade,
    ForwardEstimate,
    ModelStatus,
    NativeFutureQuote,
    NativeOptionQuote,
    OptionsSurfaceResult,
    QuoteQualitySummary,
    RejectionReason,
    ResearchFitterReport,
    SourceQuality,
    SurfaceAnalytics,
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
    max_quote_age_seconds: float = 30.0,
    require_iv_market: bool = True,
    require_open_state: bool = True,
    require_sizes: bool = True,
    rate: float = 0.0,
) -> OptionsSurfaceResult:
    as_of = as_utc(as_of_utc)
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
    engine = fitter or TotalVariancePchipFitter()
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

    density: DensityResult | None = None
    if (
        fitted.knot_k
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
        if density.status is ModelStatus.REJECTED:
            warnings.append("density_rejected")
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
    )
