"""Typed domain models for the market-implied options surface."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Mapping


class RejectionReason(str, Enum):
    MALFORMED_CONTRACT = "malformed_contract"
    EXPIRED = "expired"
    NON_OPEN = "non_open"
    MISSING_QUOTE = "missing_quote"
    ZERO_BID = "zero_bid"
    ZERO_ASK = "zero_ask"
    CROSSED_PRICE = "crossed_price"
    ONE_SIDED_PRICE = "one_sided_price"
    INVALID_IV = "invalid_iv"
    INVALID_IV_MARKET = "invalid_iv_market"
    MARK_IV_OUTSIDE_MARKET = "mark_iv_outside_market"
    CROSSED_IV = "crossed_iv"
    STALE_QUOTE = "stale_quote"
    MISSING_SIZE = "missing_size"
    WIDE_SPREAD = "wide_spread"
    LOW_DELTA = "low_delta"
    LOW_OPEN_INTEREST = "low_open_interest"
    DUPLICATE = "duplicate"
    SPARSE_EXPIRY = "sparse_expiry"
    OUT_OF_RANGE = "out_of_range"
    FUTURE_TIMESTAMP = "future_timestamp"
    INSUFFICIENT_OBSERVATIONS = "insufficient_observations"


class ForwardSource(str, Enum):
    MATCHING_FUTURE = "matching_future"
    INVERSE_PUT_CALL_PARITY = "inverse_put_call_parity"
    VENUE_UNDERLYING_PRICE = "venue_underlying_price"
    SPOT_FALLBACK = "spot_fallback"


class SourceQuality(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    UNAVAILABLE = "unavailable"


_QUALITY_RANK = {
    SourceQuality.HIGH: 0,
    SourceQuality.MEDIUM: 1,
    SourceQuality.LOW: 2,
    SourceQuality.UNAVAILABLE: 3,
}


def worse_quality(*qualities: SourceQuality) -> SourceQuality:
    if not qualities:
        return SourceQuality.UNAVAILABLE
    return max(qualities, key=lambda item: _QUALITY_RANK[item])


class ModelStatus(str, Enum):
    ACCEPTED = "accepted"
    DEGRADED = "degraded"
    REJECTED = "rejected"
    RESEARCH = "research"


class QuoteStatus(str, Enum):
    ACCEPTED = "accepted"
    DEGRADED = "degraded"
    REJECTED = "rejected"


class DensityDisplayStatus(str, Enum):
    ACCEPTED = "accepted"
    DEGRADED = "degraded"
    REJECTED = "rejected"
    UNAVAILABLE = "unavailable"


class SurfaceDisplayStatus(str, Enum):
    READY = "ready"
    DEGRADED = "degraded"
    REJECTED = "rejected"
    UNAVAILABLE = "unavailable"


class FitterGrade(str, Enum):
    PRODUCTION = "production"
    DIAGNOSTIC = "diagnostic"
    DIAGNOSTIC_CANDIDATE = "diagnostic_candidate"
    RESEARCH = "research"


class PointOrigin(str, Enum):
    RAW_OBSERVED = "raw_observed"
    SYNTHETIC_ATM = "synthetic_atm"
    FITTED = "fitted"
    INTERPOLATED = "interpolated"
    EXTRAPOLATED = "extrapolated"


class QueryStatus(str, Enum):
    AVAILABLE = "available"
    INTERPOLATED = "interpolated"
    EXTRAPOLATED = "extrapolated"
    UNAVAILABLE = "unavailable"


class DensityMethod(str, Enum):
    BREEDEN_LITZENBERGER_BLACK76 = "breeden_litzenberger_black76"


def _value(item: Any) -> Any:
    if isinstance(item, Enum):
        return item.value
    if isinstance(item, datetime):
        return item.isoformat()
    if is_dataclass(item) and not isinstance(item, type):
        return to_public_dict(item)
    if isinstance(item, Mapping):
        return {str(key): _value(value) for key, value in item.items()}
    if isinstance(item, (list, tuple)):
        return [_value(value) for value in item]
    return item


def to_public_dict(model: Any) -> dict[str, Any]:
    """JSON-ready dict with enum values and ISO timestamps."""
    if is_dataclass(model) and not isinstance(model, type):
        return {key: _value(value) for key, value in asdict(model).items()}
    if isinstance(model, Mapping):
        return {str(key): _value(value) for key, value in model.items()}
    raise TypeError(f"Cannot serialize {type(model)!r}")


@dataclass(frozen=True, slots=True)
class NativeOptionQuote:
    """One Deribit inverse option quote in native units."""

    instrument_name: str
    underlying: str
    expiry_date: str
    expiry_utc: datetime | None
    strike_usd: float
    option_side: str
    as_of_utc: datetime
    quote_as_of_utc: datetime | None
    state: str
    bid_price_btc: float | None
    ask_price_btc: float | None
    bid_size: float | None
    ask_size: float | None
    bid_iv: float | None
    ask_iv: float | None
    mark_iv: float | None
    mark_price_btc: float | None
    index_usd: float | None
    underlying_price_usd: float | None
    estimated_delivery_usd: float | None
    open_interest: float | None
    volume: float | None
    venue_delta: float | None
    expiry_timestamp_inferred: bool = False


@dataclass(frozen=True, slots=True)
class NativeFutureQuote:
    instrument_name: str
    underlying: str
    expiry_date: str | None
    expiry_utc: datetime | None
    as_of_utc: datetime
    quote_as_of_utc: datetime | None
    is_perpetual: bool
    bid_usd: float | None
    ask_usd: float | None
    mark_usd: float | None
    mid_usd: float | None
    index_usd: float | None
    open_interest: float | None


@dataclass(frozen=True, slots=True)
class QuoteObservation:
    """Quality-tagged smile input. IVs are in absolute units (0.50 = 50%)."""

    quote: NativeOptionQuote
    accepted: bool
    rejection_reason: RejectionReason | None
    mark_iv: float | None
    bid_iv: float | None
    ask_iv: float | None
    quote_age_seconds: float | None
    two_sided: bool
    fit_weight: float
    notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ForwardEstimate:
    as_of_utc: datetime
    expiry_utc: datetime
    underlying: str
    forward_usd: float | None
    source: ForwardSource | None
    source_quality: SourceQuality
    supporting_instruments: tuple[str, ...]
    parity_pair_count: int
    parity_dispersion: float | None
    futures_option_difference: float | None
    fallback_reason: str | None
    validation_flags: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SmilePoint:
    strike_usd: float
    log_moneyness: float
    iv: float
    total_variance: float
    origin: PointOrigin
    option_side: str
    classification: str
    bid_iv: float | None
    ask_iv: float | None
    mark_iv: float | None
    quote_age_seconds: float | None
    fit_weight: float
    source: str
    forward_delta: float | None = None


@dataclass(frozen=True, slots=True)
class SmileFitDiagnostics:
    fitter_name: str
    fitter_grade: FitterGrade
    status: ModelStatus
    residual_rms: float | None
    weighted_residual_rms: float | None
    optimizer_status: str
    parameter_count: int
    parameters: Mapping[str, float]
    observation_count: int
    k_min: float | None
    k_max: float | None
    extrapolated: bool
    notes: tuple[str, ...]
    max_abs_residual: float | None = None
    fit_converged: bool | None = None
    failure_reasons: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ResidualSummary:
    rms: float | None
    weighted_rms: float | None
    max_abs: float | None
    max_abs_k: float | None
    max_abs_iv: float | None
    weighted_iv_rms: float | None
    huber_loss: float | None
    residual_budget: float | None
    residual_budget_ok: bool | None
    high_weight_max_abs_iv: float | None = None


@dataclass(frozen=True, slots=True)
class OptimizerDiagnostics:
    converged: bool
    status: str
    n_starts: int
    selected_start: int | None
    nfev: int | None
    message: str
    start_notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PointResidual:
    strike_usd: float
    log_moneyness: float
    weight: float
    observed_w: float
    fitted_w: float | None
    residual_w: float | None
    observed_iv: float
    fitted_iv: float | None
    residual_iv: float | None


@dataclass(frozen=True, slots=True)
class CandidateComparison:
    """Per-candidate diagnostic. Research rows cannot change customer status."""

    fitter_name: str
    fitter_grade: FitterGrade
    status: ModelStatus
    converged: bool
    residual_rms: float | None
    weighted_residual_rms: float | None
    max_abs_residual: float | None
    k_min: float | None
    k_max: float | None
    call_monotone: bool | None
    call_convex: bool | None
    min_butterfly: float | None
    density_status: ModelStatus | None
    residual_budget_ok: bool | None
    selected: bool
    reason_codes: tuple[str, ...]
    notes: tuple[str, ...] = ()
    eligible_for_density: bool = False


@dataclass(frozen=True, slots=True)
class ArbitrageReport:
    positive_variance: bool
    call_monotone: bool
    call_convex: bool
    butterfly_ok: bool
    calendar_ok: bool | None
    min_total_variance: float | None
    min_call_step: float | None
    min_butterfly: float | None
    min_calendar_dw: float | None
    violations: tuple[str, ...]
    worst_convexity_strike: float | None = None
    worst_monotone_strike: float | None = None


@dataclass(frozen=True, slots=True)
class SurfaceQueryResult:
    status: QueryStatus
    iv: float | None
    total_variance: float | None
    forward_delta: float | None
    call_price_usd: float | None
    put_price_usd: float | None
    log_moneyness: float | None
    note: str | None = None


@dataclass(frozen=True, slots=True)
class ValidationGate:
    """One measured validation criterion. Never used to invent a density."""

    code: str
    criterion: str
    measured: float | None
    threshold: float | None
    comparison: str
    location: str | None
    severity: str
    message: str


@dataclass(frozen=True, slots=True)
class DensityValidation:
    status: ModelStatus
    method: DensityMethod
    mass: float | None
    raw_negative_mass: float
    nonnegative: bool
    cdf_monotone: bool
    cdf_start: float | None
    cdf_end: float | None
    forward_moment: float | None
    forward_moment_error: float | None
    edge_mass: float | None
    truncation_warning: bool
    grid_points: int
    grid_converged: bool | None
    digital_atm_error: float | None
    notes: tuple[str, ...]
    failed_gates: tuple[ValidationGate, ...] = ()


@dataclass(frozen=True, slots=True)
class DensityResult:
    as_of_utc: datetime
    expiry_utc: datetime
    forward_usd: float
    status: ModelStatus
    strikes_usd: tuple[float, ...]
    raw_density: tuple[float, ...]
    cdf: tuple[float, ...]
    quantiles: Mapping[str, float]
    mean: float | None
    validation: DensityValidation
    display_smooth: tuple[float, ...] | None = None


@dataclass(frozen=True, slots=True)
class ValidationReport:
    as_of_utc: datetime
    expiry_utc: datetime
    model_status: ModelStatus
    forward_quality: SourceQuality
    smile_status: ModelStatus
    density_status: ModelStatus
    arbitrage: ArbitrageReport
    density: DensityValidation
    quote_reason_counts: Mapping[str, int]
    warnings: tuple[str, ...]
    summary: str


@dataclass(frozen=True, slots=True)
class SurfaceAnalytics:
    atm_iv: float | None
    implied_move_1sd_up: float | None
    implied_move_1sd_down: float | None
    rr_25: float | None
    bf_25: float | None
    iv_25_call: float | None
    iv_25_put: float | None
    downside_wing_richness: float | None
    upside_wing_richness: float | None
    futures_option_basis: float | None
    p_below_forward: float | None
    p_above_forward: float | None
    p_left_5: float | None
    p_right_5: float | None
    p_left_sigma: float | None
    p_right_sigma: float | None
    central_range_50: tuple[float, float] | None
    central_range_90: tuple[float, float] | None
    risk_neutral_mean: float | None
    k_25_call: float | None = None
    k_25_put: float | None = None


@dataclass(frozen=True, slots=True)
class MetricEligibility:
    metric: str
    available: bool
    reason_code: str | None = None
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class ResearchFitterReport:
    """Non-serving candidate. Must never reject a separately passing served density."""

    fitter_name: str
    fitter_grade: FitterGrade
    status: ModelStatus
    call_monotone: bool
    call_convex: bool
    violations: tuple[str, ...]
    worst_convexity_strike: float | None = None
    notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class SurfaceDisplayState:
    """Explicit customer-facing state. Frontends must not infer this from nulls."""

    quote_status: QuoteStatus
    smile_status: ModelStatus
    density_status: DensityDisplayStatus
    surface_display_status: SurfaceDisplayStatus
    reason_codes: tuple[str, ...]
    human_readable_reason: str
    diagnostic_detail: str
    failed_checks: tuple[str, ...]
    metric_eligibility: tuple[MetricEligibility, ...]
    served_fitter_name: str = "tv_pchip"
    served_fitter_grade: FitterGrade = FitterGrade.DIAGNOSTIC
    research_fitter_name: str | None = None
    research_failed_checks: tuple[str, ...] = ()
    research_human_reason: str | None = None
    customer_warning_scope: str = "none"


@dataclass(frozen=True, slots=True)
class QuoteQualitySummary:
    input_rows: int
    accepted_rows: int
    rejected_rows: int
    accepted_strikes: int
    preferred_side_selections: int
    opposite_side_fallbacks: int
    atm_merged: int
    synthetic_atm_added: bool
    reason_counts: Mapping[str, int]
    lower_strikes: int
    upper_strikes: int
    center_log_gap: float | None
    tenor_bucket: str


@dataclass(frozen=True, slots=True)
class SmileSlice:
    as_of_utc: datetime
    expiry_utc: datetime
    underlying: str
    forward: ForwardEstimate
    time_to_expiry_years: float
    observed: tuple[SmilePoint, ...]
    synthetic: tuple[SmilePoint, ...]
    fit: tuple[SmilePoint, ...]
    diagnostics: SmileFitDiagnostics
    arbitrage: ArbitrageReport


@dataclass(frozen=True, slots=True)
class OptionsSurfaceResult:
    schema_version: str
    as_of_utc: datetime
    expiry_utc: datetime
    underlying: str
    index_usd: float
    time_to_expiry_years: float
    forward: ForwardEstimate
    quotes: QuoteQualitySummary
    smile: SmileSlice
    density: DensityResult | None
    analytics: SurfaceAnalytics
    validation: ValidationReport
    model_status: ModelStatus
    fitter_name: str
    fitter_grade: FitterGrade
    feed: Mapping[str, Any]
    warnings: tuple[str, ...]
    display: SurfaceDisplayState
    rejected_observations: tuple[QuoteObservation, ...] = field(default_factory=tuple)
    accepted_observations: tuple[QuoteObservation, ...] = field(default_factory=tuple)
    research: ResearchFitterReport | None = None
    selection_reason: str = "not_evaluated"
    fit_residual_summary: ResidualSummary | None = None
    fit_converged: bool = False
    served_call_monotone: bool | None = None
    served_call_convex: bool | None = None
    served_density_grid: int | None = None
    selected_model_status: str = "not_evaluated"
    candidate_comparison: tuple[CandidateComparison, ...] = ()
