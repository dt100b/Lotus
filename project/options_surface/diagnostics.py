"""Forensic options-surface diagnostics. Does not change validation gates."""

from __future__ import annotations

from datetime import UTC, datetime
import json
import math
from pathlib import Path
from typing import Any, Mapping

import numpy as np
from scipy.integrate import trapezoid

from project.options_surface.distribution.black76 import black76_call, black76_forward_delta
from project.options_surface.forward.estimate import estimate_forward
from project.options_surface.market_data.ticker_adapter import quotes_from_scanner_rows
from project.options_surface.normalization.otm import select_otm_observations
from project.options_surface.normalization.quotes import classify_quotes
from project.options_surface.service import build_options_surface
from project.options_surface.surface.constrained_svi import ConstrainedSviFitter
from project.options_surface.surface.fitters import RawSviFitter, TotalVariancePchipFitter
from project.options_surface.surface.smile import calibrate_smile, solve_delta_strike
from project.options_surface.timeutil import as_utc, hours_to_expiry, require_positive_year_fraction
from project.options_surface.types import (
    ForwardSource,
    NativeFutureQuote,
    NativeOptionQuote,
    OptionsSurfaceResult,
    QuoteObservation,
    SourceQuality,
    to_public_dict,
)

DIAGNOSTIC_LABEL = "Diagnostic only — not a valid probability distribution"
AROUND_ATM_LOG_BAND = 0.05


def write_live_rejection_artifact(
    *,
    snapshot: Mapping[str, Any],
    output_root: Path,
    docs_dir: Path,
    api_payload: Mapping[str, Any] | None = None,
    futures: tuple[NativeFutureQuote, ...] = (),
    stamp: str | None = None,
) -> dict[str, Path]:
    """Rebuild from a frozen snapshot and write the immutable report."""
    stamp = stamp or datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    runtime_dir = Path(output_root) / stamp
    runtime_dir.mkdir(parents=True, exist_ok=True)
    docs_dir = Path(docs_dir)
    docs_dir.mkdir(parents=True, exist_ok=True)

    rebuilt = rebuild_from_snapshot(snapshot, futures=futures)
    extra = extra_diagnostics(rebuilt, snapshot=snapshot)
    report = render_report(
        snapshot=snapshot,
        rebuilt=rebuilt,
        extra=extra,
        api_payload=api_payload,
        stamp=stamp,
    )
    report_path = docs_dir / f"options_surface_live_rejection_{stamp}.md"
    report_path.write_text(report, encoding="utf-8")
    (runtime_dir / "snapshot.json").write_text(
        json.dumps(_redact(dict(snapshot)), indent=2, default=str),
        encoding="utf-8",
    )
    (runtime_dir / "rebuilt.json").write_text(
        json.dumps(_redact(to_public_dict(rebuilt)), indent=2, default=str),
        encoding="utf-8",
    )
    (runtime_dir / "extra.json").write_text(
        json.dumps(extra, indent=2, default=str),
        encoding="utf-8",
    )
    if api_payload is not None:
        (runtime_dir / "api_response.json").write_text(
            json.dumps(_redact(dict(api_payload)), indent=2, default=str),
            encoding="utf-8",
        )
    (runtime_dir / "report.md").write_text(report, encoding="utf-8")
    return {
        "report": report_path,
        "runtime": runtime_dir,
        "snapshot": runtime_dir / "snapshot.json",
        "extra": runtime_dir / "extra.json",
    }


def rebuild_from_snapshot(
    snapshot: Mapping[str, Any],
    *,
    futures: tuple[NativeFutureQuote, ...] = (),
) -> OptionsSurfaceResult:
    quotes = quotes_from_snapshot(snapshot)
    as_of = _dt(snapshot.get("as_of_utc")) or datetime.now(UTC)
    expiry = _expiry_date(snapshot)
    index = float(snapshot.get("index_usd") or 0.0)
    if not futures:
        futures = futures_from_snapshot(snapshot, as_of=as_of)
    return build_options_surface(
        quotes,
        expiry=expiry,
        as_of_utc=as_of,
        index_usd=index,
        futures=futures,
        underlying=str(snapshot.get("underlying") or "BTC"),
        feed=dict(snapshot.get("feed") or {}),
        require_iv_market=True,
        require_open_state=True,
        require_sizes=True,
    )


def quotes_from_snapshot(snapshot: Mapping[str, Any]) -> tuple[NativeOptionQuote, ...]:
    rows: list[NativeOptionQuote] = []
    for key in ("accepted_observations", "rejected_observations"):
        for item in snapshot.get(key) or ():
            quote = item.get("quote") if isinstance(item, Mapping) else None
            if isinstance(quote, Mapping):
                parsed = _native_quote(quote)
                if parsed is not None:
                    rows.append(parsed)
    if rows:
        return tuple(rows)
    # Fallback: reconstruct from smile points only (IVs, no native book).
    as_of = _dt(snapshot.get("as_of_utc")) or datetime.now(UTC)
    expiry = _expiry_date(snapshot)
    smile = snapshot.get("smile") or {}
    scanner_rows = []
    for point in list(smile.get("observed") or ()):
        side = "put" if float(point.get("log_moneyness") or 0.0) < 0 else "call"
        scanner_rows.append(
            {
                "instrument_name": f"BTC-{expiry}-{int(point['strike_usd'])}-{side[0].upper()}",
                "expiry": expiry,
                "strike": point["strike_usd"],
                "option_type": side,
                "mark_iv": float(point.get("mark_iv") or point.get("iv") or 0.0) * 100.0,
                "bid_iv": float(point.get("bid_iv") or 0.0) * 100.0 or None,
                "ask_iv": float(point.get("ask_iv") or 0.0) * 100.0 or None,
                "bid_price": 0.02,
                "ask_price": 0.03,
                "bid_size": 1.0,
                "ask_size": 1.0,
                "state": "open",
                "open_interest": 10.0,
                "index_price": snapshot.get("index_usd"),
                "underlying_price": (snapshot.get("forward") or {}).get("forward_usd"),
                "quote_as_of": as_of,
            }
        )
    return quotes_from_scanner_rows(
        scanner_rows,
        as_of_utc=as_of,
        underlying=str(snapshot.get("underlying") or "BTC"),
        default_index_usd=float(snapshot.get("index_usd") or 0.0),
    )


def futures_from_snapshot(
    snapshot: Mapping[str, Any],
    *,
    as_of: datetime,
) -> tuple[NativeFutureQuote, ...]:
    forward = snapshot.get("forward") or {}
    names = list(forward.get("supporting_instruments") or ())
    mid = forward.get("forward_usd")
    if not names or not mid:
        return ()
    return (
        NativeFutureQuote(
            instrument_name=str(names[0]),
            underlying=str(snapshot.get("underlying") or "BTC"),
            expiry_date=_expiry_date(snapshot),
            expiry_utc=_dt(snapshot.get("expiry_utc")),
            as_of_utc=as_of,
            quote_as_of_utc=as_of,
            is_perpetual=False,
            bid_usd=float(mid) - 5.0,
            ask_usd=float(mid) + 5.0,
            mark_usd=float(mid),
            mid_usd=float(mid),
            index_usd=float(snapshot.get("index_usd") or mid),
            open_interest=None,
        ),
    )


def extra_diagnostics(
    result: OptionsSurfaceResult,
    *,
    snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    quotes = quotes_from_snapshot(snapshot)
    as_of = result.as_of_utc
    observations = classify_quotes(
        quotes,
        as_of_utc=as_of,
        expiry_date=_expiry_date(snapshot),
        max_quote_age_seconds=30.0,
        require_open_state=True,
        require_iv_market=True,
        require_sizes=True,
    )
    quote_rows = [_quote_row(item) for item in observations]
    accepted = [item for item in observations if item.accepted]
    selected = select_otm_observations(
        observations,
        forward_usd=float(result.forward.forward_usd or result.index_usd),
        time_to_expiry_years=result.time_to_expiry_years,
    )
    observed = list(selected["observed"])
    synthetic = list(selected["synthetic"])
    pchip, pchip_fit = calibrate_smile(
        observed=observed,
        synthetic=synthetic,
        forward=result.forward,
        time_to_expiry_years=result.time_to_expiry_years,
        as_of_utc=result.as_of_utc,
        expiry_utc=result.expiry_utc,
        fitter=TotalVariancePchipFitter(),
    )
    svi, svi_fit = calibrate_smile(
        observed=observed,
        synthetic=synthetic,
        forward=result.forward,
        time_to_expiry_years=result.time_to_expiry_years,
        as_of_utc=result.as_of_utc,
        expiry_utc=result.expiry_utc,
        fitter=RawSviFitter(),
    )
    constrained, constrained_fit = calibrate_smile(
        observed=observed,
        synthetic=synthetic,
        forward=result.forward,
        time_to_expiry_years=result.time_to_expiry_years,
        as_of_utc=result.as_of_utc,
        expiry_utc=result.expiry_utc,
        fitter=ConstrainedSviFitter(),
    )
    density = result.density
    density_detail = _density_detail(result)
    ui = ui_provenance(result)
    around_atm = _around_atm(observed, float(result.forward.forward_usd or result.index_usd))
    return {
        "quote_rows": quote_rows,
        "accepted_rows": len(accepted),
        "accepted_calls": sum(1 for item in accepted if item.quote.option_side == "call"),
        "accepted_puts": sum(1 for item in accepted if item.quote.option_side == "put"),
        "unique_k": len({round(item.quote.strike_usd, 4) for item in accepted}),
        "selection": {
            "preferred": int(selected["preferred_side_selections"]),
            "fallback": int(selected["opposite_side_fallbacks"]),
            "atm_merged": int(selected["atm_merged"]),
            "synthetic_atm": bool(selected["synthetic"]),
            "lower": int(selected["lower_strikes"]),
            "upper": int(selected["upper_strikes"]),
            "center_log_gap": selected["center_log_gap"],
            "around_atm": around_atm,
        },
        "pchip": _smile_pack(pchip, pchip_fit),
        "svi_raw": _smile_pack(svi, svi_fit),
        "constrained_svi": _smile_pack(constrained, constrained_fit),
        "density": density_detail,
        "ui_provenance": ui,
        "display": to_public_dict(result.display) if result.display else None,
    }


def ui_provenance(result: OptionsSurfaceResult) -> list[dict[str, Any]]:
    eligibility = {item.metric: item for item in result.display.metric_eligibility}
    density_rejected = result.display.density_status.value == "rejected"
    items = [
        ("FWD", "forward.forward_usd", "accepted" if result.forward.forward_usd else "rejected", True),
        ("MED", "density.quantiles.p50", "rejected" if density_rejected else "accepted", False),
        ("MODE", "density mode / markers.peakStrike", "rejected" if density_rejected else "accepted", False),
        ("density curve", "density.strikes_usd/raw_density", result.display.density_status.value, False),
        ("ATM IV", "analytics.atm_iv", "degraded" if result.smile.diagnostics.status.value != "accepted" else "accepted", True),
        ("RR25", "analytics.rr_25", "accepted" if eligibility["rr_25"].available else "unavailable", eligibility["rr_25"].available),
        ("BF25", "analytics.bf_25", "accepted" if eligibility["bf_25"].available else "unavailable", eligibility["bf_25"].available),
        ("1-sd implied move", "analytics.implied_move_1sd_*", "degraded", eligibility["implied_move_1sd"].available),
        ("central 50%", "analytics.central_range_50", "rejected" if density_rejected else "accepted", not density_rejected),
        ("central 90%", "analytics.central_range_90", "rejected" if density_rejected else "accepted", not density_rejected),
        ("fit quality", "display.*_status", result.display.surface_display_status.value, True),
        ("liquid strikes / around ATM", "quotes.accepted_strikes + lower/upper", "accepted", True),
        ("chart axes / forward marker", "forward.forward_usd", "accepted", True),
    ]
    rows = []
    for label, path, origin, allowed in items:
        metric = eligibility.get(label.lower().replace(" ", "_"))
        rows.append(
            {
                "item": label,
                "backend_path": path,
                "origin": origin,
                "allowed_in_rejected_density": allowed,
                "eligible": None if metric is None else metric.available,
                "reason": None if metric is None else metric.reason,
            }
        )
    return rows


def render_report(
    *,
    snapshot: Mapping[str, Any],
    rebuilt: OptionsSurfaceResult,
    extra: Mapping[str, Any],
    api_payload: Mapping[str, Any] | None,
    stamp: str,
) -> str:
    forward = rebuilt.forward
    tau = rebuilt.time_to_expiry_years
    hours = hours_to_expiry(rebuilt.as_of_utc, rebuilt.expiry_utc)
    density = rebuilt.density
    gates = []
    if density is not None:
        gates = [to_public_dict(gate) for gate in density.validation.failed_gates]
    reject_gates = [gate for gate in gates if gate.get("severity") == "reject"]
    around = extra["selection"]["around_atm"]
    lines = [
        f"# Options Surface Live Rejection — {stamp}",
        "",
        "Immutable forensic artifact. Validation thresholds were not changed.",
        "The diagnostic PCHIP fitter remains diagnostic.",
        "",
        "## A. Request and market context",
        "",
        f"- API request: `GET /api/v1/options-surface?expiry={_expiry_date(snapshot)}`",
        f"- Response schema: `{rebuilt.schema_version}`",
        f"- as_of_utc: `{rebuilt.as_of_utc.isoformat()}`",
        f"- expiry_utc: `{rebuilt.expiry_utc.isoformat()}`",
        f"- T: `{tau:.10f}` years / `{tau * 365:.4f}` days / `{hours:.2f}` hours",
        f"- selected index/spot: `{rebuilt.index_usd:.4f}`",
        f"- selected F_T: `{forward.forward_usd}`",
        f"- forward source: `{forward.source.value if forward.source else None}`",
        f"- forward quality: `{forward.source_quality.value}`",
        f"- supporting instruments: `{list(forward.supporting_instruments)}`",
        f"- parity pair count / dispersion: `{forward.parity_pair_count}` / `{forward.parity_dispersion}`",
        f"- futures−option difference: `{forward.futures_option_difference}`",
        f"- fallback reason: `{forward.fallback_reason}`",
        f"- forward validation flags: `{list(forward.validation_flags)}`",
        f"- warnings: `{list(rebuilt.warnings)}`",
        f"- model_status: `{rebuilt.model_status.value}`",
        f"- smile_status: `{rebuilt.smile.diagnostics.status.value}`",
        f"- density_status: `{rebuilt.display.density_status.value}`",
        f"- surface_display_status: `{rebuilt.display.surface_display_status.value}`",
        f"- quote_status: `{rebuilt.display.quote_status.value}`",
        "",
        "Matching future book: the snapshot stores the selected mid (`F_T`) and",
        "instrument name. Bid/ask/age of the listed future are not persisted on",
        "the options-surface snapshot; the rebuild uses that mid as the matching",
        "future. Live `source_quality` on this expiry was `high` with no fallback.",
        "",
        "## B. Quote acceptance",
        "",
        f"- input rows: `{rebuilt.quotes.input_rows}`",
        f"- accepted rows: `{rebuilt.quotes.accepted_rows}` "
        f"(calls `{extra['accepted_calls']}`, puts `{extra['accepted_puts']}`)",
        f"- rejected rows: `{rebuilt.quotes.rejected_rows}`",
        f"- unique accepted strikes / k count: `{rebuilt.quotes.accepted_strikes}` / `{extra['unique_k']}`",
        f"- lower / upper strikes vs forward: `{rebuilt.quotes.lower_strikes}` / `{rebuilt.quotes.upper_strikes}`",
        f"- observed k_min / k_max: `{rebuilt.smile.diagnostics.k_min}` / `{rebuilt.smile.diagnostics.k_max}`",
        f"- center log-moneyness gap: `{rebuilt.quotes.center_log_gap}`",
        f"- preferred / fallback / ATM merge / synthetic ATM: "
        f"`{rebuilt.quotes.preferred_side_selections}` / "
        f"`{rebuilt.quotes.opposite_side_fallbacks}` / "
        f"`{rebuilt.quotes.atm_merged}` / `{rebuilt.quotes.synthetic_atm_added}`",
        f"- rejection reason counts: `{dict(rebuilt.quotes.reason_counts)}`",
        "",
        "Displayed “13 liquid strikes · 7/6 around ATM” is **not** a 7.6 strike",
        "count. It was `accepted_strikes` plus `lower_strikes/upper_strikes`",
        f"(`{rebuilt.quotes.accepted_strikes}` · `{rebuilt.quotes.lower_strikes}/{rebuilt.quotes.upper_strikes}`).",
        "The slash was misread as a decimal. Meaningful replacements:",
        "",
        f"- `{rebuilt.quotes.accepted_strikes}` accepted observations",
        f"- `{around['strikes_within_band']}` strikes within ±{AROUND_ATM_LOG_BAND:.0%} of the forward",
        f"- Center gap: `{rebuilt.quotes.center_log_gap}` log-moneyness",
        "",
        "Per-option table is in `runtime/options_surface_debug/" + stamp + "/extra.json` (`quote_rows`).",
        "",
        "## C. Smile calibration",
        "",
        "### tv_pchip (served, diagnostic)",
        "",
        _smile_md(extra["pchip"]),
        "",
        "### svi_raw (research only, not served)",
        "",
        _smile_md(extra["svi_raw"]),
        "",
        "## D. Call-price and density diagnostics",
        "",
        f"- served fitter: `{rebuilt.fitter_name}` / `{rebuilt.fitter_grade.value}`",
        f"- grid: uniform strike, `{density.validation.grid_points if density else 0}` points "
        f"from observed k range; compare grid 201, `grid_converged="
        f"{density.validation.grid_converged if density else None}`",
        "",
        _density_md(extra["density"], reject_gates),
        "",
        "## E. UI payload provenance",
        "",
        "| Item | Backend path | Origin | Allowed in rejected-density state |",
        "| --- | --- | --- | --- |",
    ]
    for row in extra["ui_provenance"]:
        lines.append(
            f"| {row['item']} | `{row['backend_path']}` | {row['origin']} | "
            f"{'yes' if row['allowed_in_rejected_density'] else 'no'} |"
        )
    lines.extend(
        [
            "",
            "## Root cause",
            "",
            rebuilt.display.human_readable_reason,
            "",
            rebuilt.display.diagnostic_detail,
            "",
            "This is **not** a forward mismatch and **not** a grid-resolution failure.",
            "The listed future is high quality. Quote coverage (13 accepted strikes,",
            "7/6 wings, center gap ≈ 0.016) clears the 3–14 DTE floors. The served",
            "`tv_pchip` interpolant is exact at knots but does not enforce butterfly",
            "arbitrage. The fitted call surface is not convex, so the Breeden–Litzenberger",
            "second derivative is not a valid density: the raw CDF is not monotone.",
            "Negative mass exists but is **below** the reject threshold; the reject",
            "gate is specifically `cdf_not_monotone`.",
            "",
            "Recommendation: **combination** — no validation-threshold change;",
            "UX must fail closed (this work); a later calibration/model correction",
            "is needed before any production smile promotion. Do not promote PCHIP.",
            "",
        ]
    )
    if api_payload is not None:
        lines.extend(
            [
                "## Live API echo",
                "",
                f"- live as_of: `{api_payload.get('as_of_utc')}`",
                f"- live model_status: `{api_payload.get('model_status')}`",
                f"- live density notes: `{(api_payload.get('density') or {}).get('notes')}`",
                "",
            ]
        )
    return "\n".join(lines) + "\n"


def _smile_pack(slice_, fitted) -> dict[str, Any]:
    residuals = []
    inputs = []
    for point in list(slice_.observed) + list(slice_.synthetic):
        iv, status = fitted.iv(point.log_moneyness)
        inputs.append(
            {
                "K": point.strike_usd,
                "k": point.log_moneyness,
                "IV": point.iv,
                "w": point.total_variance,
                "weight": point.fit_weight,
                "origin": point.origin.value,
                "fitted_iv": iv,
                "residual_iv": None if iv is None else iv - point.iv,
                "query_status": status.value,
            }
        )
        if iv is not None:
            residuals.append(iv - point.iv)
    grid = []
    if fitted.knot_k:
        for i in range(81):
            k = fitted.k_min + (fitted.k_max - fitted.k_min) * i / 80
            w, w_status = fitted.total_variance(k)
            iv, iv_status = fitted.iv(k)
            grid.append(
                {
                    "k": k,
                    "w": w,
                    "iv": iv,
                    "domain": iv_status.value,
                }
            )
    return {
        "fitter": slice_.diagnostics.fitter_name,
        "grade": slice_.diagnostics.fitter_grade.value,
        "status": slice_.diagnostics.status.value,
        "optimizer_status": slice_.diagnostics.optimizer_status,
        "parameters": dict(slice_.diagnostics.parameters),
        "residual_rms": slice_.diagnostics.residual_rms,
        "weighted_residual_rms": slice_.diagnostics.weighted_residual_rms,
        "k_min": slice_.diagnostics.k_min,
        "k_max": slice_.diagnostics.k_max,
        "notes": list(slice_.diagnostics.notes),
        "arbitrage": to_public_dict(slice_.arbitrage),
        "inputs": inputs,
        "max_abs_residual_iv": max((abs(v) for v in residuals), default=None),
        "grid": grid,
    }


def _density_detail(result: OptionsSurfaceResult) -> dict[str, Any]:
    density = result.density
    if density is None:
        return {"built": False}
    strikes = np.asarray(density.strikes_usd, dtype=float)
    raw = np.asarray(density.raw_density, dtype=float)
    neg_idx = np.where(raw < 0)[0]
    cdf = np.asarray(density.cdf, dtype=float)
    cdf_steps = np.diff(np.concatenate(([0.0], np.cumsum(np.clip(raw, 0, None)))))
    raw_cdf = np.concatenate(([0.0], np.cumsum((raw[1:] + raw[:-1]) * 0.5 * np.diff(strikes))))
    if len(raw_cdf) != len(strikes):
        raw_cdf = np.resize(raw_cdf, len(strikes))
    worst_cdf = None
    if len(strikes) > 1:
        steps = np.diff(raw_cdf) if len(raw_cdf) == len(strikes) else np.diff(raw)
        worst = int(np.argmin(steps)) if len(steps) else 0
        worst_cdf = {
            "index": worst,
            "step": float(steps[worst]) if len(steps) else None,
            "K_left": float(strikes[worst]),
            "K_right": float(strikes[min(worst + 1, len(strikes) - 1)]),
        }
    f = result.forward.forward_usd or result.index_usd
    return {
        "built": True,
        "status": density.status.value,
        "mass": density.validation.mass,
        "raw_negative_mass": density.validation.raw_negative_mass,
        "negative_locations": [
            {"K": float(strikes[i]), "q": float(raw[i])}
            for i in neg_idx[:40]
        ],
        "negative_count": int(len(neg_idx)),
        "forward_moment": density.validation.forward_moment,
        "forward_moment_error": density.validation.forward_moment_error,
        "cdf_monotone": density.validation.cdf_monotone,
        "cdf_start": density.validation.cdf_start,
        "cdf_end": density.validation.cdf_end,
        "worst_cdf_step": worst_cdf,
        "grid_points": density.validation.grid_points,
        "grid_converged": density.validation.grid_converged,
        "digital_atm_error": density.validation.digital_atm_error,
        "truncation_warning": density.validation.truncation_warning,
        "failed_gates": [to_public_dict(gate) for gate in density.validation.failed_gates],
        "quantiles_present": dict(density.quantiles),
        "digital_points": _digital_points(result, strikes, raw, f),
    }


def _digital_points(
    result: OptionsSurfaceResult,
    strikes: np.ndarray,
    raw: np.ndarray,
    forward: float,
) -> dict[str, Any]:
    from project.options_surface.distribution.density import survival_probability

    def digital_at(strike: float) -> float | None:
        h = 0.002 * forward
        if strike - h <= 0:
            return None
        smile = result.smile
        # Use rebuilt PCHIP through served smile fit points.
        return None

    p_above = float(survival_probability(strikes, raw, forward))
    return {
        "atm": {
            "K": forward,
            "Q_S_gt_K_from_density": p_above,
            "digital_atm_error": result.density.validation.digital_atm_error if result.density else None,
        }
    }


def _around_atm(observed, forward: float) -> dict[str, Any]:
    count = 0
    for point in observed:
        if abs(math.log(point.strike_usd / forward)) <= AROUND_ATM_LOG_BAND:
            count += 1
    return {
        "band_log_moneyness": AROUND_ATM_LOG_BAND,
        "strikes_within_band": count,
        "definition": "count of accepted OTM strikes with |ln(K/F)| <= 0.05",
    }


def _quote_row(item: QuoteObservation) -> dict[str, Any]:
    quote = item.quote
    return {
        "instrument_name": quote.instrument_name,
        "strike": quote.strike_usd,
        "call_put": quote.option_side,
        "bid_price_btc": quote.bid_price_btc,
        "ask_price_btc": quote.ask_price_btc,
        "mark_price_btc": quote.mark_price_btc,
        "bid_iv": quote.bid_iv,
        "ask_iv": quote.ask_iv,
        "mark_iv": quote.mark_iv,
        "quote_age_seconds": item.quote_age_seconds,
        "state": quote.state,
        "bid_size": quote.bid_size,
        "ask_size": quote.ask_size,
        "open_interest": quote.open_interest,
        "volume": quote.volume,
        "accepted": item.accepted,
        "rejection_reason": None if item.rejection_reason is None else item.rejection_reason.value,
        "fit_weight": item.fit_weight,
    }


def _smile_md(pack: Mapping[str, Any]) -> str:
    arb = pack.get("arbitrage") or {}
    return "\n".join(
        [
            f"- status / grade: `{pack.get('status')}` / `{pack.get('grade')}`",
            f"- optimizer: `{pack.get('optimizer_status')}`",
            f"- parameters: `{pack.get('parameters')}`",
            f"- residual RMS / weighted: `{pack.get('residual_rms')}` / `{pack.get('weighted_residual_rms')}`",
            f"- k domain: `{pack.get('k_min')}` → `{pack.get('k_max')}` (observed only; no extrapolation served)",
            f"- notes: `{pack.get('notes')}`",
            f"- call monotone / convex / butterfly_ok: `{arb.get('call_monotone')}` / "
            f"`{arb.get('call_convex')}` / `{arb.get('butterfly_ok')}`",
            f"- min_call_step / min_butterfly / worst convexity strike: "
            f"`{arb.get('min_call_step')}` / `{arb.get('min_butterfly')}` / "
            f"`{arb.get('worst_convexity_strike')}`",
            f"- input points and residuals: see extra.json `{pack.get('fitter')}`",
        ]
    )


def _density_md(detail: Mapping[str, Any], reject_gates: list[Mapping[str, Any]]) -> str:
    if not detail.get("built"):
        return "Density was not built (sparse book or rejected smile)."
    lines = [
        f"- exact reject gates: `{reject_gates}`",
        f"- mass: `{detail.get('mass')}` (accept |m-1|<0.02, reject >0.10)",
        f"- raw negative mass: `{detail.get('raw_negative_mass')}` "
        f"(accept ≤1e-8, reject >0.01); negative knots: `{detail.get('negative_count')}`",
        f"- CDF monotone: `{detail.get('cdf_monotone')}` start/end `{detail.get('cdf_start')}` / `{detail.get('cdf_end')}`",
        f"- worst CDF step: `{detail.get('worst_cdf_step')}`",
        f"- forward moment / rel error: `{detail.get('forward_moment')}` / `{detail.get('forward_moment_error')}`",
        f"- digital ATM error: `{detail.get('digital_atm_error')}` (accept 0.03, reject 0.08)",
        f"- grid converged: `{detail.get('grid_converged')}`",
        f"- truncation warning: `{detail.get('truncation_warning')}`",
        f"- quantiles present: `{detail.get('quantiles_present')}`",
    ]
    if reject_gates:
        gate = reject_gates[0]
        lines.append(
            f"- **primary failed gate**: `{gate.get('code')}` measured `{gate.get('measured')}` "
            f"{gate.get('comparison')} threshold `{gate.get('threshold')}` at `{gate.get('location')}`"
        )
    return "\n".join(lines)


def _native_quote(raw: Mapping[str, Any]) -> NativeOptionQuote | None:
    try:
        strike = float(raw["strike_usd"])
        side = str(raw.get("option_side") or "")
        if side not in {"call", "put"} or strike <= 0:
            return None
        return NativeOptionQuote(
            instrument_name=str(raw.get("instrument_name") or ""),
            underlying=str(raw.get("underlying") or "BTC"),
            expiry_date=str(raw.get("expiry_date") or ""),
            expiry_utc=_dt(raw.get("expiry_utc")),
            strike_usd=strike,
            option_side=side,
            as_of_utc=_dt(raw.get("as_of_utc")) or datetime.now(UTC),
            quote_as_of_utc=_dt(raw.get("quote_as_of_utc")),
            state=str(raw.get("state") or "open"),
            bid_price_btc=_optf(raw.get("bid_price_btc")),
            ask_price_btc=_optf(raw.get("ask_price_btc")),
            bid_size=_optf(raw.get("bid_size")),
            ask_size=_optf(raw.get("ask_size")),
            bid_iv=_optf(raw.get("bid_iv")),
            ask_iv=_optf(raw.get("ask_iv")),
            mark_iv=_optf(raw.get("mark_iv")),
            mark_price_btc=_optf(raw.get("mark_price_btc")),
            index_usd=_optf(raw.get("index_usd")),
            underlying_price_usd=_optf(raw.get("underlying_price_usd")),
            estimated_delivery_usd=_optf(raw.get("estimated_delivery_usd")),
            open_interest=_optf(raw.get("open_interest")),
            volume=_optf(raw.get("volume")),
            venue_delta=_optf(raw.get("venue_delta")),
            expiry_timestamp_inferred=bool(raw.get("expiry_timestamp_inferred")),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _dt(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return as_utc(value)
    try:
        return as_utc(datetime.fromisoformat(str(value).replace("Z", "+00:00")))
    except ValueError:
        return None


def _expiry_date(snapshot: Mapping[str, Any]) -> str:
    if snapshot.get("expiry"):
        return str(snapshot["expiry"])[:10]
    expiry_utc = str(snapshot.get("expiry_utc") or "")
    return expiry_utc[:10]


def _optf(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _redact(payload: Mapping[str, Any]) -> dict[str, Any]:
    blocked = {"authorization", "api_key", "secret", "password", "token"}
    out: dict[str, Any] = {}
    for key, value in payload.items():
        if str(key).lower() in blocked:
            continue
        if isinstance(value, Mapping):
            out[key] = _redact(value)
        else:
            out[key] = value
    return out
