"""Market-implied Deribit options surface engine.

This package prices how the listed options market implies a forward, a
volatility smile, a term structure, and a risk-neutral terminal-price
distribution. It is not a directional forecast system.
"""

from .service import build_options_surface
from .types import (
    FitterGrade,
    ForwardSource,
    ModelStatus,
    QueryStatus,
    RejectionReason,
    SourceQuality,
)

__all__ = [
    "FitterGrade",
    "ForwardSource",
    "ModelStatus",
    "QueryStatus",
    "RejectionReason",
    "SourceQuality",
    "build_options_surface",
]
