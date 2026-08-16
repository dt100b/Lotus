"""Forward curve container. Interpolation is separate from variance interpolation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Sequence

from project.options_surface.types import (
    ForwardEstimate,
    QueryStatus,
    SourceQuality,
    worse_quality,
)


@dataclass(frozen=True, slots=True)
class ForwardCurve:
    as_of_utc: datetime
    underlying: str
    slices: tuple[ForwardEstimate, ...]

    def at_expiry(self, expiry_utc: datetime) -> ForwardEstimate | None:
        for slice_ in self.slices:
            if slice_.expiry_utc == expiry_utc:
                return slice_
        return None

    def interpolate(self, expiry_utc: datetime) -> tuple[float | None, QueryStatus, SourceQuality]:
        """Linear in calendar time between adjacent accepted forwards. No extrapolation."""
        dated = sorted(
            (slice_ for slice_ in self.slices if slice_.forward_usd),
            key=lambda item: item.expiry_utc,
        )
        if not dated:
            return None, QueryStatus.UNAVAILABLE, SourceQuality.UNAVAILABLE
        if expiry_utc < dated[0].expiry_utc or expiry_utc > dated[-1].expiry_utc:
            return None, QueryStatus.EXTRAPOLATED, SourceQuality.UNAVAILABLE
        for left, right in zip(dated, dated[1:]):
            if left.expiry_utc <= expiry_utc <= right.expiry_utc:
                span = (right.expiry_utc - left.expiry_utc).total_seconds()
                if span <= 0:
                    return left.forward_usd, QueryStatus.AVAILABLE, left.source_quality
                weight = (expiry_utc - left.expiry_utc).total_seconds() / span
                forward = (1.0 - weight) * float(left.forward_usd) + weight * float(right.forward_usd)
                quality = worse_quality(left.source_quality, right.source_quality)
                status = (
                    QueryStatus.AVAILABLE
                    if expiry_utc in {left.expiry_utc, right.expiry_utc}
                    else QueryStatus.INTERPOLATED
                )
                return float(forward), status, quality
        return dated[0].forward_usd, QueryStatus.AVAILABLE, dated[0].source_quality


def curve_from_estimates(estimates: Sequence[ForwardEstimate]) -> ForwardCurve:
    if not estimates:
        raise ValueError("Forward curve requires at least one estimate.")
    first = estimates[0]
    return ForwardCurve(
        as_of_utc=first.as_of_utc,
        underlying=first.underlying,
        slices=tuple(estimates),
    )
