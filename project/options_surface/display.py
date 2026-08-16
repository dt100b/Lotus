"""Explicit customer-facing display state and metric eligibility.

A smile may be usable while the derived density is rejected. Frontends
must read these fields rather than inferring availability from nulls.
"""

from __future__ import annotations

from typing import Mapping, Sequence

from project.options_surface.types import (
    DensityDisplayStatus,
    DensityResult,
    DensityValidation,
    FitterGrade,
    ForwardEstimate,
    MetricEligibility,
    ModelStatus,
    QuoteQualitySummary,
    QuoteStatus,
    SmileSlice,
    SourceQuality,
    SurfaceAnalytics,
    SurfaceDisplayState,
    SurfaceDisplayStatus,
    ValidationGate,
)

CUSTOMER_REASONS: Mapping[str, str] = {
    "cdf_not_monotone": (
        "Distribution unavailable: the implied density was not a valid "
        "monotone probability distribution."
    ),
    "negative_density_mass": (
        "Distribution unavailable: negative density mass exceeded the tolerance."
    ),
    "mass_out_of_range": (
        "Distribution unavailable: the density did not integrate to a usable "
        "probability mass."
    ),
    "forward_moment": (
        "Distribution unavailable: the density mean disagreed with the selected "
        "forward."
    ),
    "grid_not_converged": (
        "Distribution unavailable: results changed materially when the strike "
        "grid was refined."
    ),
    "digital_atm": (
        "Distribution unavailable: the density disagreed with the digital-spread "
        "probability at the forward."
    ),
    "insufficient_grid": (
        "Distribution unavailable: the strike grid was too coarse to validate "
        "a density."
    ),
    "insufficient_wing_coverage": (
        "Distribution unavailable: insufficient observed wing coverage for "
        "reliable tail estimates."
    ),
    "density_rejected": "Unavailable — distribution validation failed",
    "density_not_built": "Unavailable — distribution validation failed",
    "forward_unavailable": "No accepted options-implied forward is available for this expiry.",
    "sparse_quotes": "Unavailable — insufficient two-sided wing quotes",
    "smile_rejected": "Unavailable — smile calibration failed",
    "rr_put_outside": "Unavailable — 25Δ put lies outside observed smile coverage",
    "rr_call_outside": "Unavailable — 25Δ call lies outside observed smile coverage",
    "rr_unsolved": "Unavailable — 25Δ roots did not solve inside observed smile coverage",
    "atm_outside_coverage": "Unavailable — ATM query is outside observed smile coverage",
    "smile_unavailable": "Unavailable — no accepted smile",
}

FAILED_CHECK_LABELS: Mapping[str, str] = {
    "cdf_not_monotone": "Density CDF was not monotone",
    "negative_density_mass": "Negative density mass exceeded tolerance",
    "mass_out_of_range": "Density mass outside tolerance",
    "forward_moment": "Density mean disagreed with the selected forward",
    "grid_not_converged": "Density changed when the strike grid was refined",
    "digital_atm": "Density disagreed with the ATM digital spread",
    "insufficient_grid": "Strike grid too coarse to validate a density",
    "call_not_convex_in_strike": "Call-price convexity failed",
    "call_not_decreasing_in_strike": "Call prices were not decreasing in strike",
    "insufficient_or_sparse_observations": "Insufficient two-sided wing quotes",
    "forward_unavailable": "No accepted options-implied forward",
}

# Allowed (quote, smile, density) → surface_display_status combinations.
# Smile research is treated like a diagnostic smile for display.
ALLOWED_DISPLAY_COMBINATIONS: tuple[tuple[str, str, str, str], ...] = (
    ("accepted", "accepted", "accepted", "ready"),
    ("accepted", "accepted", "degraded", "degraded"),
    ("accepted", "accepted", "rejected", "rejected"),
    ("accepted", "accepted", "unavailable", "unavailable"),
    ("accepted", "degraded", "accepted", "degraded"),
    ("accepted", "degraded", "degraded", "degraded"),
    ("accepted", "degraded", "rejected", "rejected"),
    ("accepted", "degraded", "unavailable", "unavailable"),
    ("accepted", "research", "accepted", "degraded"),
    ("accepted", "research", "degraded", "degraded"),
    ("accepted", "research", "rejected", "rejected"),
    ("accepted", "research", "unavailable", "unavailable"),
    ("accepted", "rejected", "rejected", "rejected"),
    ("accepted", "rejected", "unavailable", "rejected"),
    ("accepted", "rejected", "unavailable", "unavailable"),
    ("degraded", "accepted", "accepted", "degraded"),
    ("degraded", "accepted", "degraded", "degraded"),
    ("degraded", "accepted", "rejected", "rejected"),
    ("degraded", "degraded", "accepted", "degraded"),
    ("degraded", "degraded", "degraded", "degraded"),
    ("degraded", "degraded", "rejected", "rejected"),
    ("degraded", "research", "accepted", "degraded"),
    ("degraded", "research", "degraded", "degraded"),
    ("degraded", "research", "rejected", "rejected"),
    ("degraded", "rejected", "rejected", "rejected"),
    ("degraded", "rejected", "unavailable", "unavailable"),
    ("rejected", "rejected", "rejected", "rejected"),
    ("rejected", "rejected", "unavailable", "rejected"),
    ("rejected", "rejected", "unavailable", "unavailable"),
    ("rejected", "degraded", "rejected", "rejected"),
    ("rejected", "degraded", "unavailable", "rejected"),
    ("rejected", "degraded", "unavailable", "unavailable"),
    ("rejected", "research", "unavailable", "rejected"),
    ("degraded", "rejected", "unavailable", "rejected"),
    ("degraded", "degraded", "unavailable", "rejected"),
    ("accepted", "degraded", "unavailable", "rejected"),
)


def build_display_state(
    *,
    forward: ForwardEstimate,
    quotes: QuoteQualitySummary,
    smile: SmileSlice,
    density: DensityResult | None,
    analytics: SurfaceAnalytics,
    fitter_grade: FitterGrade,
    warnings: Sequence[str],
    sparse: bool,
) -> SurfaceDisplayState:
    quote_status = _quote_status(quotes, sparse=sparse, forward=forward)
    smile_status = smile.diagnostics.status
    density_status = _density_status(density, forward)
    surface_status = _surface_status(
        quote_status=quote_status,
        smile_status=smile_status,
        density_status=density_status,
        fitter_grade=fitter_grade,
        forward=forward,
    )
    codes = _reason_codes(
        quote_status=quote_status,
        smile=smile,
        density=density,
        density_status=density_status,
        warnings=warnings,
        sparse=sparse,
        forward=forward,
    )
    human = _human_reason(codes, density_status=density_status, forward=forward)
    detail = _diagnostic_detail(
        codes=codes,
        forward=forward,
        smile=smile,
        density=density,
        fitter_grade=fitter_grade,
    )
    checks = _failed_checks(codes, smile=smile, density=density)
    eligibility = build_metric_eligibility(
        forward=forward,
        quotes=quotes,
        smile=smile,
        density_status=density_status,
        analytics=analytics,
    )
    return SurfaceDisplayState(
        quote_status=quote_status,
        smile_status=smile_status,
        density_status=density_status,
        surface_display_status=surface_status,
        reason_codes=codes,
        human_readable_reason=human,
        diagnostic_detail=detail,
        failed_checks=checks,
        metric_eligibility=eligibility,
    )


def build_metric_eligibility(
    *,
    forward: ForwardEstimate,
    quotes: QuoteQualitySummary,
    smile: SmileSlice,
    density_status: DensityDisplayStatus,
    analytics: SurfaceAnalytics,
) -> tuple[MetricEligibility, ...]:
    density_ok = density_status is DensityDisplayStatus.ACCEPTED
    forward_ok = forward.forward_usd is not None and forward.source_quality is not SourceQuality.UNAVAILABLE
    atm_inside = _atm_inside_coverage(smile)
    smile_usable = smile.diagnostics.status is not ModelStatus.REJECTED
    atm_ok = smile_usable and atm_inside and analytics.atm_iv is not None
    rr_code, rr_ok = _delta_metric_gate(smile, analytics)
    density_reason = None if density_ok else (
        "density_rejected"
        if density_status is DensityDisplayStatus.REJECTED
        else "density_not_built"
    )
    return (
        _metric("forward", forward_ok, None if forward_ok else "forward_unavailable"),
        _metric("index", True, None),
        _metric("quote_coverage", True, None),
        _metric(
            "atm_iv",
            atm_ok,
            None if atm_ok else ("atm_outside_coverage" if smile_usable else "smile_unavailable"),
        ),
        _metric(
            "implied_move_1sd",
            atm_ok,
            None if atm_ok else ("atm_outside_coverage" if smile_usable else "smile_unavailable"),
        ),
        _metric("rr_25", rr_ok, None if rr_ok else rr_code),
        _metric("bf_25", rr_ok, None if rr_ok else rr_code),
        _metric("density_chart", density_ok, density_reason),
        _metric("median", density_ok, density_reason),
        _metric("mode", density_ok, density_reason),
        _metric("central_range_50", density_ok, density_reason),
        _metric("central_range_90", density_ok, density_reason),
        _metric("tail_probabilities", density_ok, density_reason),
        _metric("digital_probabilities", density_ok, density_reason),
    )


def eligibility_map(state: SurfaceDisplayState) -> dict[str, MetricEligibility]:
    return {item.metric: item for item in state.metric_eligibility}


def customer_reason(code: str | None) -> str:
    if not code:
        return "Unavailable"
    return CUSTOMER_REASONS.get(code, "Unavailable")


def _quote_status(
    quotes: QuoteQualitySummary,
    *,
    sparse: bool,
    forward: ForwardEstimate,
) -> QuoteStatus:
    if forward.source_quality is SourceQuality.UNAVAILABLE or not forward.forward_usd:
        return QuoteStatus.REJECTED
    if quotes.accepted_strikes <= 0 or sparse:
        return QuoteStatus.REJECTED
    if (
        quotes.synthetic_atm_added
        or quotes.opposite_side_fallbacks > 0
        or quotes.rejected_rows > 0
        or quotes.center_log_gap is None
    ):
        return QuoteStatus.DEGRADED
    return QuoteStatus.ACCEPTED


def _density_status(
    density: DensityResult | None,
    forward: ForwardEstimate,
) -> DensityDisplayStatus:
    if forward.source_quality is SourceQuality.UNAVAILABLE or not forward.forward_usd:
        return DensityDisplayStatus.UNAVAILABLE
    if density is None:
        return DensityDisplayStatus.UNAVAILABLE
    if density.status is ModelStatus.REJECTED:
        return DensityDisplayStatus.REJECTED
    if density.status is ModelStatus.DEGRADED:
        return DensityDisplayStatus.DEGRADED
    if density.status is ModelStatus.RESEARCH:
        return DensityDisplayStatus.DEGRADED
    return DensityDisplayStatus.ACCEPTED


def _surface_status(
    *,
    quote_status: QuoteStatus,
    smile_status: ModelStatus,
    density_status: DensityDisplayStatus,
    fitter_grade: FitterGrade,
    forward: ForwardEstimate,
) -> SurfaceDisplayStatus:
    if forward.source_quality is SourceQuality.UNAVAILABLE or not forward.forward_usd:
        return SurfaceDisplayStatus.UNAVAILABLE
    if (
        quote_status is QuoteStatus.REJECTED
        or smile_status is ModelStatus.REJECTED
        or density_status is DensityDisplayStatus.REJECTED
        or density_status is DensityDisplayStatus.UNAVAILABLE
    ):
        return SurfaceDisplayStatus.REJECTED
    if (
        quote_status is QuoteStatus.DEGRADED
        or smile_status in {ModelStatus.DEGRADED, ModelStatus.RESEARCH}
        or density_status is DensityDisplayStatus.DEGRADED
        or fitter_grade is not FitterGrade.PRODUCTION
    ):
        return SurfaceDisplayStatus.DEGRADED
    return SurfaceDisplayStatus.READY


def _reason_codes(
    *,
    quote_status: QuoteStatus,
    smile: SmileSlice,
    density: DensityResult | None,
    density_status: DensityDisplayStatus,
    warnings: Sequence[str],
    sparse: bool,
    forward: ForwardEstimate,
) -> tuple[str, ...]:
    codes: list[str] = []
    if forward.source_quality is SourceQuality.UNAVAILABLE or not forward.forward_usd:
        codes.append("forward_unavailable")
    if sparse or "insufficient_or_sparse_observations" in warnings:
        codes.append("insufficient_or_sparse_observations")
    codes.extend(smile.arbitrage.violations)
    validation = density.validation if density is not None else None
    if validation is not None:
        for gate in validation.failed_gates:
            if gate.severity in {"reject", "degrade"} and gate.code not in codes:
                codes.append(gate.code)
        for note in validation.notes:
            key = note.split("=", 1)[0]
            if key in CUSTOMER_REASONS or key in FAILED_CHECK_LABELS:
                if key not in codes:
                    codes.append(key)
    if density_status is DensityDisplayStatus.REJECTED and "density_rejected" not in codes:
        codes.append("density_rejected")
    if density_status is DensityDisplayStatus.UNAVAILABLE and density is None:
        codes.append("density_not_built")
    if quote_status is QuoteStatus.REJECTED and "insufficient_or_sparse_observations" not in codes:
        codes.append("sparse_quotes")
    return tuple(dict.fromkeys(codes))


def _human_reason(
    codes: Sequence[str],
    *,
    density_status: DensityDisplayStatus,
    forward: ForwardEstimate,
) -> str:
    if "forward_unavailable" in codes or (
        forward.source_quality is SourceQuality.UNAVAILABLE or not forward.forward_usd
    ):
        return CUSTOMER_REASONS["forward_unavailable"]
    priority = (
        "cdf_not_monotone",
        "negative_density_mass",
        "mass_out_of_range",
        "forward_moment",
        "grid_not_converged",
        "digital_atm",
        "insufficient_grid",
        "insufficient_wing_coverage",
        "density_rejected",
        "insufficient_or_sparse_observations",
        "sparse_quotes",
        "call_not_convex_in_strike",
    )
    for code in priority:
        if code in codes:
            return CUSTOMER_REASONS.get(code, FAILED_CHECK_LABELS.get(code, CUSTOMER_REASONS["density_rejected"]))
    if density_status is DensityDisplayStatus.REJECTED:
        return CUSTOMER_REASONS["density_rejected"]
    if density_status is DensityDisplayStatus.UNAVAILABLE:
        return CUSTOMER_REASONS["density_not_built"]
    if codes:
        return CUSTOMER_REASONS.get(codes[0], "Surface quality is degraded. Treat displayed metrics as diagnostic.")
    return "Market-implied surface is ready for this expiry."


def _failed_checks(
    codes: Sequence[str],
    *,
    smile: SmileSlice,
    density: DensityResult | None,
) -> tuple[str, ...]:
    labels: list[str] = []
    for code in codes:
        label = FAILED_CHECK_LABELS.get(code)
        if label and label not in labels:
            labels.append(label)
    for violation in smile.arbitrage.violations:
        label = FAILED_CHECK_LABELS.get(violation)
        if label and label not in labels:
            labels.append(label)
    if density is not None:
        for gate in density.validation.failed_gates:
            if gate.severity == "reject":
                label = FAILED_CHECK_LABELS.get(gate.code, gate.message)
                if label and label not in labels:
                    labels.append(label)
    return tuple(labels)


def _diagnostic_detail(
    *,
    codes: Sequence[str],
    forward: ForwardEstimate,
    smile: SmileSlice,
    density: DensityResult | None,
    fitter_grade: FitterGrade,
) -> str:
    parts: list[str] = [
        f"fitter={smile.diagnostics.fitter_name}/{fitter_grade.value}",
        f"forward={forward.source.value if forward.source else 'none'}/{forward.source_quality.value}",
    ]
    if forward.forward_usd is not None:
        parts.append(f"F_T={forward.forward_usd:.4f}")
    if density is not None:
        validation = density.validation
        parts.append(f"density_status={validation.status.value}")
        if validation.mass is not None:
            parts.append(f"mass={validation.mass:.6f}")
        parts.append(f"raw_negative_mass={validation.raw_negative_mass:.6g}")
        if validation.forward_moment_error is not None:
            parts.append(f"forward_moment_error={validation.forward_moment_error:.6g}")
        if validation.digital_atm_error is not None:
            parts.append(f"digital_atm_error={validation.digital_atm_error:.6g}")
        parts.append(f"grid_points={validation.grid_points}")
        parts.append(f"grid_converged={validation.grid_converged}")
        for gate in validation.failed_gates:
            location = f" @ {gate.location}" if gate.location else ""
            measured = "n/a" if gate.measured is None else f"{gate.measured:.6g}"
            threshold = "n/a" if gate.threshold is None else f"{gate.threshold:.6g}"
            parts.append(
                f"gate {gate.code}: {gate.criterion}={measured} {gate.comparison} {threshold}{location}"
            )
    if smile.arbitrage.worst_convexity_strike is not None:
        parts.append(
            f"worst_convexity_strike={smile.arbitrage.worst_convexity_strike:.2f} "
            f"min_butterfly={smile.arbitrage.min_butterfly}"
        )
    if smile.diagnostics.k_min is not None and smile.diagnostics.k_max is not None:
        parts.append(f"k_coverage=[{smile.diagnostics.k_min:.6f}, {smile.diagnostics.k_max:.6f}]")
    if codes:
        parts.append("codes=" + ",".join(codes))
    return "; ".join(parts)


def _delta_metric_gate(
    smile: SmileSlice,
    analytics: SurfaceAnalytics,
) -> tuple[str, bool]:
    if smile.diagnostics.status is ModelStatus.REJECTED:
        return "smile_unavailable", False
    call_ok = analytics.iv_25_call is not None and analytics.k_25_call is not None
    put_ok = analytics.iv_25_put is not None and analytics.k_25_put is not None
    if call_ok and put_ok and _k_inside(smile, analytics.k_25_call) and _k_inside(smile, analytics.k_25_put):
        return "ok", True
    if call_ok and not put_ok:
        return "rr_put_outside", False
    if put_ok and not call_ok:
        return "rr_call_outside", False
    return "rr_unsolved", False


def _atm_inside_coverage(smile: SmileSlice) -> bool:
    return _k_inside(smile, 0.0)


def _k_inside(smile: SmileSlice, k: float | None) -> bool:
    if k is None or smile.diagnostics.k_min is None or smile.diagnostics.k_max is None:
        return False
    return smile.diagnostics.k_min - 1e-12 <= k <= smile.diagnostics.k_max + 1e-12


def _metric(name: str, available: bool, code: str | None) -> MetricEligibility:
    return MetricEligibility(
        metric=name,
        available=available,
        reason_code=None if available else code,
        reason=None if available else customer_reason(code),
    )


def reject_gates(validation: DensityValidation) -> tuple[ValidationGate, ...]:
    return tuple(gate for gate in validation.failed_gates if gate.severity == "reject")
