"""Versioned capture schema identifiers and reason-code families."""

from __future__ import annotations

CAPTURE_SCHEMA_VERSION = "options_surface_capture.v1"
LEGACY_RESULT_SCHEMA = "options_surface.v1"
SUPPORTED_CAPTURE_SCHEMAS = frozenset({CAPTURE_SCHEMA_VERSION})
IDENTIFIED_INCOMPATIBLE_SCHEMAS = frozenset({LEGACY_RESULT_SCHEMA})

REQUIRED_CAPTURE_FIELDS = (
    "schema_version",
    "snapshot_id",
    "capture_utc",
    "as_of_utc",
    "underlying",
    "expiry",
    "serving_mode",
    "config_version",
    "config_hash",
    "market_inputs",
    "serving",
)

GATE_REASON_FAMILIES = {
    "insufficient_observations": "insufficient_observations",
    "insufficient_or_sparse_observations": "insufficient_observations",
    "sparse_quotes": "insufficient_observations",
    "coverage_too_narrow": "insufficient_wing_coverage",
    "insufficient_wing_coverage": "insufficient_wing_coverage",
    "optimizer_failed": "fit_convergence_failure",
    "ls_not_converged": "fit_convergence_failure",
    "projection_failed": "fit_convergence_failure",
    "no_eligible_constrained_start": "fit_convergence_failure",
    "residual_budget_exceeded": "residual_budget_failure",
    "call_not_decreasing_in_strike": "call_monotonicity_failure",
    "served_call_not_decreasing": "call_monotonicity_failure",
    "call_not_convex_in_strike": "call_convexity_failure",
    "served_call_not_convex": "call_convexity_failure",
    "cdf_not_monotone": "cdf_failure",
    "negative_density_mass": "negative_mass_failure",
    "mass_out_of_range": "mass_failure",
    "forward_moment": "forward_moment_failure",
    "digital_atm": "digital_reconciliation_failure",
    "grid_not_converged": "grid_convergence_failure",
    "stale_quote": "stale_feed",
    "stale_feed": "stale_feed",
    "forward_unavailable": "market_data_failure",
    "density_not_built": "market_data_failure",
}

ANALYZER_REASON_COLUMNS = (
    "insufficient_observations",
    "insufficient_wing_coverage",
    "fit_convergence_failure",
    "residual_budget_failure",
    "call_monotonicity_failure",
    "call_convexity_failure",
    "cdf_failure",
    "negative_mass_failure",
    "mass_failure",
    "forward_moment_failure",
    "digital_reconciliation_failure",
    "grid_convergence_failure",
    "stale_feed",
    "market_data_failure",
)

RUBRIC_METRIC_KEYS = (
    "unique_snapshot_count",
    "calendar_span_days",
    "distinct_expiry_count",
    "tenor_bucket_counts",
    "vol_regime_counts",
    "matching_future_high_quality_share",
    "fit_convergence_rate",
    "density_accepted_rate",
    "density_degraded_rate",
    "density_rejected_rate",
    "density_unavailable_market_data_rate",
    "residual_budget_pass_rate",
    "hard_gate_pass_rate",
    "unexplained_adjacent_instability_rate",
    "parameter_stability_when_inputs_stable",
    "digital_reconciliation_stability",
    "grid_convergence_stability",
    "accepted_later_invalid_count",
    "data_quality_rejection_rate",
    "model_driven_rejection_rate",
    "pchip_fail_constrained_pass_count",
    "constrained_fail_pchip_pass_count",
)


def family_for_code(code: str) -> str | None:
    return GATE_REASON_FAMILIES.get(str(code))
