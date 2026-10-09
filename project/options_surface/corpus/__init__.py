"""Immutable Options Surface validation corpus.

Capture, replay, collect, and analyze market-implied calibration
snapshots. This package does not change serving gates and does not
promote constrained SVI.
"""

from project.options_surface.corpus.schema import (
    CAPTURE_SCHEMA_VERSION,
    SUPPORTED_CAPTURE_SCHEMAS,
)

__all__ = [
    "CAPTURE_SCHEMA_VERSION",
    "SUPPORTED_CAPTURE_SCHEMAS",
]
