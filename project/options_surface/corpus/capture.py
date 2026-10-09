"""Build immutable capture records from market inputs and a served result."""

from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
import socket
import subprocess
import uuid
from pathlib import Path
from typing import Any, Mapping, Sequence

from project.options_surface.config import SurfaceServingConfig, default_serving_config
from project.options_surface.corpus.schema import CAPTURE_SCHEMA_VERSION
from project.options_surface.display import classify_primary_failure
from project.options_surface.forward.estimate import collect_forward_candidates
from project.options_surface.normalization.otm import select_otm_observations
from project.options_surface.normalization.quotes import classify_quotes
from project.options_surface.normalization.weights import observation_weight_components
from project.options_surface.service import build_options_surface
from project.options_surface.timeutil import (
    analysis_tenor_bucket,
    as_utc,
    days_to_expiry,
    hours_to_expiry,
    seconds_to_expiry,
)
from project.options_surface.types import (
    CandidateComparison,
    ForwardEstimate,
    NativeFutureQuote,
    NativeOptionQuote,
    OptionsSurfaceResult,
    QuoteObservation,
    to_public_dict,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


def capture_from_market(
    quotes: Sequence[NativeOptionQuote] | Sequence[Mapping[str, Any]],
    *,
    expiry: str,
    as_of_utc: datetime,
    index_usd: float,
    futures: Sequence[NativeFutureQuote] = (),
    underlying: str = "BTC",
    feed: Mapping[str, Any] | None = None,
    serving_config: SurfaceServingConfig | None = None,
    option_instruments: Sequence[Mapping[str, Any]] = (),
    future_instruments: Sequence[Mapping[str, Any]] = (),
    source: Mapping[str, Any] | None = None,
    capture_error: Mapping[str, Any] | None = None,
    snapshot_id: str | None = None,
    capture_utc: datetime | None = None,
    code_version: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a complete capture record. Does not persist."""
    config = serving_config or default_serving_config()
    as_of = as_utc(as_of_utc)
    result = build_options_surface(
        quotes,
        expiry=expiry,
        as_of_utc=as_of,
        index_usd=index_usd,
        futures=futures,
        underlying=underlying,
        feed=feed,
        serving_config=config,
        require_iv_market=config.require_iv_market,
        require_open_state=config.require_open_state,
        require_sizes=config.require_sizes,
        max_quote_age_seconds=config.max_quote_age_seconds,
    )
    return assemble_capture_record(
        result,
        quotes=quotes,
        futures=futures,
        expiry=expiry,
        serving_config=config,
        option_instruments=option_instruments,
        future_instruments=future_instruments,
        source=source,
        capture_error=capture_error,
        snapshot_id=snapshot_id,
        capture_utc=capture_utc,
        code_version=code_version,
    )


def assemble_capture_record(
    result: OptionsSurfaceResult,
    *,
    quotes: Sequence[NativeOptionQuote] | Sequence[Mapping[str, Any]],
    futures: Sequence[NativeFutureQuote],
    expiry: str,
    serving_config: SurfaceServingConfig,
    option_instruments: Sequence[Mapping[str, Any]] = (),
    future_instruments: Sequence[Mapping[str, Any]] = (),
    source: Mapping[str, Any] | None = None,
    capture_error: Mapping[str, Any] | None = None,
    snapshot_id: str | None = None,
    capture_utc: datetime | None = None,
    code_version: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    native_quotes = _coerce_quotes(quotes, result)
    observations = classify_quotes(
        native_quotes,
        as_of_utc=result.as_of_utc,
        expiry_date=expiry,
    )
    candidates = collect_forward_candidates(
        observations,
        as_of_utc=result.as_of_utc,
        expiry_utc=result.expiry_utc,
        expiry_date=expiry,
        underlying=result.underlying,
        index_usd=result.index_usd,
        futures=futures,
    )
    otm = None
    if result.forward.forward_usd:
        otm = select_otm_observations(
            observations,
            forward_usd=float(result.forward.forward_usd),
            time_to_expiry_years=result.time_to_expiry_years,
        )
    weights = _weight_rows(result, otm)
    capture_at = as_utc(capture_utc or datetime.now(UTC))
    category = result.primary_failure_category or classify_primary_failure(
        codes=result.display.reason_codes,
        density_status=result.display.density_status,
        forward=result.forward,
    ).value
    return {
        "schema_version": CAPTURE_SCHEMA_VERSION,
        "snapshot_id": snapshot_id or str(uuid.uuid4()),
        "capture_utc": capture_at.isoformat(),
        "as_of_utc": result.as_of_utc.isoformat(),
        "code_version": dict(code_version or detect_code_version()),
        "config_version": serving_config.version,
        "config_hash": serving_config.config_hash,
        "serving_mode": serving_config.mode.value,
        "serving_config": serving_config.to_public_dict(),
        "underlying": result.underlying,
        "expiry": expiry,
        "expiry_utc": result.expiry_utc.isoformat(),
        "time_to_expiry": {
            "seconds": seconds_to_expiry(result.as_of_utc, result.expiry_utc),
            "years": result.time_to_expiry_years,
            "days": days_to_expiry(result.as_of_utc, result.expiry_utc),
            "hours": hours_to_expiry(result.as_of_utc, result.expiry_utc),
        },
        "analysis_tenor_bucket": analysis_tenor_bucket(result.time_to_expiry_years),
        "source": dict(source or result.feed or {}),
        "environment": {"host_id": host_id()},
        "market_inputs": {
            "index_usd": result.index_usd,
            "option_quotes": [to_public_dict(item) for item in native_quotes],
            "option_instruments": [dict(item) for item in option_instruments],
            "futures": [to_public_dict(item) for item in futures],
            "future_instruments": [dict(item) for item in future_instruments],
            "candidate_forwards": {
                key: None if value is None or not isinstance(value, ForwardEstimate) else to_public_dict(value)
                for key, value in candidates.items()
                if key != "validation_flags"
            },
            "forward_validation_flags": list(candidates.get("validation_flags") or ()),
            "feed": dict(result.feed or {}),
        },
        "normalization": {
            "accepted": [to_public_dict(item) for item in result.accepted_observations],
            "rejected": [to_public_dict(item) for item in result.rejected_observations],
            "reason_counts": dict(result.quotes.reason_counts),
            "otm_selection": _otm_summary(result, otm),
            "weights": weights,
            "origins": _origin_tags(result),
        },
        "candidates": _candidate_packs(result),
        "serving": {
            "selected_candidate": result.fitter_name,
            "selection_reason": result.selection_reason,
            "selected_model_status": result.selected_model_status,
            "forward": to_public_dict(result.forward),
            "call_grid": {
                "served_call_monotone": result.served_call_monotone,
                "served_call_convex": result.served_call_convex,
                "served_density_grid": result.served_density_grid,
            },
            "density": None if result.density is None else to_public_dict(result.density.validation),
            "density_status": result.display.density_status.value,
            "smile_status": result.display.smile_status.value,
            "surface_display_status": result.display.surface_display_status.value,
            "metric_eligibility": [to_public_dict(item) for item in result.display.metric_eligibility],
            "customer_reason": result.display.human_readable_reason,
            "developer_reason_codes": list(result.display.reason_codes),
            "failed_checks": list(result.display.failed_checks),
            "primary_failure_category": category,
            "fit_residual_summary": (
                None if result.fit_residual_summary is None else to_public_dict(result.fit_residual_summary)
            ),
            "analytics": to_public_dict(result.analytics),
        },
        "served_result": to_public_dict(result),
        "capture_error": None if capture_error is None else dict(capture_error),
        "capture_ok": capture_error is None,
    }


def failed_capture_record(
    *,
    expiry: str,
    underlying: str,
    as_of_utc: datetime,
    serving_config: SurfaceServingConfig,
    error: Mapping[str, Any],
    source: Mapping[str, Any] | None = None,
    snapshot_id: str | None = None,
) -> dict[str, Any]:
    as_of = as_utc(as_of_utc)
    return {
        "schema_version": CAPTURE_SCHEMA_VERSION,
        "snapshot_id": snapshot_id or str(uuid.uuid4()),
        "capture_utc": datetime.now(UTC).isoformat(),
        "as_of_utc": as_of.isoformat(),
        "code_version": detect_code_version(),
        "config_version": serving_config.version,
        "config_hash": serving_config.config_hash,
        "serving_mode": serving_config.mode.value,
        "serving_config": serving_config.to_public_dict(),
        "underlying": underlying,
        "expiry": expiry,
        "expiry_utc": None,
        "time_to_expiry": {"seconds": None, "years": None, "days": None, "hours": None},
        "analysis_tenor_bucket": None,
        "source": dict(source or {}),
        "environment": {"host_id": host_id()},
        "market_inputs": {
            "index_usd": None,
            "option_quotes": [],
            "option_instruments": [],
            "futures": [],
            "future_instruments": [],
            "candidate_forwards": {},
            "forward_validation_flags": [],
            "feed": {},
        },
        "normalization": {
            "accepted": [],
            "rejected": [],
            "reason_counts": {},
            "otm_selection": {},
            "weights": [],
            "origins": [],
        },
        "candidates": {},
        "serving": {
            "selected_candidate": "none",
            "selection_reason": "capture_failed",
            "selected_model_status": "rejected",
            "forward": None,
            "call_grid": {},
            "density": None,
            "density_status": "unavailable",
            "smile_status": "rejected",
            "surface_display_status": "unavailable",
            "metric_eligibility": [],
            "customer_reason": "Capture failed before a serving decision.",
            "developer_reason_codes": ["capture_failed"],
            "failed_checks": ["capture_failed"],
            "primary_failure_category": "market_data",
            "fit_residual_summary": None,
            "analytics": None,
        },
        "served_result": None,
        "capture_error": dict(error),
        "capture_ok": False,
    }


def detect_code_version(root: Path | None = None) -> dict[str, Any]:
    cwd = root or REPO_ROOT
    commit = None
    dirty = None
    try:
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip()
        status = subprocess.check_output(
            ["git", "status", "--porcelain"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
        dirty = bool(status.strip())
    except (OSError, subprocess.SubprocessError):
        commit = None
        dirty = None
    return {
        "git_commit": commit,
        "git_dirty": dirty,
        "package_version": "0.1.0",
    }


def host_id() -> str:
    try:
        name = socket.gethostname() or "unknown"
    except OSError:
        name = "unknown"
    return sha256(name.encode("utf-8")).hexdigest()[:12]


def _coerce_quotes(
    quotes: Sequence[NativeOptionQuote] | Sequence[Mapping[str, Any]],
    result: OptionsSurfaceResult,
) -> tuple[NativeOptionQuote, ...]:
    if quotes and isinstance(quotes[0], NativeOptionQuote):
        return tuple(quotes)  # type: ignore[arg-type]
    from project.options_surface.market_data.ticker_adapter import quotes_from_scanner_rows

    return quotes_from_scanner_rows(
        quotes,  # type: ignore[arg-type]
        as_of_utc=result.as_of_utc,
        underlying=result.underlying,
        default_index_usd=result.index_usd,
    )


def _otm_summary(result: OptionsSurfaceResult, otm: Mapping[str, Any] | None) -> dict[str, Any]:
    quotes = result.quotes
    payload = {
        "accepted_strikes": quotes.accepted_strikes,
        "preferred_side_selections": quotes.preferred_side_selections,
        "opposite_side_fallbacks": quotes.opposite_side_fallbacks,
        "atm_merged": quotes.atm_merged,
        "synthetic_atm_added": quotes.synthetic_atm_added,
        "lower_strikes": quotes.lower_strikes,
        "upper_strikes": quotes.upper_strikes,
        "center_log_gap": quotes.center_log_gap,
        "tenor_bucket": quotes.tenor_bucket,
    }
    if otm is not None:
        payload["center_gap_exceeded"] = bool(otm.get("center_gap_exceeded"))
    return payload


def _weight_rows(
    result: OptionsSurfaceResult,
    otm: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    points = list(result.smile.observed) + list(result.smile.synthetic)
    by_key = {(round(point.strike_usd, 6), point.option_side): point for point in points}
    for item in list(result.accepted_observations) + list(result.rejected_observations):
        quote = item.quote
        point = by_key.get((round(quote.strike_usd, 6), quote.option_side))
        log_m = None if point is None else point.log_moneyness
        fallback = bool(point is not None and point.classification == "fallback")
        components = observation_weight_components(
            quote,
            log_moneyness=log_m,
            quote_age_seconds=item.quote_age_seconds,
            two_sided=item.two_sided,
            fallback=fallback,
            atm_iv=item.mark_iv,
        )
        rows.append(
            {
                "instrument_name": quote.instrument_name,
                "strike_usd": quote.strike_usd,
                "option_side": quote.option_side,
                "accepted": item.accepted,
                "rejection_reason": None if item.rejection_reason is None else item.rejection_reason.value,
                "fit_weight": item.fit_weight,
                "components": components,
            }
        )
    _ = otm
    return rows


def _origin_tags(result: OptionsSurfaceResult) -> list[dict[str, Any]]:
    tags: list[dict[str, Any]] = []
    for point in list(result.smile.observed) + list(result.smile.synthetic):
        tags.append(
            {
                "strike_usd": point.strike_usd,
                "option_side": point.option_side,
                "origin": point.origin.value,
                "classification": point.classification,
                "source": point.source,
            }
        )
    return tags


def _candidate_packs(result: OptionsSurfaceResult) -> dict[str, Any]:
    packs: dict[str, Any] = {}
    for row in result.candidate_comparison:
        packs[row.fitter_name] = _pack_comparison(row, result)
    if "constrained_svi" not in packs:
        packs["constrained_svi"] = {
            "fitter_name": "constrained_svi",
            "fitter_grade": "diagnostic_candidate",
            "attempted": False,
            "converged": False,
            "selected": False,
            "reason_codes": ["not_recorded"],
        }
    for name, grade in (("tv_pchip", "diagnostic"), ("svi_raw", "research")):
        packs.setdefault(
            name,
            {
                "fitter_name": name,
                "fitter_grade": grade,
                "attempted": False,
                "converged": False,
                "selected": False,
                "reason_codes": ["not_recorded"],
            },
        )
    return packs


def _pack_comparison(row: CandidateComparison, result: OptionsSurfaceResult) -> dict[str, Any]:
    residual = result.fit_residual_summary if row.fitter_name == result.fitter_name else None
    smile_diag = result.smile.diagnostics if row.fitter_name == result.fitter_name else None
    return {
        "fitter_name": row.fitter_name,
        "fitter_grade": row.fitter_grade.value,
        "attempted": True,
        "converged": row.converged,
        "status": row.status.value,
        "optimizer_status": None if smile_diag is None else smile_diag.optimizer_status,
        "parameters": {} if smile_diag is None else dict(smile_diag.parameters),
        "initialization_start": None if smile_diag is None else _start_from_notes(smile_diag.notes),
        "objective_value": None if residual is None else residual.huber_loss,
        "weighted_residual_rms": row.weighted_residual_rms,
        "residual_rms": row.residual_rms,
        "max_abs_residual": row.max_abs_residual,
        "residual_budget_ok": row.residual_budget_ok,
        "residual_vs_envelope": _envelope_summary(result) if row.fitter_name == result.fitter_name else None,
        "k_min": row.k_min,
        "k_max": row.k_max,
        "call_monotone": row.call_monotone,
        "call_convex": row.call_convex,
        "min_butterfly": row.min_butterfly,
        "density_status": None if row.density_status is None else row.density_status.value,
        "selected": row.selected,
        "eligible_for_density": row.eligible_for_density,
        "reason_codes": list(row.reason_codes),
        "notes": list(row.notes),
    }


def _start_from_notes(notes: Sequence[str]) -> str | None:
    for note in notes:
        if str(note).startswith("selected_start="):
            return str(note)
    return None


def _envelope_summary(result: OptionsSurfaceResult) -> dict[str, Any]:
    inside = 0
    total = 0
    max_outside = None
    for point in result.smile.observed:
        if point.bid_iv is None or point.ask_iv is None:
            continue
        total += 1
        lo, hi = min(point.bid_iv, point.ask_iv), max(point.bid_iv, point.ask_iv)
        if lo <= point.iv <= hi:
            inside += 1
        else:
            outside = min(abs(point.iv - lo), abs(point.iv - hi))
            if max_outside is None or outside > max_outside:
                max_outside = outside
    return {
        "points_with_iv_market": total,
        "inside_bid_ask_iv": inside,
        "max_excursion_outside_iv": max_outside,
    }
