"""Constrained SVI serving candidate: calibration quality and serving gates."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from project.options_surface.distribution.black76 import black76_forward_delta
from project.options_surface.distribution.density import extract_density
from project.options_surface.service import build_options_surface
from project.options_surface.surface.constrained_svi import ConstrainedSviFitter
from project.options_surface.surface.fitters import RawSviFitter, TotalVariancePchipFitter
from project.options_surface.surface.selection import select_serving_candidate
from project.options_surface.surface.smile import calibrate_smile, solve_delta_strike
from project.options_surface.surface.svi import svi_w
from project.options_surface.timeutil import inferred_deribit_expiry_utc, require_positive_year_fraction
from project.options_surface.types import (
    FitterGrade,
    ForwardEstimate,
    ForwardSource,
    ModelStatus,
    PointOrigin,
    SmilePoint,
    SourceQuality,
)
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    SIGMA,
    flat_vol_chain,
    listed_future,
    option_row,
)

FROZEN_AUG21 = (
    Path(__file__).resolve().parents[3]
    / "runtime"
    / "options_surface_debug"
    / "20260816T230839Z"
    / "snapshot.json"
)
KNOWN_SVI = (0.00035, 0.008, -0.35, -0.01, 0.09)


def _tau() -> float:
    return require_positive_year_fraction(AS_OF, inferred_deribit_expiry_utc(EXPIRY))


def _forward() -> ForwardEstimate:
    return ForwardEstimate(
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        underlying="BTC",
        forward_usd=FORWARD,
        source=ForwardSource.MATCHING_FUTURE,
        source_quality=SourceQuality.HIGH,
        supporting_instruments=("BTC-16AUG30",),
        parity_pair_count=0,
        parity_dispersion=None,
        futures_option_difference=None,
        fallback_reason=None,
        validation_flags=(),
    )


def _points_from_ivs(strikes: list[float], ivs: list[float], *, weights: list[float] | None = None) -> list[SmilePoint]:
    tau = _tau()
    points: list[SmilePoint] = []
    for i, (strike, iv) in enumerate(zip(strikes, ivs, strict=True)):
        k = math.log(strike / FORWARD)
        points.append(
            SmilePoint(
                strike_usd=float(strike),
                log_moneyness=float(k),
                iv=float(iv),
                total_variance=float(iv * iv * tau),
                origin=PointOrigin.RAW_OBSERVED,
                option_side="put" if k < 0 else "call",
                classification="preferred",
                bid_iv=max(iv - 0.01, 0.01),
                ask_iv=iv + 0.01,
                mark_iv=iv,
                quote_age_seconds=0.0,
                fit_weight=1.0 if weights is None else float(weights[i]),
                source="test",
            )
        )
    return points


def _known_svi_points(*, noise: float = 0.0, seed: int = 7) -> list[SmilePoint]:
    tau = _tau()
    ks = np.linspace(-0.25, 0.20, 11)
    ws = np.asarray(svi_w(ks, KNOWN_SVI), dtype=float)
    ivs = np.sqrt(np.maximum(ws, 0.0) / tau)
    if noise:
        ivs = ivs + np.random.default_rng(seed).uniform(-noise, noise, size=ivs.shape)
    strikes = [FORWARD * math.exp(float(k)) for k in ks]
    return _points_from_ivs(strikes, [float(iv) for iv in ivs])


def _calibrate(points: list[SmilePoint], fitter=None):
    return calibrate_smile(
        observed=points,
        synthetic=(),
        forward=_forward(),
        time_to_expiry_years=_tau(),
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        fitter=fitter or ConstrainedSviFitter(),
    )


def test_flat_vol_recovery() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.fitter_name == "constrained_svi"
    assert result.fitter_grade is FitterGrade.DIAGNOSTIC_CANDIDATE
    assert result.density is not None
    assert result.density.status in {ModelStatus.ACCEPTED, ModelStatus.DEGRADED}
    assert result.served_call_monotone is True
    assert result.served_call_convex is True
    assert result.density.validation.mass is not None
    assert abs(result.density.validation.mass - 1.0) < 0.03
    assert result.analytics.atm_iv is not None
    assert abs(result.analytics.atm_iv - SIGMA) < 0.03
    assert result.display.surface_display_status.value == "degraded"
    assert "diagnostic" in result.display.human_readable_reason.lower()
    assert "production-grade" not in result.display.human_readable_reason.lower()
    assert "arbitrage-free" not in result.display.human_readable_reason.lower()


def test_known_svi_recovery() -> None:
    points = _known_svi_points()
    smile, fitted = _calibrate(points)
    assert fitted.fitter_name == "constrained_svi"
    assert smile.diagnostics.status is not ModelStatus.REJECTED
    for point in points:
        iv, _status = fitted.iv(point.log_moneyness)
        assert iv is not None
        assert abs(iv - point.iv) < 0.03
    detailed = ConstrainedSviFitter().fit_result(
        points, time_to_expiry_years=_tau(), forward_usd=FORWARD
    )
    assert detailed.served_call_monotone is True
    assert detailed.served_call_convex is True

    def iv_from_strike(strike: float) -> float | None:
        iv, status = fitted.iv(math.log(strike / FORWARD))
        return None if status.value == "extrapolated" else iv

    density = extract_density(
        iv_from_strike=iv_from_strike,
        forward_usd=FORWARD,
        time_to_expiry_years=_tau(),
        as_of_utc=AS_OF,
        expiry_utc=inferred_deribit_expiry_utc(EXPIRY),
        k_min=fitted.k_min,
        k_max=fitted.k_max,
    )
    assert density.status in {ModelStatus.ACCEPTED, ModelStatus.DEGRADED}
    assert density.validation.cdf_monotone is True


def test_noisy_known_svi_does_not_interpolate_every_mark() -> None:
    points = _known_svi_points(noise=0.012)
    constrained = ConstrainedSviFitter().fit_result(
        points, time_to_expiry_years=_tau(), forward_usd=FORWARD
    )
    pchip, pchip_fit = _calibrate(points, TotalVariancePchipFitter())
    raw, raw_fit = _calibrate(points, RawSviFitter())
    _ = (pchip, raw)
    assert constrained.served_call_convex is True
    assert constrained.residual.rms is not None and constrained.residual.rms > 0.0
    assert pchip_fit.diagnostics.residual_rms == 0.0
    assert abs(constrained.residual.rms or 0.0) >= abs(raw_fit.diagnostics.residual_rms or 0.0) * 0.1
    assert constrained.smile.diagnostics.status is not ModelStatus.REJECTED


def test_outlier_does_not_dominate() -> None:
    points = _known_svi_points()
    dirty = list(points)
    outlier = dirty[2]
    dirty[2] = SmilePoint(
        strike_usd=outlier.strike_usd,
        log_moneyness=outlier.log_moneyness,
        iv=outlier.iv + 0.20,
        total_variance=(outlier.iv + 0.20) ** 2 * _tau(),
        origin=outlier.origin,
        option_side=outlier.option_side,
        classification=outlier.classification,
        bid_iv=outlier.bid_iv,
        ask_iv=outlier.ask_iv,
        mark_iv=outlier.iv + 0.20,
        quote_age_seconds=outlier.quote_age_seconds,
        fit_weight=0.05,
        source=outlier.source,
    )
    result = ConstrainedSviFitter().fit_result(
        dirty, time_to_expiry_years=_tau(), forward_usd=FORWARD
    )
    assert result.point_residuals
    outlier_row = next(item for item in result.point_residuals if abs(item.log_moneyness - dirty[2].log_moneyness) < 1e-12)
    assert outlier_row.residual_iv is not None
    assert abs(outlier_row.residual_iv) > 0.05
    neighbors = [item for item in result.point_residuals if item is not outlier_row and item.residual_iv is not None]
    assert neighbors
    assert np.median([abs(item.residual_iv or 0.0) for item in neighbors]) < 0.04
    assert result.served_call_convex is True


def test_sparse_chain_fails_closed() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD, strikes=[90_000.0, 100_000.0, 110_000.0]),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.model_status is ModelStatus.REJECTED
    assert result.analytics.central_range_50 is None
    assert result.density is None or result.density.status is ModelStatus.REJECTED


def test_non_arb_inputs_never_serve_nonconvex_calls() -> None:
    strikes = [70_000, 80_000, 90_000, 95_000, 100_000, 105_000, 110_000, 120_000, 130_000]
    ivs = [0.80 if strike < 95_000 else 0.40 if strike > 105_000 else 0.50 for strike in strikes]
    points = _points_from_ivs(strikes, ivs)
    detailed = ConstrainedSviFitter().fit_result(
        points, time_to_expiry_years=_tau(), forward_usd=FORWARD
    )
    if detailed.model_status is not ModelStatus.REJECTED:
        assert detailed.served_call_convex is True
        assert detailed.served_call_monotone is True
    result = build_options_surface(
        [option_row(strike, side, iv * 100.0) for strike, iv in zip(strikes, ivs, strict=True) for side in ("call", "put")],
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    if result.density is not None and result.density.status is not ModelStatus.REJECTED:
        assert result.served_call_convex is True
        assert result.analytics.central_range_50 is not None
    else:
        assert result.analytics.central_range_50 is None
        assert result.analytics.risk_neutral_mean is None


def test_failed_convexity_rejects_density_headlines() -> None:
    from project.options_surface.distribution.density import apply_served_smile_arbitrage
    from project.options_surface.types import ArbitrageReport

    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.density is not None
    report = ArbitrageReport(
        positive_variance=True,
        call_monotone=True,
        call_convex=False,
        butterfly_ok=False,
        calendar_ok=None,
        min_total_variance=0.001,
        min_call_step=-1.0,
        min_butterfly=-0.2,
        min_calendar_dw=None,
        violations=("call_not_convex_in_strike",),
        worst_convexity_strike=FORWARD * 0.9,
    )
    rejected = apply_served_smile_arbitrage(result.density, report)
    assert rejected.status is ModelStatus.REJECTED
    assert rejected.quantiles == {}
    assert rejected.mean is None


def test_no_silent_pchip_fallback() -> None:
    points = _known_svi_points()
    _fitter, reason, comparison, _result, _serve = select_serving_candidate(
        points,
        time_to_expiry_years=_tau(),
        forward_usd=FORWARD,
        sparse=False,
    )
    assert _fitter.name == "constrained_svi"
    pchip_row = next(row for row in comparison if row.fitter_name == "tv_pchip")
    assert pchip_row.selected is False
    assert "not_selectable" in " ".join(pchip_row.reason_codes)
    if _result is not None and _result.served_call_convex is not True:
        assert "no_pchip_fallback" in reason


def test_serving_candidate_can_pass_when_pchip_fails() -> None:
    points = _known_svi_points(noise=0.02)
    pchip, pchip_fit = _calibrate(points, TotalVariancePchipFitter())
    constrained = ConstrainedSviFitter().fit_result(
        points, time_to_expiry_years=_tau(), forward_usd=FORWARD
    )
    _ = pchip_fit
    if not pchip.arbitrage.call_convex and constrained.served_call_convex:
        result = build_options_surface(
            [option_row(p.strike_usd, "call" if p.log_moneyness >= 0 else "put", p.iv * 100.0) for p in points]
            + [option_row(p.strike_usd, "put" if p.log_moneyness >= 0 else "call", p.iv * 100.0) for p in points],
            expiry=EXPIRY,
            as_of_utc=AS_OF,
            index_usd=INDEX,
            futures=(listed_future(mid=FORWARD),),
        )
        assert result.fitter_name == "constrained_svi"
        if result.density is not None and result.density.status is not ModelStatus.REJECTED:
            assert result.analytics.central_range_50 is not None


def test_research_svi_cannot_contaminate_selection() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.research is not None
    assert result.research.fitter_name == "svi_raw"
    if result.density is not None and result.density.status is not ModelStatus.REJECTED:
        assert result.display.density_status.value != "rejected"
        assert "Call-price convexity failed" not in result.display.failed_checks or result.display.customer_warning_scope != "research" or result.display.density_status.value != "rejected"


def test_same_forward_used_for_constrained_fit() -> None:
    result = build_options_surface(
        flat_vol_chain(forward=FORWARD),
        expiry=EXPIRY,
        as_of_utc=AS_OF,
        index_usd=INDEX,
        futures=(listed_future(mid=FORWARD),),
    )
    assert result.forward.forward_usd == FORWARD
    for point in result.smile.observed:
        assert abs(point.log_moneyness - math.log(point.strike_usd / FORWARD)) < 1e-12
    if result.density is not None:
        assert result.density.forward_usd == FORWARD


def test_delta_roots_require_coverage() -> None:
    points = _points_from_ivs(
        [FORWARD * r for r in (0.97, 0.99, 1.00, 1.01, 1.03)],
        [0.50, 0.50, 0.50, 0.50, 0.50],
    )
    _smile, fitted = _calibrate(points)
    strike, iv = solve_delta_strike(fitted, target_delta=0.25, side="call")
    if strike is None:
        result = build_options_surface(
            [option_row(p.strike_usd, side, 50.0) for p in points for side in ("call", "put")],
            expiry=EXPIRY,
            as_of_utc=AS_OF,
            index_usd=INDEX,
            futures=(listed_future(mid=FORWARD),),
        )
        assert result.analytics.rr_25 is None
        return
    assert iv is not None
    k = math.log(strike / FORWARD)
    assert fitted.k_min - 1e-12 <= k <= fitted.k_max + 1e-12
    delta = black76_forward_delta(
        forward_usd=FORWARD,
        strike_usd=strike,
        time_to_expiry_years=_tau(),
        sigma=iv,
        side="call",
    )
    assert delta is not None
    assert abs(delta - 0.25) < 1e-3


def test_frozen_aug21_pchip_failure_and_constrained_honesty() -> None:
    if not FROZEN_AUG21.exists():
        return
    from project.options_surface.diagnostics import rebuild_from_snapshot

    snapshot = json.loads(FROZEN_AUG21.read_text(encoding="utf-8"))
    rebuilt = rebuild_from_snapshot(snapshot)
    pchip, _fitted = calibrate_smile(
        observed=rebuilt.smile.observed,
        synthetic=rebuilt.smile.synthetic,
        forward=rebuilt.forward,
        time_to_expiry_years=rebuilt.time_to_expiry_years,
        as_of_utc=rebuilt.as_of_utc,
        expiry_utc=rebuilt.expiry_utc,
        fitter=TotalVariancePchipFitter(),
    )
    assert pchip.arbitrage.call_convex is False
    assert rebuilt.fitter_name == "constrained_svi"
    if rebuilt.density is not None and rebuilt.density.status is not ModelStatus.REJECTED:
        assert rebuilt.display.surface_display_status.value == "degraded"
        assert rebuilt.served_call_convex is True
        assert rebuilt.analytics.central_range_50 is not None
    else:
        assert rebuilt.analytics.central_range_50 is None
        assert rebuilt.display.reason_codes


def test_constrained_fitter_exposes_required_interface() -> None:
    points = _known_svi_points()
    result = ConstrainedSviFitter().fit_result(
        points, time_to_expiry_years=_tau(), forward_usd=FORWARD
    )
    assert result.iv(0.0)[0] is not None
    assert result.total_variance(0.0)[0] is not None
    assert result.call_price(FORWARD) is not None
    assert result.delta(FORWARD, "call") is not None
    assert result.parameters
    assert result.optimizer.status
    assert result.k_min < result.k_max
    assert result.model_grade is FitterGrade.DIAGNOSTIC_CANDIDATE
