"""RV momentum desk-label grammar (EXPANDING ↔ CONTRACTING pair)."""

from __future__ import annotations

import pytest

from project.api.repository import _rv_trend_label


@pytest.mark.parametrize(
    ("ratio", "expected"),
    [
        (1.52, "Accelerating"),
        (1.30, "Accelerating"),
        (1.29, "Expanding"),
        (1.10, "Expanding"),
        (1.09, "Stable"),
        (1.00, "Stable"),
        (0.90, "Stable"),
        (0.89, "Contracting"),
        (0.70, "Contracting"),
        (0.69, "Collapsing"),
        (0.40, "Collapsing"),
    ],
)
def test_rv_trend_label_thresholds(ratio: float, expected: str) -> None:
    assert _rv_trend_label(ratio) == expected
