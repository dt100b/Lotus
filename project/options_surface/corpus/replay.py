"""Replay a persisted capture without re-querying Deribit."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping

from project.options_surface.config import serving_config_from_mapping
from project.options_surface.corpus.schema import CAPTURE_SCHEMA_VERSION
from project.options_surface.corpus.store import SchemaCompatibilityError, classify_schema
from project.options_surface.diagnostics import _dt, _native_quote
from project.options_surface.service import build_options_surface
from project.options_surface.types import NativeFutureQuote, OptionsSurfaceResult


KEY_REPLAY_FIELDS = (
    "fitter_name",
    "selection_reason",
    "density_status",
    "smile_status",
    "surface_display_status",
    "primary_failure_category",
    "residual_budget_ok",
    "forward_source",
    "forward_quality",
    "served_call_monotone",
    "served_call_convex",
)


def replay_capture(record: Mapping[str, Any]) -> OptionsSurfaceResult:
    """Rebuild the serving decision from persisted market inputs and config."""
    status = classify_schema(record)
    if status != "supported":
        raise SchemaCompatibilityError(
            f"Cannot replay schema {record.get('schema_version')!r} ({status})."
        )
    if not record.get("capture_ok", True):
        raise ValueError("Cannot replay a failed capture; market inputs are incomplete.")
    market = record.get("market_inputs") or {}
    quotes = []
    for raw in market.get("option_quotes") or ():
        parsed = _native_quote(raw) if isinstance(raw, Mapping) else None
        if parsed is not None:
            quotes.append(parsed)
    if not quotes:
        raise ValueError("Capture has no native option quotes to replay.")
    futures = tuple(
        _future_quote(item, record)
        for item in market.get("futures") or ()
        if isinstance(item, Mapping)
    )
    as_of = _dt(record.get("as_of_utc")) or datetime.fromisoformat(str(record["as_of_utc"]))
    config = serving_config_from_mapping(record.get("serving_config") or record)
    return build_options_surface(
        quotes,
        expiry=str(record.get("expiry")),
        as_of_utc=as_of,
        index_usd=float(market.get("index_usd") or 0.0),
        futures=futures,
        underlying=str(record.get("underlying") or "BTC"),
        feed=dict(market.get("feed") or {}),
        serving_config=config,
        require_iv_market=config.require_iv_market,
        require_open_state=config.require_open_state,
        require_sizes=config.require_sizes,
        max_quote_age_seconds=config.max_quote_age_seconds,
    )


def replay_matches(record: Mapping[str, Any], rebuilt: OptionsSurfaceResult) -> dict[str, Any]:
    serving = record.get("serving") or {}
    expected = {
        "fitter_name": serving.get("selected_candidate"),
        "selection_reason": serving.get("selection_reason"),
        "density_status": serving.get("density_status"),
        "smile_status": serving.get("smile_status"),
        "surface_display_status": serving.get("surface_display_status"),
        "primary_failure_category": serving.get("primary_failure_category"),
        "residual_budget_ok": (serving.get("fit_residual_summary") or {}).get("residual_budget_ok"),
        "forward_source": ((serving.get("forward") or {}).get("source")),
        "forward_quality": ((serving.get("forward") or {}).get("source_quality")),
        "served_call_monotone": (serving.get("call_grid") or {}).get("served_call_monotone"),
        "served_call_convex": (serving.get("call_grid") or {}).get("served_call_convex"),
    }
    actual = {
        "fitter_name": rebuilt.fitter_name,
        "selection_reason": rebuilt.selection_reason,
        "density_status": rebuilt.display.density_status.value,
        "smile_status": rebuilt.display.smile_status.value,
        "surface_display_status": rebuilt.display.surface_display_status.value,
        "primary_failure_category": rebuilt.primary_failure_category,
        "residual_budget_ok": (
            None
            if rebuilt.fit_residual_summary is None
            else rebuilt.fit_residual_summary.residual_budget_ok
        ),
        "forward_source": None if rebuilt.forward.source is None else rebuilt.forward.source.value,
        "forward_quality": rebuilt.forward.source_quality.value,
        "served_call_monotone": rebuilt.served_call_monotone,
        "served_call_convex": rebuilt.served_call_convex,
    }
    mismatches = {
        key: {"expected": expected[key], "actual": actual[key]}
        for key in KEY_REPLAY_FIELDS
        if expected[key] != actual[key]
    }
    return {
        "ok": not mismatches,
        "schema_version": record.get("schema_version", CAPTURE_SCHEMA_VERSION),
        "snapshot_id": record.get("snapshot_id"),
        "expected": expected,
        "actual": actual,
        "mismatches": mismatches,
    }


def _future_quote(raw: Mapping[str, Any], record: Mapping[str, Any]) -> NativeFutureQuote:
    as_of = _dt(raw.get("as_of_utc")) or _dt(record.get("as_of_utc"))
    if as_of is None:
        raise ValueError("Future quote is missing as_of_utc.")
    return NativeFutureQuote(
        instrument_name=str(raw.get("instrument_name") or ""),
        underlying=str(raw.get("underlying") or record.get("underlying") or "BTC"),
        expiry_date=None if raw.get("expiry_date") is None else str(raw.get("expiry_date")),
        expiry_utc=_dt(raw.get("expiry_utc")),
        as_of_utc=as_of,
        quote_as_of_utc=_dt(raw.get("quote_as_of_utc")),
        is_perpetual=bool(raw.get("is_perpetual")),
        bid_usd=_optf(raw.get("bid_usd")),
        ask_usd=_optf(raw.get("ask_usd")),
        mark_usd=_optf(raw.get("mark_usd")),
        mid_usd=_optf(raw.get("mid_usd")),
        index_usd=_optf(raw.get("index_usd")),
        open_interest=_optf(raw.get("open_interest")),
    )


def _optf(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number
