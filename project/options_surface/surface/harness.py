"""Deterministic three-candidate smile calibration harness."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from project.options_surface.distribution.density import extract_density
from project.options_surface.service import build_options_surface
from project.options_surface.surface.constrained_svi import ConstrainedSviFitter
from project.options_surface.surface.fitters import RawSviFitter, TotalVariancePchipFitter
from project.options_surface.surface.selection import (
    compare_fitted,
    evaluate_fitted_call_curve,
)
from project.options_surface.surface.svi import svi_w
from project.options_surface.surface.smile import calibrate_smile
from project.options_surface.timeutil import inferred_deribit_expiry_utc, require_positive_year_fraction
from project.options_surface.types import (
    ForwardEstimate,
    ForwardSource,
    ModelStatus,
    PointOrigin,
    SmilePoint,
    SourceQuality,
    to_public_dict,
)
from project.options_surface.types import NativeFutureQuote

AS_OF = datetime(2030, 8, 15, 12, tzinfo=UTC)
EXPIRY = "2030-08-16"
FORWARD = 100_000.0
INDEX = 99_800.0
SIGMA = 0.50

FROZEN_AUG21 = (
    Path(__file__).resolve().parents[3]
    / "runtime"
    / "options_surface_debug"
    / "20260816T230839Z"
    / "snapshot.json"
)
DEFAULT_OUTPUT = (
    Path(__file__).resolve().parents[3]
    / "runtime"
    / "options_surface_debug"
    / "calibration_harness"
)


@dataclass(frozen=True, slots=True)
class HarnessCase:
    name: str
    description: str
    points: tuple[SmilePoint, ...]
    forward_usd: float
    time_to_expiry_years: float
    as_of_utc: datetime
    expiry_utc: datetime
    rows: tuple[Mapping[str, Any], ...] | None = None
    futures: tuple[Any, ...] = ()
    index_usd: float = INDEX
    expiry: str = EXPIRY


def run_harness(
    *,
    output_dir: Path | None = None,
    include_live: bool = True,
) -> dict[str, Any]:
    output = Path(output_dir or DEFAULT_OUTPUT)
    output.mkdir(parents=True, exist_ok=True)
    cases = list(synthetic_cases())
    if include_live:
        live = live_cases()
        cases.extend(live)
    report = {
        "schema": "options_surface.calibration_harness.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "cases": [run_case(case) for case in cases],
    }
    (output / "harness_report.json").write_text(
        json.dumps(report, indent=2, default=str),
        encoding="utf-8",
    )
    (output / "harness_report.md").write_text(_render_markdown(report), encoding="utf-8")
    return report


def synthetic_cases() -> list[HarnessCase]:
    tau = require_positive_year_fraction(AS_OF, inferred_deribit_expiry_utc(EXPIRY))
    expiry_utc = inferred_deribit_expiry_utc(EXPIRY)
    flat_points = _points_from_iv(
        [FORWARD * r for r in (0.70, 0.80, 0.90, 0.95, 1.00, 1.05, 1.10, 1.20, 1.30, 1.40)],
        ivs=[SIGMA] * 10,
        tau=tau,
        forward=FORWARD,
    )
    known = (0.00035, 0.008, -0.35, -0.01, 0.09)
    known_ks = np.linspace(-0.25, 0.20, 11)
    known_ws = np.asarray(svi_w(known_ks, known), dtype=float)
    known_ivs = np.sqrt(np.maximum(known_ws, 0.0) / tau)
    known_points = _points_from_k(known_ks, known_ivs, tau, FORWARD)
    rng = np.random.default_rng(7)
    noisy_ivs = known_ivs + rng.uniform(-0.015, 0.015, size=known_ivs.shape)
    noisy_points = _points_from_k(known_ks, noisy_ivs, tau, FORWARD)
    outlier_ivs = list(known_ivs)
    outlier_ivs[2] = float(known_ivs[2] + 0.18)
    outlier_points = _points_from_k(known_ks, outlier_ivs, tau, FORWARD, weights=None)
    outlier_list = list(outlier_points)
    old = outlier_list[2]
    outlier_list[2] = SmilePoint(
        strike_usd=old.strike_usd,
        log_moneyness=old.log_moneyness,
        iv=old.iv,
        total_variance=old.total_variance,
        origin=old.origin,
        option_side=old.option_side,
        classification=old.classification,
        bid_iv=old.bid_iv,
        ask_iv=old.ask_iv,
        mark_iv=old.mark_iv,
        quote_age_seconds=old.quote_age_seconds,
        fit_weight=0.08,
        source=old.source,
        forward_delta=old.forward_delta,
    )
    kink_ivs = [0.80 if k < -0.04 else 0.40 if k > 0.04 else 0.50 for k in known_ks]
    kink_points = _points_from_k(known_ks, kink_ivs, tau, FORWARD)
    sparse_points = _points_from_iv(
        [FORWARD * 0.95, FORWARD, FORWARD * 1.05],
        ivs=[SIGMA, SIGMA, SIGMA],
        tau=tau,
        forward=FORWARD,
    )
    return [
        HarnessCase(
            name="flat_vol",
            description="Flat 50% vol chain with a matching listed future.",
            points=flat_points,
            forward_usd=FORWARD,
            time_to_expiry_years=tau,
            as_of_utc=AS_OF,
            expiry_utc=expiry_utc,
            rows=tuple(_flat_rows()),
            futures=(_listed_future(),),
        ),
        HarnessCase(
            name="known_svi",
            description="Synthetic quotes generated from a valid raw-SVI slice.",
            points=known_points,
            forward_usd=FORWARD,
            time_to_expiry_years=tau,
            as_of_utc=AS_OF,
            expiry_utc=expiry_utc,
            rows=tuple(_rows_from_points(known_points)),
            futures=(_listed_future(),),
        ),
        HarnessCase(
            name="noisy_known_svi",
            description="Known SVI observations with bounded additive IV noise.",
            points=noisy_points,
            forward_usd=FORWARD,
            time_to_expiry_years=tau,
            as_of_utc=AS_OF,
            expiry_utc=expiry_utc,
            rows=tuple(_rows_from_points(noisy_points)),
            futures=(_listed_future(),),
        ),
        HarnessCase(
            name="outlier_known_svi",
            description="Known SVI with one low-weight anomalous mark.",
            points=tuple(outlier_list),
            forward_usd=FORWARD,
            time_to_expiry_years=tau,
            as_of_utc=AS_OF,
            expiry_utc=expiry_utc,
        ),
        HarnessCase(
            name="non_arb_kink",
            description="Deliberately non-arbitrage-consistent kinked IV marks.",
            points=kink_points,
            forward_usd=FORWARD,
            time_to_expiry_years=tau,
            as_of_utc=AS_OF,
            expiry_utc=expiry_utc,
            rows=tuple(_rows_from_points(kink_points)),
            futures=(_listed_future(),),
        ),
        HarnessCase(
            name="sparse_chain",
            description="Three-strike book that must fail closed.",
            points=sparse_points,
            forward_usd=FORWARD,
            time_to_expiry_years=tau,
            as_of_utc=AS_OF,
            expiry_utc=expiry_utc,
            rows=tuple(_flat_rows(strikes=[90_000.0, 100_000.0, 110_000.0])),
            futures=(_listed_future(),),
        ),
    ]


def live_cases() -> list[HarnessCase]:
    cases: list[HarnessCase] = []
    if FROZEN_AUG21.exists():
        cases.append(_case_from_snapshot(FROZEN_AUG21, "frozen_aug21_2026"))
    return cases


def run_case(case: HarnessCase) -> dict[str, Any]:
    forward = _forward(case)
    candidates = {
        "tv_pchip": TotalVariancePchipFitter(),
        "svi_raw": RawSviFitter(),
        "constrained_svi": ConstrainedSviFitter(),
    }
    rows: dict[str, Any] = {}
    for name, engine in candidates.items():
        smile, fitted = calibrate_smile(
            observed=case.points,
            synthetic=(),
            forward=forward,
            time_to_expiry_years=case.time_to_expiry_years,
            as_of_utc=case.as_of_utc,
            expiry_utc=case.expiry_utc,
            fitter=engine,
        )
        serving = evaluate_fitted_call_curve(
            fitted,
            forward_usd=case.forward_usd,
            time_to_expiry_years=case.time_to_expiry_years,
        )
        density_pack = None
        if fitted.knot_k:
            def iv_from_strike(strike: float, model=fitted) -> float | None:
                if strike <= 0:
                    return None
                iv, status = model.iv(math.log(float(strike) / case.forward_usd))
                if status.value == "extrapolated":
                    return None
                return iv

            density = extract_density(
                iv_from_strike=iv_from_strike,
                forward_usd=case.forward_usd,
                time_to_expiry_years=case.time_to_expiry_years,
                as_of_utc=case.as_of_utc,
                expiry_utc=case.expiry_utc,
                k_min=fitted.k_min,
                k_max=fitted.k_max,
            )
            density_pack = {
                "status": density.status.value,
                "mass": density.validation.mass,
                "raw_negative_mass": density.validation.raw_negative_mass,
                "cdf_monotone": density.validation.cdf_monotone,
                "forward_moment_error": density.validation.forward_moment_error,
                "digital_atm_error": density.validation.digital_atm_error,
                "grid_converged": density.validation.grid_converged,
                "failed_gates": [to_public_dict(gate) for gate in density.validation.failed_gates],
            }
        comparison = compare_fitted(
            fitted,
            points=case.points,
            time_to_expiry_years=case.time_to_expiry_years,
            forward_usd=case.forward_usd,
            selected=name == "constrained_svi",
        )
        point_residuals = []
        if name == "constrained_svi":
            detailed = ConstrainedSviFitter().fit_result(
                case.points,
                time_to_expiry_years=case.time_to_expiry_years,
                forward_usd=case.forward_usd,
            )
            point_residuals = [to_public_dict(item) for item in detailed.point_residuals]
            optimizer = to_public_dict(detailed.optimizer)
            residual = to_public_dict(detailed.residual)
            reasons = list(detailed.failure_reasons)
        else:
            optimizer = {"status": fitted.diagnostics.optimizer_status, "converged": fitted.diagnostics.status is not ModelStatus.REJECTED}
            residual = {
                "rms": fitted.diagnostics.residual_rms,
                "weighted_rms": fitted.diagnostics.weighted_residual_rms,
                "max_abs": comparison.max_abs_residual,
            }
            reasons = list(comparison.reason_codes)
        accepted = bool(
            density_pack
            and density_pack["status"] in {"accepted", "degraded"}
            and serving["call_monotone"]
            and serving["call_convex"]
        )
        rows[name] = {
            "parameters": dict(fitted.parameters),
            "optimizer": optimizer,
            "fit_residuals_by_point": point_residuals,
            "weighted_rms_residual": fitted.diagnostics.weighted_residual_rms,
            "residual": residual,
            "max_abs_residual": comparison.max_abs_residual,
            "observed_coverage": [fitted.diagnostics.k_min, fitted.diagnostics.k_max],
            "call_monotone": serving["call_monotone"],
            "call_convex": serving["call_convex"],
            "min_butterfly": serving["min_butterfly"],
            "worst_convexity_strike": serving["worst_convexity_strike"],
            "density": density_pack,
            "digital": None if density_pack is None else {"atm_error": density_pack["digital_atm_error"]},
            "acceptance": "accepted" if accepted else "rejected",
            "reason_codes": reasons,
            "smile_status": smile.diagnostics.status.value,
        }
    service_pack = None
    if case.rows is not None:
        result = build_options_surface(
            list(case.rows),
            expiry=case.expiry,
            as_of_utc=case.as_of_utc,
            index_usd=case.index_usd,
            futures=case.futures,
        )
        service_pack = {
            "fitter_name": result.fitter_name,
            "fitter_grade": result.fitter_grade.value,
            "selection_reason": result.selection_reason,
            "selected_model_status": result.selected_model_status,
            "density_status": None if result.density is None else result.density.status.value,
            "surface_display_status": result.display.surface_display_status.value,
            "served_call_monotone": result.served_call_monotone,
            "served_call_convex": result.served_call_convex,
        }
    return {
        "name": case.name,
        "description": case.description,
        "forward_usd": case.forward_usd,
        "time_to_expiry_years": case.time_to_expiry_years,
        "observation_count": len(case.points),
        "candidates": rows,
        "service": service_pack,
    }


def _case_from_snapshot(path: Path, name: str) -> HarnessCase:
    from project.options_surface.diagnostics import rebuild_from_snapshot

    snapshot = json.loads(path.read_text(encoding="utf-8"))
    rebuilt = rebuild_from_snapshot(snapshot)
    return HarnessCase(
        name=name,
        description=f"Frozen live snapshot {path.as_posix()}",
        points=tuple(rebuilt.smile.observed) + tuple(rebuilt.smile.synthetic),
        forward_usd=float(rebuilt.forward.forward_usd or 0.0),
        time_to_expiry_years=rebuilt.time_to_expiry_years,
        as_of_utc=rebuilt.as_of_utc,
        expiry_utc=rebuilt.expiry_utc,
        index_usd=rebuilt.index_usd,
        expiry=str(snapshot.get("expiry") or rebuilt.expiry_utc.date().isoformat()),
    )


def _points_from_iv(
    strikes: Sequence[float],
    *,
    ivs: Sequence[float],
    tau: float,
    forward: float,
    weights: Sequence[float] | None = None,
) -> tuple[SmilePoint, ...]:
    ks = [math.log(float(strike) / float(forward)) for strike in strikes]
    return _points_from_k(ks, ivs, tau, forward, weights=weights, strikes=strikes)


def _points_from_k(
    ks: Sequence[float],
    ivs: Sequence[float],
    tau: float,
    forward: float,
    weights: Sequence[float] | None = None,
    strikes: Sequence[float] | None = None,
) -> tuple[SmilePoint, ...]:
    points: list[SmilePoint] = []
    for i, (k, iv) in enumerate(zip(ks, ivs, strict=True)):
        strike = float(strikes[i]) if strikes is not None else float(forward) * math.exp(float(k))
        weight = 1.0 if weights is None else float(weights[i])
        points.append(
            SmilePoint(
                strike_usd=strike,
                log_moneyness=float(k),
                iv=float(iv),
                total_variance=float(iv) * float(iv) * float(tau),
                origin=PointOrigin.RAW_OBSERVED,
                option_side="put" if k < 0 else "call",
                classification="preferred",
                bid_iv=max(float(iv) - 0.01, 0.01),
                ask_iv=float(iv) + 0.01,
                mark_iv=float(iv),
                quote_age_seconds=0.0,
                fit_weight=weight,
                source="harness",
            )
        )
    return tuple(points)


def _rows_from_points(points: Sequence[SmilePoint]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for point in points:
        iv_pct = float(point.iv) * 100.0
        for side in ("call", "put"):
            rows.append(_option_row(point.strike_usd, side, iv_pct))
    return rows


def _flat_rows(strikes: Sequence[float] | None = None) -> list[dict[str, Any]]:
    grid = list(strikes) if strikes is not None else [
        FORWARD * ratio for ratio in (0.70, 0.80, 0.90, 0.95, 1.00, 1.05, 1.10, 1.20, 1.30, 1.40)
    ]
    rows: list[dict[str, Any]] = []
    for strike in grid:
        call_mid = 0.05
        put_mid = call_mid - (1.0 - strike / FORWARD)
        for side, mid in (("call", call_mid), ("put", put_mid if put_mid > 0 else 0.01)):
            rows.append(
                _option_row(
                    strike,
                    side,
                    SIGMA * 100.0,
                    bid=max(mid - 0.002, 0.001),
                    ask=mid + 0.002,
                )
            )
    return rows


def _option_row(
    strike: float,
    side: str,
    mark_iv_pct: float,
    *,
    bid: float = 0.048,
    ask: float = 0.052,
) -> dict[str, Any]:
    side_code = "C" if side == "call" else "P"
    return {
        "expiry": EXPIRY,
        "strike": strike,
        "option_type": side,
        "instrument_name": f"BTC-16AUG30-{int(strike)}-{side_code}",
        "mark_iv": mark_iv_pct,
        "bid_iv": mark_iv_pct - 1.0,
        "ask_iv": mark_iv_pct + 1.0,
        "bid_price": bid,
        "ask_price": ask,
        "bid_size": 1.0,
        "ask_size": 1.0,
        "quote_as_of": AS_OF,
        "state": "open",
        "open_interest": 20.0,
        "underlying_price": FORWARD,
        "index_price": INDEX,
    }


def _listed_future() -> NativeFutureQuote:
    return NativeFutureQuote(
        instrument_name="BTC-16AUG30",
        underlying="BTC",
        expiry_date=EXPIRY,
        expiry_utc=None,
        as_of_utc=AS_OF,
        quote_as_of_utc=AS_OF,
        is_perpetual=False,
        bid_usd=FORWARD - 5.0,
        ask_usd=FORWARD + 5.0,
        mark_usd=FORWARD,
        mid_usd=FORWARD,
        index_usd=INDEX,
        open_interest=1000.0,
    )


def _forward(case: HarnessCase) -> ForwardEstimate:
    return ForwardEstimate(
        as_of_utc=case.as_of_utc,
        expiry_utc=case.expiry_utc,
        underlying="BTC",
        forward_usd=case.forward_usd,
        source=ForwardSource.MATCHING_FUTURE,
        source_quality=SourceQuality.HIGH,
        supporting_instruments=("BTC-HARNESS",),
        parity_pair_count=0,
        parity_dispersion=None,
        futures_option_difference=None,
        fallback_reason=None,
        validation_flags=(),
    )


def _render_markdown(report: Mapping[str, Any]) -> str:
    lines = [
        "# Constrained smile calibration harness",
        "",
        f"Generated at `{report['generated_at']}`.",
        "",
    ]
    for case in report["cases"]:
        lines.append(f"## {case['name']}")
        lines.append("")
        lines.append(case["description"])
        lines.append("")
        lines.append("| Candidate | RMS | max | monotone | convex | density | accept |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- |")
        for name, row in case["candidates"].items():
            dens = (row.get("density") or {}).get("status") or "n/a"
            lines.append(
                f"| `{name}` | {row.get('weighted_rms_residual')} | {row.get('max_abs_residual')} | "
                f"{row.get('call_monotone')} | {row.get('call_convex')} | {dens} | {row.get('acceptance')} |"
            )
        lines.append("")
    return "\n".join(lines) + "\n"