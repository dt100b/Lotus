"""Descriptive changes between stored snapshots. Not a forecast."""

from __future__ import annotations

from typing import Any, Mapping


def snapshot_changes(
    current: Mapping[str, Any],
    previous: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if previous is None:
        return {"available": False, "reason": "no_previous_snapshot"}
    cur_an = current.get("analytics") or {}
    prev_an = previous.get("analytics") or {}
    return {
        "available": True,
        "atm_iv_change": _delta(cur_an.get("atm_iv"), prev_an.get("atm_iv")),
        "rr_25_change": _delta(cur_an.get("rr_25"), prev_an.get("rr_25")),
        "bf_25_change": _delta(cur_an.get("bf_25"), prev_an.get("bf_25")),
        "forward_change": _delta(
            (current.get("forward") or {}).get("forward_usd"),
            (previous.get("forward") or {}).get("forward_usd"),
        ),
        "p50_change": _delta(
            ((current.get("density") or {}).get("quantiles") or {}).get("p50"),
            ((previous.get("density") or {}).get("quantiles") or {}).get("p50"),
        ),
    }


def _delta(current: Any, previous: Any) -> float | None:
    try:
        return float(current) - float(previous)
    except (TypeError, ValueError):
        return None
