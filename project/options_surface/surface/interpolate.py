"""Cross-expiry total-variance interpolation at fixed k."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from project.options_surface.surface.arbitrage import calendar_violations
from project.options_surface.surface.fitters import FittedSmile
from project.options_surface.types import QueryStatus

STANDARD_K_GRID = tuple(round(-0.40 + 0.05 * i, 4) for i in range(17))


@dataclass(frozen=True, slots=True)
class VarianceInterpolation:
    total_variance: float | None
    status: QueryStatus
    t1: float | None
    t2: float | None
    calendar_ok: bool | None
    note: str | None


def interpolate_total_variance(
    slices: Sequence[FittedSmile],
    *,
    k: float,
    time_to_expiry_years: float,
) -> VarianceInterpolation:
    """w(k,T) = w(k,T1) + ((T-T1)/(T2-T1)) * (w(k,T2)-w(k,T1)). No extrapolation."""
    dated = sorted(
        (slice_ for slice_ in slices if slice_.diagnostics.status is not None),
        key=lambda item: item.time_to_expiry_years,
    )
    dated = [item for item in dated if item.knot_k]
    if not dated:
        return VarianceInterpolation(None, QueryStatus.UNAVAILABLE, None, None, None, "no_slices")
    t_min = dated[0].time_to_expiry_years
    t_max = dated[-1].time_to_expiry_years
    if time_to_expiry_years < t_min - 1e-15 or time_to_expiry_years > t_max + 1e-15:
        return VarianceInterpolation(
            None,
            QueryStatus.EXTRAPOLATED,
            t_min,
            t_max,
            None,
            "maturity_outside_observed_range",
        )
    for left, right in zip(dated, dated[1:]):
        if left.time_to_expiry_years <= time_to_expiry_years <= right.time_to_expiry_years:
            w1, s1 = left.total_variance(k)
            w2, s2 = right.total_variance(k)
            if w1 is None or w2 is None:
                return VarianceInterpolation(
                    None,
                    QueryStatus.UNAVAILABLE,
                    left.time_to_expiry_years,
                    right.time_to_expiry_years,
                    None,
                    "k_outside_one_or_both_slices",
                )
            span = right.time_to_expiry_years - left.time_to_expiry_years
            if span <= 0:
                status = s1 if s1 is not QueryStatus.UNAVAILABLE else QueryStatus.AVAILABLE
                return VarianceInterpolation(w1, status, left.time_to_expiry_years, right.time_to_expiry_years, True, None)
            weight = (time_to_expiry_years - left.time_to_expiry_years) / span
            value = w1 + weight * (w2 - w1)
            ok, _, _ = calendar_violations([w1], [w2], k_grid=[k])
            status = (
                QueryStatus.AVAILABLE
                if abs(weight) < 1e-15 or abs(weight - 1.0) < 1e-15
                else QueryStatus.INTERPOLATED
            )
            return VarianceInterpolation(
                float(value),
                status,
                left.time_to_expiry_years,
                right.time_to_expiry_years,
                ok,
                None if ok else "calendar_violation_at_k",
            )
    w0, status = dated[0].total_variance(k)
    return VarianceInterpolation(w0, status, t_min, t_min, True, None)


def calendar_report(
    slices: Sequence[FittedSmile],
    *,
    k_grid: Sequence[float] = STANDARD_K_GRID,
) -> dict[str, object]:
    dated = sorted((item for item in slices if item.knot_k), key=lambda item: item.time_to_expiry_years)
    pairs: list[dict[str, object]] = []
    all_ok = True
    for left, right in zip(dated, dated[1:]):
        w1: list[float] = []
        w2: list[float] = []
        ks: list[float] = []
        for k in k_grid:
            a, sa = left.total_variance(float(k))
            b, sb = right.total_variance(float(k))
            if a is None or b is None:
                continue
            w1.append(a)
            w2.append(b)
            ks.append(float(k))
        if not ks:
            pairs.append(
                {
                    "t1": left.time_to_expiry_years,
                    "t2": right.time_to_expiry_years,
                    "ok": False,
                    "min_dw": None,
                    "violations": ("no_overlapping_k",),
                }
            )
            all_ok = False
            continue
        ok, min_dw, violations = calendar_violations(w1, w2, k_grid=ks)
        all_ok = all_ok and ok
        pairs.append(
            {
                "t1": left.time_to_expiry_years,
                "t2": right.time_to_expiry_years,
                "ok": ok,
                "min_dw": min_dw,
                "violations": violations,
            }
        )
    return {"ok": all_ok, "pairs": tuple(pairs)}
