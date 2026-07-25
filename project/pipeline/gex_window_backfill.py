"""Real gex_window_history backfill from production flow inventory.

Method
------
Hybrid **checkpoint reverse-replay + timed forward sampling**:

1. Start from the durable production inventory checkpoint (full-book positions
   after applying all Phase 1 trades up to the checkpoint watermark).
2. Load raw trades in the lookback window from ``phase1_history.sqlite3``.
3. Normalize with production rules and adapt to Phase 3 ledger events
   (blocks/combos excluded via ``production_ledger_policy``).
4. Reverse-apply window trades newer than the window start to reconstruct the
   book at ``T0``, then forward-apply while sampling inventory at a fixed
   cadence (default 15 minutes).
5. Revalue each sample's inventory with the **current** (or frozen) Greeks
   snapshot — historical per-sample Greeks are not stored. Documented as an
   approximation: period Δs reflect true flow-inventory change revalued at a
   fixed Greeks surface.

Outputs
-------
- ``gex_window_history.json`` (source of truth for Velocity period bars)
- optional patch of ``latest_gex_snapshot.json`` ``flow_regime.velocity``
  (period_deltas + windows) so the API/FE serve real hour-by-hour ΔNetGEX

Live materialize continues to append via ``append_history_sample`` afterward.
Horizon session logic is not modified.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from statistics import median
from typing import Any, Mapping

from greeks.gex_engine import compute_gex_profile
from greeks.providers import load_greeks_snapshot_json
from greeks.types import DealerInventoryRow, GreekSnapshot
from ledger.models import NormalizedTradeEvent as LedgerNormalizedTradeEvent
from ledger.models import decimal_to_str, to_decimal
from ledger.replay import DUST, ZERO
from ledger.rules import (
    classify_event,
    dealer_position_delta,
    production_ledger_policy,
)
from normalizer.service import normalize_trade_batch
from pipeline.dashboard_snapshot import (
    _instruments_from_phase2_records,
    build_phase3_events,
    load_raw_phase1_records,
)
from pipeline.flow_regime import (
    HISTORY_RETENTION_MS,
    HISTORY_VERSION,
    PERIOD_DELTA_HOURS,
    _strike_key,
    build_flow_regime_payload,
    history_path,
    strike_gex_map_from_profile_rows,
)
from pipeline.inventory_checkpoint import checkpoint_path, load_checkpoint
from scripts.export_inventory_snapshot import enrich_snapshot_positions

BACKFILL_KIND = "inventory_replay_current_greeks"
DEFAULT_INTERVAL_MIN = 15
DEFAULT_HOURS = 26.0
GEX_METHODOLOGY_VERSION = "phase4.gex.v1"
NORMALIZATION_VERSION = "phase2.v1"
LEDGER_METHODOLOGY_VERSION = "phase3.ledger.v1"


@dataclass(frozen=True, slots=True)
class BackfillResult:
    artifacts_dir: Path
    history_path: Path
    snapshot_path: Path | None
    sample_count: int
    first_ts_ms: int
    last_ts_ms: int
    span_hours: float
    interval_min: int
    greeks_mode: str
    greeks_path: str | None
    greeks_instrument_count: int
    window_trade_count: int
    applied_event_count: int
    excluded_event_count: int
    period_delta_buckets: int
    period_delta_non_null: int
    velocity_1h: float | None
    velocity_4h: float | None
    velocity_24h: float | None
    requested_hours: float
    available_hours: float
    gap_hours: float
    final_net_gex: float
    checkpoint_final_ts_ms: int
    dry_run: bool
    timings_seconds: dict[str, float]

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifacts_dir": str(self.artifacts_dir),
            "history_path": str(self.history_path),
            "snapshot_path": str(self.snapshot_path) if self.snapshot_path else None,
            "sample_count": self.sample_count,
            "first_ts_ms": self.first_ts_ms,
            "last_ts_ms": self.last_ts_ms,
            "span_hours": self.span_hours,
            "interval_min": self.interval_min,
            "greeks_mode": self.greeks_mode,
            "greeks_path": self.greeks_path,
            "greeks_instrument_count": self.greeks_instrument_count,
            "window_trade_count": self.window_trade_count,
            "applied_event_count": self.applied_event_count,
            "excluded_event_count": self.excluded_event_count,
            "period_delta_buckets": self.period_delta_buckets,
            "period_delta_non_null": self.period_delta_non_null,
            "velocity_1h": self.velocity_1h,
            "velocity_4h": self.velocity_4h,
            "velocity_24h": self.velocity_24h,
            "requested_hours": self.requested_hours,
            "available_hours": self.available_hours,
            "gap_hours": self.gap_hours,
            "final_net_gex": self.final_net_gex,
            "checkpoint_final_ts_ms": self.checkpoint_final_ts_ms,
            "dry_run": self.dry_run,
            "timings_seconds": self.timings_seconds,
            "method": BACKFILL_KIND,
            "period_deltas_are_real_flow": True,
            "greeks_note": (
                "Inventory at each sample is true production flow-book positions; "
                "GEX revalued with a single Greeks surface (current/frozen), not "
                "historical per-sample Greeks."
            ),
        }


def run_gex_window_backfill(
    *,
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path | None = None,
    greeks_json: str | Path | None = None,
    hours: float = DEFAULT_HOURS,
    interval_min: int = DEFAULT_INTERVAL_MIN,
    dry_run: bool = False,
    skip_snapshot: bool = False,
) -> BackfillResult:
    if interval_min < 5:
        raise ValueError("--interval-min must be >= 5")
    if hours < 1.0:
        raise ValueError("--hours must be >= 1")

    artifacts_root = Path(artifacts_dir)
    db = Path(db_path)
    if not artifacts_root.is_dir():
        raise FileNotFoundError(f"artifacts dir not found: {artifacts_root}")
    if not db.exists():
        raise FileNotFoundError(f"Phase 1 DB not found: {db}")

    timings: dict[str, float] = {}
    t = time.perf_counter()

    ckpt = load_checkpoint(checkpoint_path(artifacts_root))
    if ckpt is None:
        raise FileNotFoundError(
            f"inventory_checkpoint.json required under {artifacts_root}. "
            "Run a live materialize once so reverse-replay has a final book."
        )
    end_ms = int(ckpt.final_ts_ms)
    if end_ms <= 0:
        raise ValueError("checkpoint final_ts_ms is missing or zero")

    greeks_path, greeks, greeks_mode = _resolve_greeks(
        artifacts_root=artifacts_root,
        greeks_json=greeks_json,
    )
    timings["greeks_load"] = round(time.perf_counter() - t, 3)
    t = time.perf_counter()

    # Load a slightly longer raw window so the first sample edge has trades.
    requested_span_ms = int(hours * 3600 * 1000)
    load_start_ms = max(0, end_ms - requested_span_ms - interval_min * 60 * 1000)
    raw_instruments, raw_trades = load_raw_phase1_records(
        db,
        trades_after_timestamp_ms=load_start_ms,
    )
    timings["load_raw"] = round(time.perf_counter() - t, 3)
    t = time.perf_counter()

    phase2 = normalize_trade_batch(
        raw_instruments,
        raw_trades,
        method_version=NORMALIZATION_VERSION,
        strict_instrument_lookup=False,
    )
    del raw_instruments
    del raw_trades
    instruments_by_name = _instruments_from_phase2_records(phase2["instruments"])
    events = build_phase3_events(
        phase2["trades"], normalization_version=NORMALIZATION_VERSION
    )
    del phase2
    timings["normalize"] = round(time.perf_counter() - t, 3)
    t = time.perf_counter()

    # Only events at or before the checkpoint watermark belong to the book.
    ledger_events = [
        LedgerNormalizedTradeEvent.from_dict(row)
        for row in events
        if int(row["ts_ms"]) <= end_ms
    ]
    del events
    ledger_events.sort(key=lambda e: (e.ts_ms, e.trade_seq, e.event_id))

    policy = production_ledger_policy(methodology_version=LEDGER_METHODOLOGY_VERSION)
    applied_count = 0
    excluded_count = 0
    for event in ledger_events:
        ok, _ = classify_event(event, policy)
        if ok:
            applied_count += 1
        else:
            excluded_count += 1

    # Available coverage: from first window trade (or load_start) to checkpoint.
    trade_ts = [e.ts_ms for e in ledger_events]
    first_trade_ms = min(trade_ts) if trade_ts else end_ms
    available_hours = max(0.0, (end_ms - first_trade_ms) / 3_600_000.0)
    # Actual sample window: min(requested, available, retention).
    span_ms = min(requested_span_ms, end_ms - first_trade_ms, HISTORY_RETENTION_MS)
    if span_ms < interval_min * 60 * 1000:
        raise ValueError(
            f"Insufficient trade history for backfill: available≈{available_hours:.2f}h"
        )
    start_ms = end_ms - span_ms
    gap_hours = max(0.0, hours - (span_ms / 3_600_000.0))

    sample_timestamps = _sample_grid(
        start_ms=start_ms,
        end_ms=end_ms,
        interval_min=interval_min,
    )

    positions = _positions_from_checkpoint(ckpt.positions)
    # Reverse-apply every event strictly after start_ms → book at start_ms.
    to_reverse = [e for e in ledger_events if int(e.ts_ms) > start_ms]
    for event in reversed(to_reverse):
        _apply_event(positions, event, policy, reverse=True)
    timings["reverse_replay"] = round(time.perf_counter() - t, 3)
    t = time.perf_counter()

    # Forward from start_ms, sampling after applying events with ts <= sample_ts.
    forward_events = [e for e in ledger_events if int(e.ts_ms) > start_ms]
    samples: list[dict[str, Any]] = []
    event_idx = 0
    n_fwd = len(forward_events)
    for sample_ts in sample_timestamps:
        while event_idx < n_fwd and int(forward_events[event_idx].ts_ms) <= sample_ts:
            _apply_event(positions, forward_events[event_idx], policy, reverse=False)
            event_idx += 1
        sample = _revalue_positions(
            positions=positions,
            instruments_by_name=instruments_by_name,
            greeks=greeks,
            sample_ts_ms=sample_ts,
        )
        samples.append(sample)
    # Ensure any remaining events up to end are applied so final matches checkpoint.
    while event_idx < n_fwd:
        _apply_event(positions, forward_events[event_idx], policy, reverse=False)
        event_idx += 1
    # Replace / append true end sample at checkpoint watermark.
    end_sample = _revalue_positions(
        positions=positions,
        instruments_by_name=instruments_by_name,
        greeks=greeks,
        sample_ts_ms=end_ms,
    )
    if samples and abs(int(samples[-1]["ts_ms"]) - end_ms) < 5_000:
        samples[-1] = end_sample
    else:
        samples.append(end_sample)

    timings["forward_sample"] = round(time.perf_counter() - t, 3)
    t = time.perf_counter()

    velocity = _velocity_from_samples(samples)
    periods = velocity["period_deltas"]
    non_null = sum(1 for p in periods if p.get("delta_net_gex") is not None)

    hist_out = history_path(artifacts_root)
    if not dry_run:
        _write_history_doc(
            hist_out,
            samples=samples,
            meta={
                "kind": BACKFILL_KIND,
                "greeks_mode": greeks_mode,
                "greeks_path": str(greeks_path) if greeks_path else None,
                "greeks_instrument_count": len(greeks),
                "db_path": str(db),
                "checkpoint_final_ts_ms": end_ms,
                "checkpoint_positions_sha256": ckpt.positions_sha256,
                "window_trade_count": len(ledger_events),
                "applied_event_count": applied_count,
                "excluded_event_count": excluded_count,
                "interval_min": interval_min,
                "requested_hours": hours,
                "available_hours": available_hours,
                "gap_hours": gap_hours,
                "sample_count": len(samples),
                "first_ts_ms": samples[0]["ts_ms"],
                "last_ts_ms": samples[-1]["ts_ms"],
                "backfilled_at_utc": datetime.now(tz=UTC).isoformat(),
                "note": (
                    "Real production inventory replay at timed checkpoints; "
                    "GEX revalued with a single Greeks surface (not historical)."
                ),
            },
        )
    timings["write_history"] = round(time.perf_counter() - t, 3)
    t = time.perf_counter()

    snap_out: Path | None = None
    if not skip_snapshot and snapshot_path is not None:
        snap_out = Path(snapshot_path)
        if snap_out.exists():
            _patch_snapshot_velocity(
                snap_out,
                samples=samples,
                meta={
                    "kind": BACKFILL_KIND,
                    "greeks_mode": greeks_mode,
                    "period_delta_non_null": non_null,
                    "period_delta_buckets": len(periods),
                    "sample_count": len(samples),
                    "backfilled_at_utc": datetime.now(tz=UTC).isoformat(),
                },
                dry_run=dry_run,
            )
        else:
            snap_out = None
    timings["patch_snapshot"] = round(time.perf_counter() - t, 3)

    first_ts = int(samples[0]["ts_ms"])
    last_ts = int(samples[-1]["ts_ms"])
    return BackfillResult(
        artifacts_dir=artifacts_root,
        history_path=hist_out,
        snapshot_path=snap_out,
        sample_count=len(samples),
        first_ts_ms=first_ts,
        last_ts_ms=last_ts,
        span_hours=(last_ts - first_ts) / 3_600_000.0,
        interval_min=interval_min,
        greeks_mode=greeks_mode,
        greeks_path=str(greeks_path) if greeks_path else None,
        greeks_instrument_count=len(greeks),
        window_trade_count=len(ledger_events),
        applied_event_count=applied_count,
        excluded_event_count=excluded_count,
        period_delta_buckets=len(periods),
        period_delta_non_null=non_null,
        velocity_1h=(velocity["windows"].get("1h") or {}).get("delta_net_gex"),
        velocity_4h=(velocity["windows"].get("4h") or {}).get("delta_net_gex"),
        velocity_24h=(velocity["windows"].get("24h") or {}).get("delta_net_gex"),
        requested_hours=float(hours),
        available_hours=float(available_hours),
        gap_hours=float(gap_hours),
        final_net_gex=float(samples[-1]["net_gex"]),
        checkpoint_final_ts_ms=end_ms,
        dry_run=dry_run,
        timings_seconds=timings,
    )


# ── helpers ──────────────────────────────────────────────────────────────────


def _resolve_greeks(
    *,
    artifacts_root: Path,
    greeks_json: str | Path | None,
) -> tuple[Path | None, dict[str, GreekSnapshot], str]:
    candidates: list[Path] = []
    if greeks_json is not None:
        candidates.append(Path(greeks_json))
    candidates.extend(
        [
            artifacts_root / "gex" / "greeks_snapshot.json",
            Path("project/greeks/data/greeks_snapshot.json"),
        ]
    )
    for path in candidates:
        if path.exists():
            return path, load_greeks_snapshot_json(path), "current_frozen_file"
    raise FileNotFoundError(
        "No Greeks snapshot found. Pass --greeks-json or ensure "
        f"{artifacts_root / 'gex' / 'greeks_snapshot.json'} exists "
        "(from a prior materialize). Historical per-sample Greeks are not available."
    )


def _positions_from_checkpoint(
    positions: Mapping[str, Decimal],
) -> dict[str, Decimal]:
    out: dict[str, Decimal] = {}
    for name, pos in positions.items():
        value = to_decimal(pos)
        if abs(value) > DUST:
            out[str(name)] = value
    return out


def _apply_event(
    positions: dict[str, Decimal],
    event: LedgerNormalizedTradeEvent,
    policy,
    *,
    reverse: bool,
) -> None:
    applied, _reason = classify_event(event, policy)
    if not applied:
        return
    delta = dealer_position_delta(event)
    if reverse:
        delta = -delta
    key = event.inventory_key
    after = positions.get(key, ZERO) + delta
    if abs(after) <= DUST:
        positions.pop(key, None)
    else:
        positions[key] = after


def _sample_grid(*, start_ms: int, end_ms: int, interval_min: int) -> list[int]:
    interval_ms = int(interval_min) * 60 * 1000
    # Align to interval grid so UTC hour edges land on samples when interval | 60.
    first = ((int(start_ms) + interval_ms - 1) // interval_ms) * interval_ms
    if first < start_ms:
        first = start_ms
    out: list[int] = []
    # Always include exact start for period-edge coverage.
    out.append(int(start_ms))
    ts = first
    while ts < end_ms:
        if ts > start_ms:
            out.append(int(ts))
        ts += interval_ms
    # Deduplicate while preserving order.
    seen: set[int] = set()
    unique: list[int] = []
    for value in out:
        if value not in seen:
            seen.add(value)
            unique.append(value)
    return unique


def _revalue_positions(
    *,
    positions: Mapping[str, Decimal],
    instruments_by_name: Mapping[str, Any],
    greeks: Mapping[str, GreekSnapshot],
    sample_ts_ms: int,
) -> dict[str, Any]:
    # enrich_snapshot_positions requires str values in the positions map.
    snapshot = {
        "snapshot_id": f"backfill-{sample_ts_ms}",
        "ts_ms": int(sample_ts_ms),
        "last_trade_seq": -1,
        "positions": {
            name: decimal_to_str(pos) for name, pos in sorted(positions.items())
        },
    }
    try:
        inventory_rows = enrich_snapshot_positions(snapshot, dict(instruments_by_name))
    except KeyError:
        # Drop positions whose instrument metadata is gone (rare for options).
        filtered = {
            name: pos
            for name, pos in positions.items()
            if name in instruments_by_name
        }
        snapshot["positions"] = {
            name: decimal_to_str(pos) for name, pos in sorted(filtered.items())
        }
        inventory_rows = enrich_snapshot_positions(snapshot, dict(instruments_by_name))

    gex_rows = [
        DealerInventoryRow(
            instrument_name=row.instrument_name,
            option_type=row.option_type,  # type: ignore[arg-type]
            strike=float(row.strike),
            expiry_ts=int(row.expiry_ts),
            net_contracts=float(row.net_contracts),
            contract_multiplier=float(row.contract_multiplier),
            include_in_gex=bool(row.include_in_gex),
        )
        for row in inventory_rows
        if row.include_in_gex and float(row.net_contracts) != 0.0
    ]
    profile = compute_gex_profile(
        inventory_rows=gex_rows,
        greeks_by_instrument=dict(greeks),
        methodology_version=GEX_METHODOLOGY_VERSION,
        as_of_ts=int(sample_ts_ms),
    )
    by_strike = strike_gex_map_from_profile_rows(profile.by_strike)
    net_gex = float(sum(by_strike.values()))
    spot_candidates = [
        float(row.spot_price) for row in profile.instrument_rows if row.spot_price > 0
    ]
    spot = float(median(spot_candidates)) if spot_candidates else 0.0
    return {
        "ts_ms": int(sample_ts_ms),
        "spot": spot,
        "net_gex": net_gex,
        "by_strike": {
            _strike_key(k): float(v)
            for k, v in by_strike.items()
            if math.isfinite(float(v)) and abs(float(v)) > 0.0
        },
    }


def _velocity_from_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    if not samples:
        return {"windows": {}, "period_deltas": [], "sparkline_24h": []}
    last = samples[-1]
    by_now = {float(k): float(v) for k, v in (last.get("by_strike") or {}).items()}
    net = float(last.get("net_gex") or sum(by_now.values()))
    payload = build_flow_regime_payload(
        as_of_ms=int(last["ts_ms"]),
        spot=float(last.get("spot") or 0.0),
        net_gex_now=net,
        by_strike_now=by_now,
        history_doc={"samples": samples},
        session_by_strike=None,
        session_available=False,
        session_anchor_ms=None,
    )
    return {
        "windows": payload["velocity"]["windows"],
        "period_deltas": payload["velocity"]["period_deltas"],
        "sparkline_24h": payload["velocity"].get("sparkline_24h") or [],
        "history_sample_count": len(samples),
    }


def _write_history_doc(
    path: Path,
    *,
    samples: list[dict[str, Any]],
    meta: dict[str, Any],
) -> None:
    doc = {
        "version": HISTORY_VERSION,
        "delta_definition": "GEX_now - GEX_at_(now - window)",
        "methodology": (
            "signed cumulative flow inventory; production ledger (blocks/combos excluded)"
        ),
        "backfill": meta,
        "samples": samples,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(doc, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )
    tmp.replace(path)


def _patch_snapshot_velocity(
    snapshot_path: Path,
    *,
    samples: list[dict[str, Any]],
    meta: dict[str, Any],
    dry_run: bool,
) -> dict[str, Any]:
    """Inject real period_deltas into the live snapshot the API serves.

    Only mutates flow_regime.velocity / history_sample_count / provenance.
    Leaves Horizon, Regime polarity, rows, and levels untouched.
    """
    snap = json.loads(snapshot_path.read_text(encoding="utf-8"))
    if not isinstance(snap, dict):
        raise ValueError("snapshot is not a JSON object")

    fr = snap.get("flow_regime")
    if not isinstance(fr, dict):
        fr = {
            "version": "flow_regime.v1",
            "as_of_ms": int(samples[-1]["ts_ms"]) if samples else 0,
            "spot": float(samples[-1]["spot"]) if samples else None,
            "delta_gex_definition": "GEX_now - GEX_at_(now - window)",
            "history_sample_count": 0,
            "velocity": {"windows": {}, "period_deltas": [], "sparkline_24h": []},
            "horizon": {
                "full_score": None,
                "session_score": None,
                "session_net_gex": None,
                "agreement": None,
                "read": None,
                "session_available": False,
                "session_anchor_ts_ms": None,
                "session_status": "unavailable",
                "session_reason": "backfill without existing flow_regime",
            },
            "active_strikes": {
                "primary_window": "4h",
                "windows": {
                    "4h": {"window": "4h", "strikes": []},
                    "24h": {"window": "24h", "strikes": []},
                },
            },
        }
        snap["flow_regime"] = fr

    rebuilt = _velocity_from_samples(samples)
    # Prefer snapshot as_of when present so windows align with the live book.
    as_of_ms = int(fr.get("as_of_ms") or samples[-1]["ts_ms"])
    if samples and as_of_ms != int(samples[-1]["ts_ms"]):
        # Rebuild windows against snapshot as_of using history samples.
        last = samples[-1]
        by_now = {float(k): float(v) for k, v in (last.get("by_strike") or {}).items()}
        rebuilt_payload = build_flow_regime_payload(
            as_of_ms=as_of_ms,
            spot=float(fr.get("spot") or last.get("spot") or 0.0),
            net_gex_now=float(last.get("net_gex") or sum(by_now.values())),
            by_strike_now=by_now,
            history_doc={"samples": samples},
            session_by_strike=None,
            session_available=False,
            session_anchor_ms=None,
        )
        rebuilt = {
            "windows": rebuilt_payload["velocity"]["windows"],
            "period_deltas": rebuilt_payload["velocity"]["period_deltas"],
            "sparkline_24h": [],
            "history_sample_count": len(samples),
        }

    periods = rebuilt["period_deltas"]
    non_null = sum(1 for p in periods if p.get("delta_net_gex") is not None)
    vel = fr.get("velocity") if isinstance(fr.get("velocity"), dict) else {}
    vel["period_deltas"] = periods
    vel["windows"] = rebuilt["windows"] or vel.get("windows") or {}
    if "sparkline_24h" not in vel:
        vel["sparkline_24h"] = []
    fr["velocity"] = vel
    fr["history_sample_count"] = int(rebuilt.get("history_sample_count") or len(samples))
    # Real backfill provenance; remove any prior synthetic seed marker.
    fr.pop("velocity_seed", None)
    fr["velocity_backfill"] = {
        **meta,
        "period_delta_non_null": non_null,
        "period_delta_buckets": len(periods),
        "period_deltas_are_real_flow": True,
    }
    snap["flow_regime"] = fr

    if not dry_run:
        tmp = snapshot_path.with_suffix(snapshot_path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(snap, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        tmp.replace(snapshot_path)

    return {
        "ok": True,
        "path": str(snapshot_path),
        "period_delta_non_null": non_null,
        "period_delta_buckets": len(periods),
    }


def verify_samples_are_not_synthetic(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Heuristic: synthetic seed scales a fixed strike shape; real flow changes mix."""
    if len(samples) < 3:
        return {"ok": True, "unique_shapes": len(samples), "reason": "too_few_samples"}

    def _shape(sample: dict[str, Any]) -> tuple[tuple[float, float], ...]:
        bs = sample.get("by_strike") or {}
        if not bs:
            return ()
        total = sum(float(v) for v in bs.values()) or 1.0
        top = sorted(
            ((float(k), float(v) / total) for k, v in bs.items()),
            key=lambda item: -abs(item[1]),
        )[:5]
        return tuple((k, round(share, 4)) for k, share in top)

    shapes = {_shape(s) for s in samples}
    return {
        "ok": len(shapes) > 1,
        "unique_shapes": len(shapes),
        "reason": None if len(shapes) > 1 else "all_by_strike_shapes_identical",
    }
