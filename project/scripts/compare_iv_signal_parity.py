"""Frozen-snapshot parity audit for the IV signal scanner.

The audit deliberately separates four effects that a one-shot comparison
would conflate:

1. the supplied prototype's duplicate-strike call/put input and calendar T;
2. the canonical OTM IV curve with the prototype's calendar T;
3. that same canonical curve with exact Deribit settlement T; and
4. the production scanner, including quote validation and quality gating.

Reports are deterministic for a given fixture and numerical environment.  A
canonical-versus-legacy change is a review item, while production math drift or
a LOW-quality trade escaping the gate is a hard failure.
"""

from __future__ import annotations

import argparse
from datetime import UTC, date, datetime
import html
import json
import math
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
from scipy.integrate import cumulative_trapezoid, simpson
from scipy.interpolate import UnivariateSpline

from project.pipeline import iv_signal_scanner as production
from project.tests.reference import legacy_iv_signal_reference as legacy


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURE = (
    REPOSITORY_ROOT
    / "project"
    / "tests"
    / "fixtures"
    / "iv_signal_parity_2026-08-14.json"
)
DEFAULT_REPORT_DIR = REPOSITORY_ROOT / "project" / "runtime" / "iv_signal_parity"
REFERENCE_APP_SHA256 = (
    "5F528547A2828B00D5FF44457CF013CEBDAB2178CF257486D6DCE129CFE5D024"
)
COMMON_IV_GRID_POINTS = 201
COMMON_DENSITY_GRID_POINTS = 401
ENGINE_RTOL = 1e-10
ENGINE_ATOL = 1e-12
IV_RMSE_REVIEW_VOL_POINTS = 1.0
DENSITY_TV_REVIEW = 0.10
MODE_SHIFT_REVIEW_PERCENT = 0.50
VOTE_NAMES = ("skew", "tails", "peak", "band")


def load_fixture(path: str | Path = DEFAULT_FIXTURE) -> dict[str, Any]:
    fixture_path = Path(path)
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    if fixture.get("fixture_version") != 1:
        raise ValueError("Unsupported IV parity fixture version.")
    expiries = fixture.get("expiries")
    if not isinstance(expiries, list) or not 5 <= len(expiries) <= 10:
        raise ValueError("Parity fixture must contain 5 to 10 expiries.")
    if set(expiries) != set((fixture.get("chains") or {}).keys()):
        raise ValueError("Fixture expiries and chain keys do not match.")
    fields = fixture.get("fields")
    required = {
        "strike",
        "call_mark_iv",
        "call_bid_price",
        "call_ask_price",
        "put_mark_iv",
        "put_bid_price",
        "put_ask_price",
    }
    if not isinstance(fields, list) or not required.issubset(fields):
        raise ValueError("Fixture is missing canonical call/put quote fields.")
    return fixture


def adapt_book_summary_rows(fixture: dict[str, Any]) -> list[dict[str, Any]]:
    """Expand compact call/put chains into production instrument rows."""
    fields = fixture["fields"]
    quote_as_of = fixture["source"]["captured_as_of"]
    rows: list[dict[str, Any]] = []
    for expiry in fixture["expiries"]:
        for values in fixture["chains"][expiry]:
            combined = dict(zip(fields, values, strict=True))
            strike = combined["strike"]
            for side in ("call", "put"):
                rows.append(
                    {
                        "expiry": expiry,
                        "strike": strike,
                        "option_type": side,
                        "mark_iv": combined[f"{side}_mark_iv"],
                        "bid_price": combined[f"{side}_bid_price"],
                        "ask_price": combined[f"{side}_ask_price"],
                        # The source response does not publish a quote timestamp
                        # per summary row.  Its server response time is the
                        # deterministic freshness boundary for the frozen book.
                        "quote_as_of": quote_as_of,
                    }
                )
    return rows


def build_parity_report(fixture: dict[str, Any]) -> dict[str, Any]:
    as_of = _parse_utc(fixture["source"]["captured_as_of"])
    spot = float(fixture["spot_price"])
    rows = adapt_book_summary_rows(fixture)
    cases = [
        _compare_expiry(
            rows,
            expiry=expiry,
            spot=spot,
            as_of=as_of,
        )
        for expiry in fixture["expiries"]
    ]
    hard_failures = sum(case["status"] == "FAIL" for case in cases)
    reviews = sum(case["status"] == "REVIEW" for case in cases)
    passes = sum(case["status"] == "PASS" for case in cases)
    return {
        "report_version": 1,
        "generated_at": datetime.now(tz=UTC),
        "fixture": {
            "source": fixture["source"],
            "underlying": fixture["underlying"],
            "spot_price": spot,
            "expiry_count": len(fixture["expiries"]),
        },
        "reference": {
            "app_py_sha256": REFERENCE_APP_SHA256,
            "dense_points": legacy.DENSE_POINTS,
            "iv_smoothing": legacy.SMOOTHING_IV,
            "tail_threshold": legacy.TAIL_THRESHOLD,
            "band_width": legacy.BAND_WIDTH,
            "signal_delta": legacy.SIGNAL_DELTA,
        },
        "review_thresholds": {
            "iv_curve_rmse_vol_points": IV_RMSE_REVIEW_VOL_POINTS,
            "positive_density_tv_distance": DENSITY_TV_REVIEW,
            "mode_shift_percent_of_spot": MODE_SHIFT_REVIEW_PERCENT,
        },
        "summary": {
            "case_count": len(cases),
            "pass_count": passes,
            "review_count": reviews,
            "failure_count": hard_failures,
            "engine_parity_passed": all(
                case["engine_parity"]["passed"] for case in cases
            ),
            "low_quality_trade_leaks": sum(
                bool(case["low_quality_trade_leak"]) for case in cases
            ),
            "overall_status": "FAIL"
            if hard_failures
            else ("REVIEW" if reviews else "PASS"),
        },
        "cases": cases,
    }


def _compare_expiry(
    rows: Sequence[dict[str, Any]],
    *,
    expiry: str,
    spot: float,
    as_of: datetime,
) -> dict[str, Any]:
    legacy_strikes, legacy_ivs = _legacy_input(rows, expiry)
    normalized = production.normalize_expiry_iv_curve(
        rows,
        expiry=expiry,
        spot=spot,
        as_of=as_of,
        source="deribit_book_summary",
        verified_live_quotes=True,
    )
    canonical_strikes = np.asarray(normalized["strikes"], dtype=float)
    canonical_ivs = np.asarray(normalized["ivs"], dtype=float)

    calendar_t = _calendar_time_to_expiry(expiry, as_of)
    exact_t = _exact_time_to_expiry(expiry, as_of)
    legacy_stage = _reference_stage(
        spot, legacy_strikes, legacy_ivs, calendar_t
    )
    canonical_calendar_stage = _reference_stage(
        spot, canonical_strikes, canonical_ivs, calendar_t
    )
    canonical_exact_stage = _reference_stage(
        spot, canonical_strikes, canonical_ivs, exact_t
    )
    production_scan = production.scan_expiry_rows(
        rows,
        expiry=expiry,
        spot=spot,
        as_of=as_of,
        source="deribit_book_summary",
        verified_live_quotes=True,
    )
    production_stage = _production_stage(production_scan)

    iv_metrics, iv_visual = _iv_curve_metrics(
        spot,
        legacy_strikes,
        legacy_ivs,
        canonical_strikes,
        canonical_ivs,
    )
    legacy_to_production_density, density_visual = _density_metrics(
        spot, legacy_stage, production_stage, include_visual=True
    )
    input_density, _ = _density_metrics(
        spot, legacy_stage, canonical_calendar_stage
    )
    time_density, _ = _density_metrics(
        spot, canonical_calendar_stage, canonical_exact_stage
    )
    engine_density, _ = _density_metrics(
        spot, canonical_exact_stage, production_stage
    )

    engine_parity = _engine_parity(canonical_exact_stage, production_stage)
    quality = production_scan["curve_quality"]
    low_quality_trade_leak = bool(
        quality["level"] == "LOW"
        and production_scan["verdict"] != "NO_TRADE"
    )
    reasons = _reason_tags(
        legacy_observations=len(legacy_strikes),
        canonical_points=len(canonical_strikes),
        selection=normalized["selection"],
        calendar_t=calendar_t,
        exact_t=exact_t,
        iv_metrics=iv_metrics,
        model_verdict=production_scan["model_verdict"],
        final_verdict=production_scan["verdict"],
    )
    transitions = {
        "canonical_input_policy": _signal_transition(
            legacy_stage, canonical_calendar_stage
        ),
        "exact_time_to_expiry": _signal_transition(
            canonical_calendar_stage, canonical_exact_stage
        ),
        "production_engine": _signal_transition(
            canonical_exact_stage, production_stage
        ),
        "quality_gate": {
            "from_verdict": production_scan["model_verdict"],
            "to_verdict": production_scan["verdict"],
            "changed": production_scan["model_verdict"]
            != production_scan["verdict"],
            "suppression_reasons": production_scan["suppression_reasons"],
        },
    }
    material_review = bool(
        transitions["canonical_input_policy"]["changed"]
        or transitions["exact_time_to_expiry"]["changed"]
        or transitions["quality_gate"]["changed"]
        or quality["level"] != "HIGH"
        or iv_metrics["rmse_vol_points"] > IV_RMSE_REVIEW_VOL_POINTS
        or legacy_to_production_density["positive_pdf_tv_distance"]
        > DENSITY_TV_REVIEW
        or legacy_to_production_density["mode_shift_percent_of_spot"]
        > MODE_SHIFT_REVIEW_PERCENT
    )
    undocumented_change = bool(
        (
            transitions["canonical_input_policy"]["changed"]
            or transitions["exact_time_to_expiry"]["changed"]
            or transitions["quality_gate"]["changed"]
        )
        and not reasons
    )
    hard_failure = bool(
        not engine_parity["passed"]
        or low_quality_trade_leak
        or undocumented_change
    )
    status = "FAIL" if hard_failure else ("REVIEW" if material_review else "PASS")

    return {
        "expiry": expiry,
        "as_of": as_of,
        "spot": spot,
        "time_to_expiry": {
            "legacy_calendar_years": calendar_t,
            "legacy_calendar_hours": calendar_t * 365.0 * 24.0,
            "exact_years": exact_t,
            "exact_hours": exact_t * 365.0 * 24.0,
            "difference_hours": (exact_t - calendar_t) * 365.0 * 24.0,
            "settlement_at": production.deribit_settlement(expiry),
        },
        "input": {
            "legacy_observations": len(legacy_strikes),
            "legacy_unique_strikes": int(len(np.unique(legacy_strikes))),
            "canonical_curve_points": len(canonical_strikes),
            "canonical_market_strikes": normalized["selection"][
                "selected_market_strikes"
            ],
            "selection": normalized["selection"],
            "coverage": normalized["coverage"],
            "iv_curve": normalized["iv_curve"],
        },
        "stages": {
            "legacy_calendar_t": _public_stage(legacy_stage),
            "canonical_calendar_t": _public_stage(canonical_calendar_stage),
            "canonical_exact_t_reference": _public_stage(canonical_exact_stage),
            "production": {
                **_public_stage(production_stage),
                "model_verdict": production_scan["model_verdict"],
                "final_verdict": production_scan["verdict"],
                "curve_quality": quality,
                "suppression_reasons": production_scan["suppression_reasons"],
            },
        },
        "transitions": transitions,
        "metrics": {
            "iv_curve": iv_metrics,
            "legacy_to_production_density": legacy_to_production_density,
            "input_policy_density": input_density,
            "time_to_expiry_density": time_density,
            "engine_density": engine_density,
        },
        "engine_parity": engine_parity,
        "low_quality_trade_leak": low_quality_trade_leak,
        "reason_tags": reasons,
        "status": status,
        "visual": {
            "iv_curve": iv_visual,
            "density": density_visual,
        },
    }


def _legacy_input(
    rows: Sequence[dict[str, Any]], expiry: str
) -> tuple[np.ndarray, np.ndarray]:
    strikes: list[float] = []
    ivs: list[float] = []
    for row in rows:
        if row.get("expiry") != expiry:
            continue
        strike = _positive_finite(row.get("strike"))
        iv_percent = _positive_finite(row.get("mark_iv"))
        if strike is None or iv_percent is None:
            continue
        # The prototype appended every call and put instrument independently,
        # leaving duplicate strikes for the smoothing spline.
        strikes.append(strike)
        ivs.append(iv_percent / 100.0)
    if len(strikes) < 4:
        raise ValueError(f"Legacy case {expiry} has fewer than four observations.")
    return np.asarray(strikes, dtype=float), np.asarray(ivs, dtype=float)


def _reference_stage(
    spot: float,
    strikes: np.ndarray,
    ivs: np.ndarray,
    time_to_expiry: float,
) -> dict[str, Any]:
    dense, raw, smooth = legacy.build_pdf(spot, strikes, ivs, time_to_expiry)
    signals = legacy.compute_signals(spot, dense, raw, smooth)
    return {
        "time_to_expiry_years": float(time_to_expiry),
        "dense": np.asarray(dense, dtype=float),
        "raw": np.asarray(raw, dtype=float),
        "smooth": np.asarray(smooth, dtype=float),
        "signals": _normalize_reference_signals(signals, spot),
        "quality": _density_quality(dense, raw),
    }


def _production_stage(scan: dict[str, Any]) -> dict[str, Any]:
    dense = np.asarray([point["strike"] for point in scan["density"]], dtype=float)
    raw = np.asarray([point["raw"] for point in scan["density"]], dtype=float)
    smooth = np.asarray(
        [point["smoothed"] for point in scan["density"]], dtype=float
    )
    return {
        "time_to_expiry_years": float(scan["time_to_expiry_years"]),
        "dense": dense,
        "raw": raw,
        "smooth": smooth,
        "signals": {
            "votes": {
                name: scan["signals"][name]["signal"] for name in VOTE_NAMES
            },
            "verdict": scan["model_verdict"],
            "metrics": scan["signals"],
        },
        "quality": scan["curve_quality"],
    }


def _normalize_reference_signals(
    signals: dict[str, Any], spot: float
) -> dict[str, Any]:
    votes = {
        name: _normalize_signal(signals[name]["signal"]) for name in VOTE_NAMES
    }
    peak_strike = float(signals["peak"]["peak_strike"])
    metrics = {
        "skew": {
            "signal": votes["skew"],
            "p_up": float(signals["skew"]["p_up"]),
            "p_down": float(signals["skew"]["p_dn"]),
            "difference": float(signals["skew"]["diff"]),
        },
        "tails": {
            "signal": votes["tails"],
            "p_up": float(signals["tails"]["p_up"]),
            "p_down": float(signals["tails"]["p_dn"]),
            "difference": float(signals["tails"]["diff"]),
        },
        "peak": {
            "signal": votes["peak"],
            "peak_strike": peak_strike,
            "shift_percent": ((peak_strike / spot) - 1.0) * 100.0,
        },
        "band": {
            "signal": votes["band"],
            "p_band": float(signals["band"]["p_band"]),
            "p_outside": float(signals["band"]["p_outside"]),
            "difference": abs(
                float(signals["band"]["p_outside"])
                - float(signals["band"]["p_band"])
            ),
        },
    }
    return {
        "votes": votes,
        "verdict": _normalize_signal(signals["final"]),
        "metrics": metrics,
    }


def _public_stage(stage: dict[str, Any]) -> dict[str, Any]:
    return {
        "time_to_expiry_years": stage["time_to_expiry_years"],
        "signals": stage["signals"],
        "quality": stage["quality"],
        "density_points": len(stage["dense"]),
        "strike_min": float(stage["dense"][0]),
        "strike_max": float(stage["dense"][-1]),
    }


def _iv_curve_metrics(
    spot: float,
    legacy_strikes: np.ndarray,
    legacy_ivs: np.ndarray,
    canonical_strikes: np.ndarray,
    canonical_ivs: np.ndarray,
) -> tuple[dict[str, Any], dict[str, Any]]:
    lower = max(float(np.min(legacy_strikes)), float(np.min(canonical_strikes)))
    upper = min(float(np.max(legacy_strikes)), float(np.max(canonical_strikes)))
    if not upper > lower:
        raise ValueError("Legacy and canonical IV curves have no common support.")
    grid = np.linspace(lower, upper, COMMON_IV_GRID_POINTS)
    legacy_curve = np.clip(
        UnivariateSpline(legacy_strikes[np.argsort(legacy_strikes)],
                         legacy_ivs[np.argsort(legacy_strikes)], s=legacy.SMOOTHING_IV)(grid),
        1e-4,
        None,
    )
    canonical_curve = np.clip(
        UnivariateSpline(canonical_strikes, canonical_ivs, s=legacy.SMOOTHING_IV)(grid),
        1e-4,
        None,
    )
    difference = (canonical_curve - legacy_curve) * 100.0
    atm_difference: float | None = None
    if lower <= spot <= upper:
        legacy_atm = float(np.interp(spot, grid, legacy_curve))
        canonical_atm = float(np.interp(spot, grid, canonical_curve))
        atm_difference = abs(canonical_atm - legacy_atm) * 100.0
    metrics = {
        "common_grid_points": COMMON_IV_GRID_POINTS,
        "common_strike_min": lower,
        "common_strike_max": upper,
        "rmse_vol_points": float(np.sqrt(np.mean(np.square(difference)))),
        "max_abs_vol_points": float(np.max(np.abs(difference))),
        "atm_abs_vol_points": atm_difference,
    }
    visual = {
        "moneyness": (grid / spot).tolist(),
        "legacy_percent": (legacy_curve * 100.0).tolist(),
        "canonical_percent": (canonical_curve * 100.0).tolist(),
    }
    return metrics, visual


def _density_metrics(
    spot: float,
    left: dict[str, Any],
    right: dict[str, Any],
    *,
    include_visual: bool = False,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    lower = min(float(left["dense"][0]), float(right["dense"][0]))
    upper = max(float(left["dense"][-1]), float(right["dense"][-1]))
    grid = np.linspace(lower, upper, COMMON_DENSITY_GRID_POINTS)
    left_raw = np.interp(grid, left["dense"], left["raw"], left=0.0, right=0.0)
    right_raw = np.interp(
        grid, right["dense"], right["raw"], left=0.0, right=0.0
    )
    left_pdf = _positive_probability(left_raw, grid)
    right_pdf = _positive_probability(right_raw, grid)
    total_variation = 0.5 * float(simpson(np.abs(left_pdf - right_pdf), x=grid))
    left_cdf = np.concatenate(([0.0], cumulative_trapezoid(left_pdf, grid)))
    right_cdf = np.concatenate(([0.0], cumulative_trapezoid(right_pdf, grid)))
    left_cdf /= left_cdf[-1] if left_cdf[-1] > 0 else 1.0
    right_cdf /= right_cdf[-1] if right_cdf[-1] > 0 else 1.0
    left_mode = float(left["dense"][int(np.argmax(left["smooth"]))])
    right_mode = float(right["dense"][int(np.argmax(right["smooth"]))])
    metrics = {
        "common_grid_points": COMMON_DENSITY_GRID_POINTS,
        "positive_pdf_tv_distance": total_variation,
        "cdf_ks_distance": float(np.max(np.abs(left_cdf - right_cdf))),
        "left_mode_strike": left_mode,
        "right_mode_strike": right_mode,
        "mode_shift_percent_of_spot": abs(right_mode - left_mode) / spot * 100.0,
    }
    visual = None
    if include_visual:
        left_smooth = np.interp(
            grid, left["dense"], left["smooth"], left=0.0, right=0.0
        )
        right_smooth = np.interp(
            grid, right["dense"], right["smooth"], left=0.0, right=0.0
        )
        visual = {
            "moneyness": (grid / spot).tolist(),
            "legacy_smoothed": left_smooth.tolist(),
            "production_smoothed": right_smooth.tolist(),
        }
    return metrics, visual


def _engine_parity(
    reference_stage: dict[str, Any], production_stage: dict[str, Any]
) -> dict[str, Any]:
    strike_max_abs = _max_abs_difference(
        reference_stage["dense"], production_stage["dense"]
    )
    raw_max_abs = _max_abs_difference(
        reference_stage["raw"], production_stage["raw"]
    )
    smooth_max_abs = _max_abs_difference(
        reference_stage["smooth"], production_stage["smooth"]
    )
    vote_matches = {
        name: reference_stage["signals"]["votes"][name]
        == production_stage["signals"]["votes"][name]
        for name in VOTE_NAMES
    }
    verdict_matches = (
        reference_stage["signals"]["verdict"]
        == production_stage["signals"]["verdict"]
    )
    numeric_matches = bool(
        np.allclose(
            reference_stage["dense"],
            production_stage["dense"],
            rtol=ENGINE_RTOL,
            atol=ENGINE_ATOL,
        )
        and np.allclose(
            reference_stage["raw"],
            production_stage["raw"],
            rtol=ENGINE_RTOL,
            atol=ENGINE_ATOL,
        )
        and np.allclose(
            reference_stage["smooth"],
            production_stage["smooth"],
            rtol=ENGINE_RTOL,
            atol=ENGINE_ATOL,
        )
    )
    return {
        "passed": bool(numeric_matches and all(vote_matches.values()) and verdict_matches),
        "numeric_arrays_match": numeric_matches,
        "strike_max_abs": strike_max_abs,
        "raw_density_max_abs": raw_max_abs,
        "smoothed_density_max_abs": smooth_max_abs,
        "vote_matches": vote_matches,
        "model_verdict_matches": verdict_matches,
        "rtol": ENGINE_RTOL,
        "atol": ENGINE_ATOL,
    }


def _signal_transition(
    left: dict[str, Any], right: dict[str, Any]
) -> dict[str, Any]:
    vote_changes = {
        name: {
            "from": left["signals"]["votes"][name],
            "to": right["signals"]["votes"][name],
        }
        for name in VOTE_NAMES
        if left["signals"]["votes"][name]
        != right["signals"]["votes"][name]
    }
    from_verdict = left["signals"]["verdict"]
    to_verdict = right["signals"]["verdict"]
    return {
        "changed": bool(vote_changes or from_verdict != to_verdict),
        "vote_changes": vote_changes,
        "from_verdict": from_verdict,
        "to_verdict": to_verdict,
    }


def _reason_tags(
    *,
    legacy_observations: int,
    canonical_points: int,
    selection: dict[str, Any],
    calendar_t: float,
    exact_t: float,
    iv_metrics: dict[str, Any],
    model_verdict: str,
    final_verdict: str,
) -> list[str]:
    reasons: list[str] = []
    if legacy_observations > canonical_points:
        reasons.append("duplicate_strike_cleanup")
    if iv_metrics["max_abs_vol_points"] > 1e-9:
        reasons.append("otm_side_policy")
    rejected = sum(
        int(selection.get(name, 0))
        for name in (
            "rejected_invalid_contract_rows",
            "rejected_invalid_iv_rows",
            "rejected_missing_quote_rows",
            "rejected_zero_bid_rows",
            "rejected_crossed_quote_rows",
            "rejected_stale_quote_rows",
            "rejected_wide_spread_rows",
            "rejected_low_delta_rows",
            "rejected_low_open_interest_rows",
        )
    )
    if rejected:
        reasons.append("canonical_quote_validation")
    if int(selection.get("opposite_side_fallbacks", 0)):
        reasons.append("opposite_side_fallback")
    if bool(selection.get("synthetic_anchor_added")):
        reasons.append("atm_interpolation")
    if not math.isclose(calendar_t, exact_t, rel_tol=0.0, abs_tol=1e-14):
        reasons.append("exact_time_to_expiry")
    if model_verdict != final_verdict:
        reasons.append("curve_quality_gate")
    return reasons


def _density_quality(strikes: np.ndarray, density: np.ndarray) -> dict[str, Any]:
    negative_points = int(np.count_nonzero(density < 0.0))
    negative_area = max(
        float(simpson(np.clip(-density, 0, None), x=strikes)), 0.0
    )
    if negative_area > production.QUALITY_CAUTION_MAX_NEGATIVE_AREA:
        level = "LOW"
    elif negative_area > production.QUALITY_HIGH_MAX_NEGATIVE_AREA:
        level = "CAUTION"
    else:
        level = "HIGH"
    return {
        "level": level,
        "negative_grid_points": negative_points,
        "grid_point_count": len(strikes),
        "negative_grid_fraction": negative_points / len(strikes),
        "negative_area": negative_area,
        "clipping_required": negative_points > 0,
    }


def _positive_probability(values: np.ndarray, grid: np.ndarray) -> np.ndarray:
    positive = np.clip(values, 0, None)
    area = float(simpson(positive, x=grid))
    if not math.isfinite(area) or area <= 0:
        raise ValueError("Density comparison has no finite positive mass.")
    return positive / area


def _calendar_time_to_expiry(expiry: str, as_of: datetime) -> float:
    days = max((date.fromisoformat(expiry) - as_of.date()).days, 0)
    return days / 365.0


def _exact_time_to_expiry(expiry: str, as_of: datetime) -> float:
    seconds = (production.deribit_settlement(expiry) - as_of).total_seconds()
    if seconds <= 0:
        raise ValueError(f"Frozen case {expiry} is expired at its captured as_of.")
    return seconds / production.SECONDS_PER_YEAR


def _parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _positive_finite(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and parsed > 0 else None


def _normalize_signal(signal: str) -> str:
    return signal.strip().upper().replace(" ", "_")


def _max_abs_difference(left: np.ndarray, right: np.ndarray) -> float:
    if left.shape != right.shape:
        return math.inf
    return float(np.max(np.abs(left - right)))


def report_to_markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# IV Signal Scanner parity report",
        "",
        f"Overall status: **{summary['overall_status']}**. "
        f"{summary['pass_count']} pass, {summary['review_count']} review, "
        f"{summary['failure_count']} fail across {summary['case_count']} expiries.",
        "",
        "The staged comparison separates canonical IV selection, exact Deribit "
        "time-to-expiry, numerical engine parity, and final curve-quality gating.",
        "",
        "| Expiry | Exact T (h) | Legacy votes | Production votes | Verdict L/M/F | IV RMSE (vol pts) | PDF TV | Quality | Status | Reasons |",
        "|---|---:|---|---|---|---:|---:|---|---|---|",
    ]
    for case in report["cases"]:
        legacy_stage = case["stages"]["legacy_calendar_t"]
        production_stage = case["stages"]["production"]
        legacy_votes = _short_votes(legacy_stage["signals"]["votes"])
        production_votes = _short_votes(production_stage["signals"]["votes"])
        verdicts = "/".join(
            (
                legacy_stage["signals"]["verdict"],
                production_stage["model_verdict"],
                production_stage["final_verdict"],
            )
        )
        lines.append(
            "| {expiry} | {hours:.2f} | {legacy_votes} | {production_votes} | "
            "{verdicts} | {iv_rmse:.3f} | {tv:.3f} | {quality} | {status} | {reasons} |".format(
                expiry=case["expiry"],
                hours=case["time_to_expiry"]["exact_hours"],
                legacy_votes=legacy_votes,
                production_votes=production_votes,
                verdicts=verdicts,
                iv_rmse=case["metrics"]["iv_curve"]["rmse_vol_points"],
                tv=case["metrics"]["legacy_to_production_density"][
                    "positive_pdf_tv_distance"
                ],
                quality=production_stage["curve_quality"]["level"],
                status=case["status"],
                reasons=", ".join(case["reason_tags"]),
            )
        )
    lines.extend(
        [
            "",
            "## Release invariants",
            "",
            f"- Canonical exact-T reference matches production math: **{summary['engine_parity_passed']}**.",
            f"- LOW-quality trade leaks: **{summary['low_quality_trade_leaks']}**.",
            "- Canonical-versus-legacy changes are review findings, not hard failures.",
            "",
            "## Input provenance",
            "",
            f"- Endpoint: `{report['fixture']['source']['endpoint']}`",
            f"- Response SHA-256: `{report['fixture']['source']['response_sha256']}`",
            f"- Captured as of: `{report['fixture']['source']['captured_as_of']}`",
            f"- Reference app.py SHA-256: `{report['reference']['app_py_sha256']}`",
            "",
        ]
    )
    return "\n".join(lines)


def report_to_html(report: dict[str, Any]) -> str:
    cards = []
    for case in report["cases"]:
        quality = case["stages"]["production"]["curve_quality"]["level"]
        cards.append(
            "<section class='case'>"
            f"<h2>{html.escape(case['expiry'])} "
            f"<span class='{case['status'].lower()}'>{case['status']}</span></h2>"
            f"<p>Quality {quality} · "
            f"{html.escape(', '.join(case['reason_tags']))}</p>"
            "<h3>Normalized IV curve</h3>"
            + _svg_plot(
                case["visual"]["iv_curve"]["moneyness"],
                {
                    "Legacy": case["visual"]["iv_curve"]["legacy_percent"],
                    "Canonical": case["visual"]["iv_curve"]["canonical_percent"],
                },
            )
            + "<h3>Smoothed risk-neutral density</h3>"
            + _svg_plot(
                case["visual"]["density"]["moneyness"],
                {
                    "Legacy": case["visual"]["density"]["legacy_smoothed"],
                    "Production": case["visual"]["density"]["production_smoothed"],
                },
            )
            + "</section>"
        )
    summary = report["summary"]
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IV scanner parity</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101419;color:#dbe4ef}
body{max-width:1180px;margin:auto;padding:24px}.summary{color:#93a4b8}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(480px,1fr));gap:16px}.case{background:#161d25;border:1px solid #283442;border-radius:8px;padding:16px}.case h2{margin:0}.case h3{font-size:13px;color:#93a4b8;margin-bottom:4px}.case p{font-size:12px;color:#93a4b8;min-height:32px}.pass{color:#48d597}.review{color:#f1c75b}.fail{color:#ff6b72}.plot{width:100%;height:auto;background:#111820;border-radius:4px}.axis{stroke:#445363;stroke-width:1}.spot{stroke:#ff6b72;stroke-dasharray:4 4}.legacy{fill:none;stroke:#8ea0b5;stroke-width:1.5}.current{fill:none;stroke:#56b4ff;stroke-width:2}.legend{font-size:10px;fill:#aab8c8}
</style></head><body>""" + (
        f"<h1>IV Signal Scanner parity · {summary['overall_status']}</h1>"
        f"<p class='summary'>{summary['pass_count']} pass · "
        f"{summary['review_count']} review · {summary['failure_count']} fail</p>"
        f"<main class='grid'>{''.join(cards)}</main></body></html>"
    )


def _svg_plot(x_values: Sequence[float], series: dict[str, Sequence[float]]) -> str:
    width, height, pad = 520.0, 150.0, 20.0
    all_y = [float(value) for values in series.values() for value in values]
    x_min, x_max = min(x_values), max(x_values)
    y_min, y_max = min(all_y), max(all_y)
    y_span = max(y_max - y_min, 1e-12)
    x_span = max(x_max - x_min, 1e-12)

    def points(values: Sequence[float]) -> str:
        return " ".join(
            f"{pad + (float(x) - x_min) / x_span * (width - 2 * pad):.2f},"
            f"{height - pad - (float(y) - y_min) / y_span * (height - 2 * pad):.2f}"
            for x, y in zip(x_values, values, strict=True)
        )

    spot_x = pad + (1.0 - x_min) / x_span * (width - 2 * pad)
    polylines = []
    for index, (name, values) in enumerate(series.items()):
        class_name = "legacy" if index == 0 else "current"
        polylines.append(
            f"<polyline class='{class_name}' points='{points(values)}'/>"
            f"<text class='legend' x='{pad + index * 90:.0f}' y='12'>{html.escape(name)}</text>"
        )
    return (
        f"<svg class='plot' viewBox='0 0 {width:.0f} {height:.0f}' role='img'>"
        f"<line class='axis' x1='{pad}' y1='{height-pad}' x2='{width-pad}' y2='{height-pad}'/>"
        f"<line class='spot' x1='{spot_x:.2f}' y1='{pad}' x2='{spot_x:.2f}' y2='{height-pad}'/>"
        + "".join(polylines)
        + "</svg>"
    )


def _short_votes(votes: dict[str, str]) -> str:
    short = {"LONG": "L", "SHORT": "S", "NO_TRADE": "N"}
    return "/".join(short[votes[name]] for name in VOTE_NAMES)


def write_reports(
    report: dict[str, Any],
    *,
    json_path: str | Path,
    markdown_path: str | Path,
    html_path: str | Path | None = None,
) -> None:
    json_target = Path(json_path)
    markdown_target = Path(markdown_path)
    json_target.parent.mkdir(parents=True, exist_ok=True)
    markdown_target.parent.mkdir(parents=True, exist_ok=True)
    json_target.write_text(
        json.dumps(report, indent=2, default=_json_default, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    markdown_target.write_text(report_to_markdown(report), encoding="utf-8")
    if html_path is not None:
        html_target = Path(html_path)
        html_target.parent.mkdir(parents=True, exist_ok=True)
        html_target.write_text(report_to_html(report), encoding="utf-8")


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument(
        "--json-out", type=Path, default=DEFAULT_REPORT_DIR / "parity.json"
    )
    parser.add_argument(
        "--markdown-out", type=Path, default=DEFAULT_REPORT_DIR / "parity.md"
    )
    parser.add_argument(
        "--html-out", type=Path, default=DEFAULT_REPORT_DIR / "parity.html"
    )
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_parity_report(load_fixture(args.fixture))
    write_reports(
        report,
        json_path=args.json_out,
        markdown_path=args.markdown_out,
        html_path=args.html_out,
    )
    summary = report["summary"]
    print(
        f"IV parity {summary['overall_status']}: {summary['pass_count']} pass, "
        f"{summary['review_count']} review, {summary['failure_count']} fail"
    )
    print(f"JSON: {args.json_out}")
    print(f"Markdown: {args.markdown_out}")
    print(f"HTML: {args.html_out}")
    return 1 if summary["failure_count"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
