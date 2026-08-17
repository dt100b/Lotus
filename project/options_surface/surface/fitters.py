"""Candidate smile fitters in (k, total variance)."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Protocol, Sequence

import numpy as np
from scipy.interpolate import PchipInterpolator
from scipy.optimize import least_squares

from project.options_surface.distribution.black76 import black76_call, black76_forward_delta
from project.options_surface.types import (
    FitterGrade,
    ModelStatus,
    PointOrigin,
    QueryStatus,
    SmileFitDiagnostics,
    SmilePoint,
)

MIN_FIT_POINTS = 4


class SmileFitter(Protocol):
    name: str
    grade: FitterGrade

    def fit(
        self,
        points: Sequence[SmilePoint],
        *,
        time_to_expiry_years: float,
        forward_usd: float,
    ) -> "FittedSmile": ...


@dataclass(frozen=True, slots=True)
class FittedSmile:
    fitter_name: str
    fitter_grade: FitterGrade
    diagnostics: SmileFitDiagnostics
    k_min: float
    k_max: float
    time_to_expiry_years: float
    forward_usd: float
    knot_k: tuple[float, ...]
    knot_w: tuple[float, ...]
    parameters: dict[str, float]
    _evaluate_w: object

    def total_variance(self, k: float) -> tuple[float | None, QueryStatus]:
        if k < self.k_min - 1e-12 or k > self.k_max + 1e-12:
            return None, QueryStatus.EXTRAPOLATED
        value = float(self._evaluate_w(float(k)))  # type: ignore[operator]
        if not math.isfinite(value):
            return None, QueryStatus.UNAVAILABLE
        if abs(k - self.k_min) <= 1e-12 or abs(k - self.k_max) <= 1e-12:
            return value, QueryStatus.AVAILABLE
        if any(abs(k - knot) <= 1e-12 for knot in self.knot_k):
            return value, QueryStatus.AVAILABLE
        return value, QueryStatus.INTERPOLATED

    def iv(self, k: float) -> tuple[float | None, QueryStatus]:
        total_var, status = self.total_variance(k)
        if total_var is None or self.time_to_expiry_years <= 0:
            return None, status
        if total_var < 0:
            return None, QueryStatus.UNAVAILABLE
        return math.sqrt(total_var / self.time_to_expiry_years), status

    def call_price(self, strike_usd: float, *, rate: float = 0.0) -> float | None:
        if strike_usd <= 0 or self.forward_usd <= 0:
            return None
        iv, _status = self.iv(math.log(float(strike_usd) / self.forward_usd))
        if iv is None:
            return None
        return black76_call(
            forward_usd=self.forward_usd,
            strike_usd=float(strike_usd),
            time_to_expiry_years=self.time_to_expiry_years,
            rate=rate,
            sigma=iv,
        )

    def delta(self, strike_usd: float, option_type: str, *, rate: float = 0.0) -> float | None:
        if strike_usd <= 0 or self.forward_usd <= 0:
            return None
        iv, _status = self.iv(math.log(float(strike_usd) / self.forward_usd))
        if iv is None:
            return None
        return black76_forward_delta(
            forward_usd=self.forward_usd,
            strike_usd=float(strike_usd),
            time_to_expiry_years=self.time_to_expiry_years,
            rate=rate,
            sigma=iv,
            side=option_type,
        )


class TotalVariancePchipFitter:
    """Shape-preserving interpolant in (k, w). Grade: diagnostic.

    Suitable for sparse noisy crypto smiles because it is exact at accepted
    knots and does not invent wing values. It is not an arbitrage-free
    parametric model and is not labeled production-ready.
    """

    name = "tv_pchip"
    grade = FitterGrade.DIAGNOSTIC

    def fit(
        self,
        points: Sequence[SmilePoint],
        *,
        time_to_expiry_years: float,
        forward_usd: float,
    ) -> FittedSmile:
        usable = _usable_points(points)
        if len(usable) < MIN_FIT_POINTS:
            return _failed_fit(
                self,
                points=usable,
                time_to_expiry_years=time_to_expiry_years,
                forward_usd=forward_usd,
                note="insufficient_observations",
            )
        order = np.argsort([point.log_moneyness for point in usable])
        k = np.asarray([usable[i].log_moneyness for i in order], dtype=float)
        w = np.asarray([usable[i].total_variance for i in order], dtype=float)
        weights = np.asarray([max(usable[i].fit_weight, 1e-6) for i in order], dtype=float)
        unique_k, unique_idx = np.unique(k, return_index=True)
        unique_w = w[unique_idx]
        unique_weights = weights[unique_idx]
        if len(unique_k) < MIN_FIT_POINTS:
            return _failed_fit(
                self,
                points=usable,
                time_to_expiry_years=time_to_expiry_years,
                forward_usd=forward_usd,
                note="duplicate_log_moneyness",
            )
        interpolant = PchipInterpolator(unique_k, unique_w, extrapolate=False)

        def evaluate(k_query: float) -> float:
            return float(interpolant(k_query))

        fitted = interpolant(unique_k)
        residual = unique_w - fitted
        rms = float(np.sqrt(np.mean(residual**2)))
        wrms = float(np.sqrt(np.average(residual**2, weights=unique_weights)))
        diagnostics = SmileFitDiagnostics(
            fitter_name=self.name,
            fitter_grade=self.grade,
            status=ModelStatus.DEGRADED,
            residual_rms=rms,
            weighted_residual_rms=wrms,
            optimizer_status="interpolating_pchip",
            parameter_count=len(unique_k),
            parameters={"knot_count": float(len(unique_k))},
            observation_count=len(unique_k),
            k_min=float(unique_k[0]),
            k_max=float(unique_k[-1]),
            extrapolated=False,
            notes=(
                "Baseline interpolant in total variance. Diagnostic grade: not "
                "an arbitrage-free parametric smile.",
            ),
        )
        return FittedSmile(
            fitter_name=self.name,
            fitter_grade=self.grade,
            diagnostics=diagnostics,
            k_min=float(unique_k[0]),
            k_max=float(unique_k[-1]),
            time_to_expiry_years=float(time_to_expiry_years),
            forward_usd=float(forward_usd),
            knot_k=tuple(float(value) for value in unique_k),
            knot_w=tuple(float(value) for value in unique_w),
            parameters={"knot_count": float(len(unique_k))},
            _evaluate_w=evaluate,
        )


class RawSviFitter:
    """Raw Gatheral SVI in total variance. Grade: research.

    Convergence of the optimizer is not proof of no-arbitrage. Calendar and
    butterfly diagnostics must pass before this fitter can be promoted.
    """

    name = "svi_raw"
    grade = FitterGrade.RESEARCH

    def fit(
        self,
        points: Sequence[SmilePoint],
        *,
        time_to_expiry_years: float,
        forward_usd: float,
    ) -> FittedSmile:
        usable = _usable_points(points)
        if len(usable) < MIN_FIT_POINTS:
            return _failed_fit(
                self,
                points=usable,
                time_to_expiry_years=time_to_expiry_years,
                forward_usd=forward_usd,
                note="insufficient_observations",
            )
        k = np.asarray([point.log_moneyness for point in usable], dtype=float)
        w = np.asarray([point.total_variance for point in usable], dtype=float)
        weights = np.asarray([max(point.fit_weight, 1e-6) for point in usable], dtype=float)
        atm = float(np.average(w, weights=weights))
        x0 = np.asarray([max(atm * 0.5, 1e-6), 0.1, 0.0, 0.0, 0.1], dtype=float)

        def residual(theta: np.ndarray) -> np.ndarray:
            pred = _svi_w(k, theta)
            return np.sqrt(weights) * (pred - w)

        result = least_squares(
            residual,
            x0,
            bounds=(
                np.asarray([0.0, 0.0, -0.999, -2.0, 1e-4], dtype=float),
                np.asarray([2.0, 5.0, 0.999, 2.0, 2.0], dtype=float),
            ),
            max_nfev=200,
        )
        theta = result.x
        pred = _svi_w(k, theta)
        resid = w - pred
        rms = float(np.sqrt(np.mean(resid**2)))
        wrms = float(np.sqrt(np.average(resid**2, weights=weights)))
        min_w = float(np.min(_svi_w(np.linspace(float(k.min()), float(k.max()), 81), theta)))
        notes = [
            "Research-grade raw SVI. Not production-ready.",
            f"optimizer_success={bool(result.success)}",
            f"cost={float(result.cost):.6g}",
        ]
        if min_w < 0:
            notes.append("svi_min_total_variance_negative")
        params = {
            "a": float(theta[0]),
            "b": float(theta[1]),
            "rho": float(theta[2]),
            "m": float(theta[3]),
            "sigma": float(theta[4]),
        }

        def evaluate(k_query: float) -> float:
            return float(_svi_w(np.asarray([k_query], dtype=float), theta)[0])

        diagnostics = SmileFitDiagnostics(
            fitter_name=self.name,
            fitter_grade=self.grade,
            status=ModelStatus.RESEARCH,
            residual_rms=rms,
            weighted_residual_rms=wrms,
            optimizer_status=str(result.message),
            parameter_count=5,
            parameters=params,
            observation_count=len(usable),
            k_min=float(k.min()),
            k_max=float(k.max()),
            extrapolated=False,
            notes=tuple(notes),
        )
        return FittedSmile(
            fitter_name=self.name,
            fitter_grade=self.grade,
            diagnostics=diagnostics,
            k_min=float(k.min()),
            k_max=float(k.max()),
            time_to_expiry_years=float(time_to_expiry_years),
            forward_usd=float(forward_usd),
            knot_k=tuple(float(value) for value in k),
            knot_w=tuple(float(value) for value in w),
            parameters=params,
            _evaluate_w=evaluate,
        )


def _svi_w(k: np.ndarray, theta: np.ndarray) -> np.ndarray:
    a, b, rho, m, sigma = theta
    x = k - m
    return a + b * (rho * x + np.sqrt(x * x + sigma * sigma))


def _usable_points(points: Sequence[SmilePoint]) -> list[SmilePoint]:
    return [
        point
        for point in points
        if point.origin in {PointOrigin.RAW_OBSERVED, PointOrigin.SYNTHETIC_ATM}
        and point.iv > 0
        and math.isfinite(point.total_variance)
    ]


def _failed_fit(
    fitter: TotalVariancePchipFitter | RawSviFitter,
    *,
    points: Sequence[SmilePoint],
    time_to_expiry_years: float,
    forward_usd: float,
    note: str,
) -> FittedSmile:
    diagnostics = SmileFitDiagnostics(
        fitter_name=fitter.name,
        fitter_grade=fitter.grade,
        status=ModelStatus.REJECTED,
        residual_rms=None,
        weighted_residual_rms=None,
        optimizer_status="rejected",
        parameter_count=0,
        parameters={},
        observation_count=len(points),
        k_min=None,
        k_max=None,
        extrapolated=False,
        notes=(note,),
    )

    def evaluate(_k: float) -> float:
        return float("nan")

    return FittedSmile(
        fitter_name=fitter.name,
        fitter_grade=fitter.grade,
        diagnostics=diagnostics,
        k_min=0.0,
        k_max=0.0,
        time_to_expiry_years=float(time_to_expiry_years),
        forward_usd=float(forward_usd),
        knot_k=(),
        knot_w=(),
        parameters={},
        _evaluate_w=evaluate,
    )
