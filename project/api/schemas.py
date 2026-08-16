from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ExpiryListResponse(BaseModel):
    as_of: datetime
    underlying: Literal["BTC"]
    spot_price: float
    expiries: list[str]


class GexPoint(BaseModel):
    strike: float
    net_gex: float
    call_gex: float
    put_gex: float
    value: float


class GexProfileResponse(BaseModel):
    as_of: datetime
    underlying: Literal["BTC"]
    spot_price: float
    selected_expiry: str
    view: Literal["net", "call", "put"]
    expiries: list[str]
    points: list[GexPoint]
    # Default remains exclude_otc_prints (production). include_otc_prints when requested.
    ledger_policy: Literal["exclude_otc_prints", "include_otc_prints"] = "exclude_otc_prints"
    include_otc_prints_available: bool = False


class DashboardConfigResponse(BaseModel):
    app_name: str
    refresh_seconds: int = Field(ge=1)
    contract_version: str
    default_expiry: str
    default_view: Literal["net", "call", "put"]
    supported_views: list[Literal["net", "call", "put"]]
    # Presentation hint: secondary include-OTC chart mode is supported when snapshot has it.
    supported_ledger_policies: list[Literal["exclude_otc_prints", "include_otc_prints"]] = Field(
        default_factory=lambda: ["exclude_otc_prints", "include_otc_prints"]
    )


class HealthResponse(BaseModel):
    status: Literal["ok"]
    underlying: Literal["BTC"]
    as_of: datetime
    spot_price: float
    row_count: int = Field(ge=0)
    snapshot_age_seconds: float = Field(ge=0)
    freshness_threshold_seconds: int = Field(ge=1)
    is_fresh: bool
    contract_version: str
    snapshot_provenance: str


class GexHeatmapCell(BaseModel):
    strike: float
    net_gex: float


class GexHeatmapSample(BaseModel):
    ts_ms: int
    spot: float
    net_gex: float
    cells: list[GexHeatmapCell]


class GexHeatmapSurfaceMeta(BaseModel):
    retention_ms: int
    methodology: str
    note: str
    version: str


class GexHeatmapSurfaceResponse(BaseModel):
    """Time × strike net-GEX surface for the gamma heatmap (from gex_window_history)."""

    as_of_ms: int
    version: str
    sample_count: int = Field(ge=0)
    samples: list[GexHeatmapSample]
    meta: GexHeatmapSurfaceMeta


class GexForwardSurfaceMeta(BaseModel):
    version: str
    methodology: str
    note: str
    leg_count: int = Field(ge=0)
    n_times: int = Field(ge=0)
    n_prices: int = Field(ge=0)
    price_window_pct: float | None = None
    tau0_years: float | None = None
    tau0_hours: float | None = None
    metric: Literal["gamma", "delta", "delta_change", "charm", "vanna"] = "gamma"
    unit: str = "USD / 1% move"
    iv_shift: float = 0.0
    reference_iv: float | None = None
    settlement_strike: float | None = None
    positioning_source: Literal["flow"] = "flow"
    position_recovery: Literal[
        "unavailable", "direct_flow_positions", "mixed", "gex_inversion"
    ] = "unavailable"
    direct_position_leg_count: int = Field(default=0, ge=0)
    reference_gex_coverage: float = Field(default=0.0, ge=0.0, le=1.0)
    expiry_scope: Literal["0dte", "eow", "eom"] = "0dte"


class GexForwardSurfaceResponse(BaseModel):
    """Single-expiry forward Greek projection on a future time × price grid.

    Distinct from historical heatmap surface (gex_window_history).
    """

    times: list[int]
    prices: list[float]
    values: list[list[float]]
    spot: float
    settle_ms: int
    as_of_ms: int
    expiry: str
    meta: GexForwardSurfaceMeta


IvSignalDirection = Literal["LONG", "SHORT", "NO_TRADE"]


class IvSignalParameters(BaseModel):
    tail_threshold: float = Field(gt=0.0, lt=0.5)
    band_width: float = Field(gt=0.0, lt=0.5)
    signal_delta: float = Field(gt=0.0, lt=0.5)


class IvSignalDensityPoint(BaseModel):
    strike: float
    raw: float
    smoothed: float


class IvSignalMarkers(BaseModel):
    spot: float
    tail_lower: float
    tail_upper: float
    band_lower: float
    band_upper: float
    peak_strike: float


class IvDirectionalSignal(BaseModel):
    signal: IvSignalDirection
    p_up: float
    p_down: float
    difference: float = Field(ge=0.0)


class IvPeakSignal(BaseModel):
    signal: IvSignalDirection
    peak_strike: float
    shift_percent: float


class IvBandSignal(BaseModel):
    signal: IvSignalDirection
    p_band: float
    p_outside: float
    difference: float = Field(ge=0.0)


class IvSignalMetrics(BaseModel):
    skew: IvDirectionalSignal
    tails: IvDirectionalSignal
    peak: IvPeakSignal
    band: IvBandSignal


class IvSignalCoverage(BaseModel):
    total_expiry_rows: int = Field(ge=0)
    valid_iv_rows: int = Field(ge=0)
    unique_strikes: int = Field(ge=4)
    dropped_rows: int = Field(ge=0)
    duplicate_rows: int = Field(ge=0)
    strike_min: float
    strike_max: float
    iv_coverage_ratio: float = Field(ge=0.0, le=1.0)
    hard_valid_strikes: int = Field(ge=0)
    hard_valid_coverage_ratio: float = Field(ge=0.0, le=1.0)
    spot_bracketed: bool
    forward_bracketed: bool = False
    implied_forward: float | None = Field(default=None, gt=0.0)
    otm_reference: float | None = Field(default=None, gt=0.0)
    lower_strikes: int = Field(default=0, ge=0)
    upper_strikes: int = Field(default=0, ge=0)
    center_log_gap: float | None = Field(default=None, ge=0.0)
    center_gap_exceeded: bool = False
    tenor_min_strikes: int = Field(default=8, ge=1)
    tenor_min_side_strikes: int = Field(default=3, ge=1)
    max_center_log_gap: float = Field(default=0.06, gt=0.0)
    tenor_bucket: str = "0_2_dte"


class IvSignalCurvePoint(BaseModel):
    strike: float
    iv: float = Field(gt=0.0)
    iv_percent: float = Field(gt=0.0)
    source: str
    option_side: Literal["call", "put", "merged"]
    synthetic: bool
    quote_age_seconds: float = Field(ge=0.0)
    bid_iv: float | None = Field(default=None, gt=0.0)
    ask_iv: float | None = Field(default=None, gt=0.0)
    mark_iv: float | None = Field(default=None, gt=0.0)


class IvSignalSmilePoint(BaseModel):
    strike: float
    iv: float = Field(gt=0.0)
    iv_percent: float = Field(gt=0.0)
    log_moneyness: float
    delta: float | None = None
    option_side: Literal["call", "put", "merged", "unknown"] = "unknown"
    classification: Literal["preferred", "fallback", "synthetic"]
    source: str
    synthetic: bool
    bid_iv: float | None = Field(default=None, gt=0.0)
    ask_iv: float | None = Field(default=None, gt=0.0)
    mark_iv: float | None = Field(default=None, gt=0.0)
    quote_age_seconds: float | None = Field(default=None, ge=0.0)


class IvSignalSmileFitPoint(BaseModel):
    strike: float
    iv: float = Field(gt=0.0)
    iv_percent: float = Field(gt=0.0)
    log_moneyness: float
    delta: float | None = None


class IvSignalSmileMetrics(BaseModel):
    rr_25: float | None = None
    bf_25: float | None = None
    atm_iv: float | None = Field(default=None, gt=0.0)
    iv_25_call: float | None = Field(default=None, gt=0.0)
    iv_25_put: float | None = Field(default=None, gt=0.0)
    delta_axis_available: bool = False


class IvSignalSmile(BaseModel):
    """Canonical accepted IV points and the fitted smile used by the PDF."""

    points: list[IvSignalSmilePoint]
    fit: list[IvSignalSmileFitPoint]
    metrics: IvSignalSmileMetrics


class IvSignalSelectionDiagnostics(BaseModel):
    policy: str
    iv_basis: Literal["mark_iv"]
    source: str
    verified_live_quotes: bool
    input_rows: int = Field(ge=0)
    expiry_rows: int = Field(ge=0)
    valid_quote_rows: int = Field(ge=0)
    selected_market_strikes: int = Field(ge=0)
    preferred_side_selections: int = Field(ge=0)
    opposite_side_fallbacks: int = Field(ge=0)
    atm_merged_selections: int = Field(ge=0)
    atm_single_side_selections: int = Field(ge=0)
    synthetic_anchor_added: bool
    rejected_invalid_contract_rows: int = Field(ge=0)
    rejected_invalid_iv_rows: int = Field(ge=0)
    rejected_missing_quote_rows: int = Field(ge=0)
    rejected_zero_bid_rows: int = Field(ge=0)
    rejected_crossed_quote_rows: int = Field(ge=0)
    rejected_stale_quote_rows: int = Field(ge=0)
    rejected_non_open_rows: int = Field(ge=0)
    rejected_missing_size_rows: int = Field(ge=0)
    rejected_invalid_iv_market_rows: int = Field(ge=0)
    rejected_wide_spread_rows: int = Field(ge=0)
    rejected_low_delta_rows: int = Field(ge=0)
    rejected_low_open_interest_rows: int = Field(ge=0)
    methodology: str = "dvol_inspired_quote_filter_and_forward"
    coverage_corridor: float | None = Field(default=None, ge=0.0)
    delta_cutoff: float | None = Field(default=None, gt=0.0, lt=0.5)
    implied_forward: float | None = Field(default=None, gt=0.0)
    forward_source: Literal[
        "matching_future",
        "inverse_put_call_parity",
        "parity_pairs",
        "venue_underlying_price",
        "underlying_price",
        "spot_fallback",
    ] | None = None
    forward_pair_count: int = Field(default=0, ge=0)
    otm_reference: float | None = Field(default=None, gt=0.0)
    median_selected_iv_spread_percentage_points: float = Field(ge=0.0)
    max_selected_iv_spread_percentage_points: float = Field(ge=0.0)
    max_quote_age_seconds: float = Field(gt=0.0)
    oldest_selected_quote_age_seconds: float = Field(ge=0.0)


class IvSignalCurveQuality(BaseModel):
    level: Literal["HIGH", "CAUTION", "LOW"]
    signal_eligible: bool
    negative_grid_points: int = Field(ge=0)
    grid_point_count: int = Field(gt=0)
    negative_grid_fraction: float = Field(ge=0.0, le=1.0)
    negative_area: float = Field(ge=0.0)
    positive_area: float = Field(ge=0.0)
    normalization_integral: float
    clipping_required: bool
    sparse_center: bool = False


class IvSignalFreshness(BaseModel):
    snapshot_age_seconds: float = Field(ge=0.0)
    threshold_seconds: int = Field(ge=1)
    is_fresh: bool


class IvSignalEligibilityRequirements(BaseModel):
    settlement_window: bool
    curve_quality: bool
    two_sided_coverage: bool
    quote_freshness: bool
    signal_alignment: bool


class IvSignalEligibility(BaseModel):
    """Product-facing directional eligibility, including the stricter 0DTE tier."""

    is_zero_dte: bool
    directional_eligible: bool
    zero_dte_eligible: bool
    recommended_refresh_seconds: int = Field(ge=60)
    hours_to_settlement: float = Field(ge=0.0)
    active_signal_count: int = Field(ge=0, le=4)
    aligned_signal_count: int = Field(ge=0, le=4)
    lower_canonical_strikes: int = Field(ge=0)
    upper_canonical_strikes: int = Field(ge=0)
    nearest_lower_gap_percent: float | None = Field(default=None, ge=0.0)
    nearest_upper_gap_percent: float | None = Field(default=None, ge=0.0)
    requirements: IvSignalEligibilityRequirements


class IvRndDiagnostics(BaseModel):
    """Input-to-density evidence.  5% wings are versus the implied forward."""

    forward: float
    p_below_forward: float = Field(ge=0.0)
    p_above_forward: float = Field(ge=0.0)
    p_left_5: float = Field(ge=0.0)
    p_right_5: float = Field(ge=0.0)
    p_left_sigma: float = Field(default=0.0, ge=0.0)
    p_right_sigma: float = Field(default=0.0, ge=0.0)
    sigma_move: float = Field(default=0.0, ge=0.0)
    sigma_left_strike: float | None = Field(default=None, gt=0.0)
    sigma_right_strike: float | None = Field(default=None, gt=0.0)
    atm_iv: float | None = Field(default=None, gt=0.0)
    percentile_05: float
    percentile_16: float | None = None
    percentile_25: float
    percentile_50: float
    percentile_75: float
    percentile_84: float | None = None
    percentile_95: float
    expected_move_up: float = Field(default=0.0, ge=0.0)
    expected_move_down: float = Field(default=0.0, ge=0.0)
    mean: float
    normalization_integral: float
    negative_area: float = Field(ge=0.0)
    wing_ordering: Literal["left", "right", "balanced"]
    wing_signal: IvSignalDirection
    sigma_ordering: Literal["left", "right", "balanced"] = "balanced"
    sigma_signal: IvSignalDirection = "NO_TRADE"


class IvSignalOutlookState(BaseModel):
    raw_verdict: IvSignalDirection
    published_verdict: IvSignalDirection
    forming: bool
    confirmation_window: int = Field(default=3, ge=1)
    confirmation_required: int = Field(default=2, ge=1)
    raw_matches_in_window: int = Field(default=0, ge=0)


class IvSignalFeedHealth(BaseModel):
    source: str
    transport: Literal["websocket", "snapshot"]
    channel_interval: Literal["incremental", "100ms", "agg2"] | None = None
    status: Literal["READY", "WARMING", "DEGRADED", "DISCONNECTED"]
    connected: bool
    warmup_complete: bool
    universe_is_current: bool
    expected_expiry_instruments: int = Field(ge=0)
    subscribed_expiry_instruments: int = Field(ge=0)
    initialized_expiry_instruments: int = Field(ge=0)
    fresh_expiry_instruments: int = Field(ge=0)
    completeness_ratio: float = Field(ge=0.0, le=1.0)
    last_message_at: datetime | None = None
    last_message_age_seconds: float | None = Field(default=None, ge=0.0)
    reconnect_count: int = Field(ge=0)
    connection_generation: int = Field(ge=0)
    last_error: str | None = None


class IvSignalScanResponse(BaseModel):
    """Deprecated adapter around the market-implied options surface.

    Directional fields remain in the schema for one migration window and are
    retired: they are always NO_TRADE / false and must not be treated as a
    forecast. Prefer ``GET /api/v1/options-surface``.
    """

    as_of: datetime
    underlying: Literal["BTC"]
    expiry: str
    settlement_at: datetime
    spot_price: float
    time_to_expiry_years: float = Field(gt=0.0)
    parameters: IvSignalParameters
    density: list[IvSignalDensityPoint]
    iv_curve: list[IvSignalCurvePoint]
    smile: IvSignalSmile
    markers: IvSignalMarkers
    signals: IvSignalMetrics
    selection: IvSignalSelectionDiagnostics
    curve_quality: IvSignalCurveQuality
    rnd: IvRndDiagnostics
    outlook: IvSignalOutlookState
    model_verdict: IvSignalDirection
    verdict: IvSignalDirection
    suppression_reasons: list[str]
    coverage: IvSignalCoverage
    freshness: IvSignalFreshness
    eligibility: IvSignalEligibility
    feed: IvSignalFeedHealth
    warnings: list[str]
    deprecated: bool = True
    model_status: Literal["accepted", "degraded", "rejected", "research"] | None = None


class OptionsSurfaceForward(BaseModel):
    as_of_utc: datetime
    expiry_utc: datetime
    underlying: str
    forward_usd: float | None = Field(default=None, gt=0.0)
    source: Literal[
        "matching_future",
        "inverse_put_call_parity",
        "venue_underlying_price",
        "spot_fallback",
    ] | None = None
    source_quality: Literal["high", "medium", "low", "unavailable"]
    supporting_instruments: list[str]
    parity_pair_count: int = Field(ge=0)
    parity_dispersion: float | None = Field(default=None, ge=0.0)
    futures_option_difference: float | None = None
    fallback_reason: str | None = None
    validation_flags: list[str]


class OptionsSurfaceQuoteSummary(BaseModel):
    input_rows: int = Field(ge=0)
    accepted_rows: int = Field(ge=0)
    rejected_rows: int = Field(ge=0)
    accepted_strikes: int = Field(ge=0)
    preferred_side_selections: int = Field(ge=0)
    opposite_side_fallbacks: int = Field(ge=0)
    atm_merged: int = Field(ge=0)
    synthetic_atm_added: bool
    reason_counts: dict[str, int]
    lower_strikes: int = Field(ge=0)
    upper_strikes: int = Field(ge=0)
    center_log_gap: float | None = Field(default=None, ge=0.0)
    tenor_bucket: str


class OptionsSurfaceSmilePoint(BaseModel):
    strike_usd: float
    log_moneyness: float
    iv: float
    total_variance: float
    origin: str
    option_side: str
    classification: str
    bid_iv: float | None = None
    ask_iv: float | None = None
    mark_iv: float | None = None
    quote_age_seconds: float | None = None
    fit_weight: float
    source: str
    forward_delta: float | None = None


class OptionsSurfaceSmile(BaseModel):
    observed: list[OptionsSurfaceSmilePoint]
    synthetic: list[OptionsSurfaceSmilePoint]
    fit: list[OptionsSurfaceSmilePoint]
    fitter_name: str
    fitter_grade: Literal["production", "diagnostic", "research"]
    status: Literal["accepted", "degraded", "rejected", "research"]
    residual_rms: float | None = None
    optimizer_status: str
    parameters: dict[str, float]
    k_min: float | None = None
    k_max: float | None = None
    notes: list[str]


class OptionsSurfaceFailedGate(BaseModel):
    code: str
    criterion: str
    measured: float | None = None
    threshold: float | None = None
    comparison: str
    location: str | None = None
    severity: str
    message: str


class OptionsSurfaceDensityDiagnostic(BaseModel):
    """Opt-in raw curve. Never a valid probability distribution when attached."""

    label: str
    is_valid_distribution: bool = False
    strikes_usd: list[float]
    raw_density: list[float]
    cdf: list[float]


class OptionsSurfaceDensity(BaseModel):
    status: Literal["accepted", "degraded", "rejected", "research"]
    method: str
    strikes_usd: list[float]
    raw_density: list[float]
    cdf: list[float]
    quantiles: dict[str, float]
    mean: float | None = None
    mass: float | None = None
    raw_negative_mass: float = Field(ge=0.0)
    cdf_monotone: bool
    forward_moment: float | None = None
    forward_moment_error: float | None = None
    truncation_warning: bool
    grid_points: int = Field(ge=0)
    grid_converged: bool | None = None
    digital_atm_error: float | None = None
    notes: list[str]
    failed_gates: list[OptionsSurfaceFailedGate] = Field(default_factory=list)
    diagnostic: OptionsSurfaceDensityDiagnostic | None = None


class OptionsSurfaceAnalytics(BaseModel):
    atm_iv: float | None = None
    implied_move_1sd_up: float | None = None
    implied_move_1sd_down: float | None = None
    rr_25: float | None = None
    bf_25: float | None = None
    iv_25_call: float | None = None
    iv_25_put: float | None = None
    downside_wing_richness: float | None = None
    upside_wing_richness: float | None = None
    futures_option_basis: float | None = None
    p_below_forward: float | None = None
    p_above_forward: float | None = None
    p_left_5: float | None = None
    p_right_5: float | None = None
    p_left_sigma: float | None = None
    p_right_sigma: float | None = None
    central_range_50: list[float] | None = None
    central_range_90: list[float] | None = None
    risk_neutral_mean: float | None = None
    k_25_call: float | None = None
    k_25_put: float | None = None


class OptionsSurfaceMetricEligibility(BaseModel):
    metric: str
    available: bool
    reason_code: str | None = None
    reason: str | None = None


class OptionsSurfaceDisplayState(BaseModel):
    quote_status: Literal["accepted", "degraded", "rejected"]
    smile_status: Literal["accepted", "degraded", "rejected", "research"]
    density_status: Literal["accepted", "degraded", "rejected", "unavailable"]
    surface_display_status: Literal["ready", "degraded", "rejected", "unavailable"]
    reason_codes: list[str]
    human_readable_reason: str
    diagnostic_detail: str
    failed_checks: list[str]
    metric_eligibility: list[OptionsSurfaceMetricEligibility]


class OptionsSurfaceValidation(BaseModel):
    model_status: Literal["accepted", "degraded", "rejected", "research"]
    forward_quality: Literal["high", "medium", "low", "unavailable"]
    smile_status: Literal["accepted", "degraded", "rejected", "research"]
    density_status: Literal["accepted", "degraded", "rejected", "research", "unavailable"]
    quote_reason_counts: dict[str, int]
    warnings: list[str]
    summary: str
    positive_variance: bool
    call_monotone: bool
    call_convex: bool
    butterfly_ok: bool
    calendar_ok: bool | None = None
    arbitrage_violations: list[str]
    quote_status: Literal["accepted", "degraded", "rejected"] | None = None
    surface_display_status: Literal["ready", "degraded", "rejected", "unavailable"] | None = None
    human_readable_reason: str | None = None
    failed_checks: list[str] = Field(default_factory=list)


class OptionsSurfaceResponse(BaseModel):
    """Market-implied Deribit options surface for one expiry.

    All probabilities are risk-neutral (Q-measure). This is not a price
    forecast and contains no directional verdict.
    """

    schema_version: str
    as_of_utc: datetime
    expiry_utc: datetime
    expiry: str
    underlying: str
    index_usd: float
    time_to_expiry_years: float = Field(gt=0.0)
    forward: OptionsSurfaceForward
    quotes: OptionsSurfaceQuoteSummary
    smile: OptionsSurfaceSmile
    density: OptionsSurfaceDensity | None
    analytics: OptionsSurfaceAnalytics
    validation: OptionsSurfaceValidation
    model_status: Literal["accepted", "degraded", "rejected", "research"]
    fitter_name: str
    fitter_grade: Literal["production", "diagnostic", "research"]
    display: OptionsSurfaceDisplayState
    feed: IvSignalFeedHealth
    freshness: IvSignalFreshness
    warnings: list[str]
