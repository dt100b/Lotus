"""DEPRECATED synthetic seed — use ``backfill_gex_window_history.py`` instead.

Production Velocity bars must come from real inventory replay:

    python project/scripts/backfill_gex_window_history.py

This script remains only for offline UI demos when no Phase 1 DB / checkpoint
is available. It requires ``--force-synthetic`` so it cannot accidentally
overwrite a real backfill as the primary path.

Legacy behavior (when forced):

1. Writes a ~26h synthetic Net GEX ring into gex_window_history.json
2. Injects velocity.period_deltas into latest_gex_snapshot.json

Not production truth — UI unblocking only.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import _bootstrap  # noqa: F401

from pipeline.flow_regime import (
    HISTORY_RETENTION_MS,
    HISTORY_VERSION,
    PERIOD_DELTA_HOURS,
    _strike_key,
    build_flow_regime_payload,
    history_path,
    load_history_doc,
)

# Default cadence: 15 min hits every UTC hour edge (period-Δ tolerance is 20 min).
DEFAULT_INTERVAL_MIN = 15
DEFAULT_HOURS = 26.0
SEED_KIND = "dev_ui_seed"
SEED_NOTE = (
    "Synthetic ring for Velocity period bars UI unblocking only. "
    "Live materialize continues appending real samples afterward."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "DEPRECATED synthetic seed for Velocity UI demos only. "
            "Prefer: python project/scripts/backfill_gex_window_history.py. "
            "Requires --force-synthetic."
        )
    )
    parser.add_argument(
        "--force-synthetic",
        action="store_true",
        help="Required. Acknowledge this writes placeholder samples, not real flow.",
    )
    parser.add_argument(
        "--artifacts-dir",
        default="project/runtime/dashboard_build",
        help="Artifacts dir containing gex_window_history.json (default: dashboard_build).",
    )
    parser.add_argument(
        "--snapshot-path",
        default="project/greeks/data/latest_gex_snapshot.json",
        help="Live Phase 5 snapshot the API serves (gets period_deltas injected).",
    )
    parser.add_argument(
        "--interval-min",
        type=int,
        default=DEFAULT_INTERVAL_MIN,
        help="Sample spacing in minutes (default 15; use 15–30).",
    )
    parser.add_argument(
        "--hours",
        type=float,
        default=DEFAULT_HOURS,
        help="How many hours of history to seed (default 26).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build samples and report stats without writing files.",
    )
    parser.add_argument(
        "--no-variation",
        action="store_true",
        help="Hold net_gex constant (period Δs will be ~0; windows still resolve).",
    )
    parser.add_argument(
        "--skip-snapshot",
        action="store_true",
        help="Only write history; do not patch latest_gex_snapshot.json.",
    )
    return parser.parse_args()


def _resolve_path(raw: str, *fallback_parts: str) -> Path:
    path = Path(raw)
    if path.exists():
        return path.resolve()
    candidates = [
        Path.cwd() / raw,
        Path(__file__).resolve().parents[2] / raw,  # repo root + relative
        Path(__file__).resolve().parents[1].joinpath(*fallback_parts),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return path.resolve()


def _resolve_artifacts_dir(raw: str) -> Path:
    path = _resolve_path(raw, "runtime", "dashboard_build")
    if path.is_dir():
        return path
    # Allow running from repo root or project/ with relative defaults.
    candidates = [
        Path.cwd() / raw,
        Path.cwd() / "project" / "runtime" / "dashboard_build",
        Path(__file__).resolve().parents[1] / "runtime" / "dashboard_build",
    ]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate.resolve()
    return path


def _load_baseline(artifacts_dir: Path) -> dict[str, Any]:
    """Prefer latest history sample; fall back to gex_by_strike.csv (+ spot from greeks)."""
    existing = load_history_doc(artifacts_dir)
    samples = list(existing.get("samples") or [])
    if samples:
        last = samples[-1]
        by_strike = {
            float(k): float(v)
            for k, v in (last.get("by_strike") or {}).items()
            if math.isfinite(float(v))
        }
        return {
            "ts_ms": int(last["ts_ms"]),
            "spot": float(last.get("spot") or 0.0),
            "net_gex": float(last.get("net_gex") or sum(by_strike.values())),
            "by_strike": by_strike,
            "source": "gex_window_history.json:latest",
        }

    strike_csv = artifacts_dir / "gex" / "gex_by_strike.csv"
    if not strike_csv.exists():
        raise SystemExit(
            f"No history samples and no {strike_csv} — cannot seed. "
            "Run materialize once first, or ensure gex artifacts exist."
        )
    by_strike: dict[float, float] = {}
    with strike_csv.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            strike = float(row["strike"])
            net = float(row["net_gex"])
            if math.isfinite(strike) and math.isfinite(net) and abs(net) > 0.0:
                by_strike[strike] = by_strike.get(strike, 0.0) + net
    net_gex = sum(by_strike.values())
    spot = _spot_fallback(artifacts_dir)
    as_of = _as_of_fallback(artifacts_dir)
    return {
        "ts_ms": as_of,
        "spot": spot,
        "net_gex": net_gex,
        "by_strike": by_strike,
        "source": "gex/gex_by_strike.csv",
    }


def _spot_fallback(artifacts_dir: Path) -> float:
    greeks = artifacts_dir / "gex" / "greeks_snapshot.json"
    if greeks.exists():
        try:
            payload = json.loads(greeks.read_text(encoding="utf-8"))
            for key in ("spot", "underlying_price", "index_price"):
                if key in payload and math.isfinite(float(payload[key])):
                    return float(payload[key])
            # Nested instrument rows sometimes carry mark/index.
            for row in payload.get("greeks") or payload.get("instruments") or []:
                if isinstance(row, dict):
                    for key in ("underlying_price", "index_price", "spot"):
                        if key in row and math.isfinite(float(row[key])) and float(row[key]) > 0:
                            return float(row[key])
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
    return 0.0


def _as_of_fallback(artifacts_dir: Path) -> int:
    summary = artifacts_dir / "gex" / "gex_summary.json"
    if summary.exists():
        try:
            payload = json.loads(summary.read_text(encoding="utf-8"))
            for key in ("as_of_ts", "as_of_ms"):
                if key in payload:
                    return int(payload[key])
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
    return int(datetime.now(tz=UTC).timestamp() * 1000)


def _scale_by_strike(base: dict[float, float], target_net: float) -> dict[float, float]:
    current = sum(base.values())
    if not math.isfinite(target_net):
        return dict(base)
    if abs(current) < 1e-12:
        # Degenerate book: pin a single synthetic strike so Active Strikes has shape.
        return {65000.0: target_net} if abs(target_net) > 0 else {}
    scale = target_net / current
    return {k: v * scale for k, v in base.items() if math.isfinite(v) and abs(v) > 0.0}


def _synthetic_net(base_net: float, index: int, n: int, *, flat: bool) -> float:
    """Deterministic light variation so period bars are non-zero; ends near base_net."""
    if flat or n <= 1:
        return base_net
    # Progress 0 → 1; latest sample (index n-1) lands on base_net.
    t = index / (n - 1)
    # Older hours wander ±~10–12% so 1h Δs have magnitude without looking wild.
    wobble = 0.10 * math.sin(index * 0.37) + 0.04 * math.sin(index * 1.13)
    # Fade wobble toward the present so the last point is exact.
    amp = (1.0 - t) * wobble
    return base_net * (1.0 + amp)


def build_seed_samples(
    *,
    baseline: dict[str, Any],
    interval_min: int,
    hours: float,
    flat: bool,
) -> list[dict[str, Any]]:
    if interval_min < 5:
        raise SystemExit("--interval-min must be >= 5")
    if hours < PERIOD_DELTA_HOURS + 1:
        # Need full 24 complete hours plus edge for the oldest bar start.
        hours = float(PERIOD_DELTA_HOURS + 2)

    interval_ms = int(interval_min) * 60 * 1000
    as_of_ms = int(baseline["ts_ms"])
    # Align grid to interval so UTC hour edges land on samples when interval divides 60.
    end_aligned = (as_of_ms // interval_ms) * interval_ms
    start_ms = end_aligned - int(hours * 3600 * 1000)
    # Ensure retention window from as_of keeps the whole ring.
    retention_start = as_of_ms - HISTORY_RETENTION_MS
    if start_ms < retention_start:
        start_ms = (retention_start // interval_ms) * interval_ms

    timestamps: list[int] = []
    ts = start_ms
    while ts <= end_aligned:
        timestamps.append(ts)
        ts += interval_ms
    # Always include the true as-of so the next live append can replace same-second.
    if not timestamps or timestamps[-1] != as_of_ms:
        timestamps.append(as_of_ms)

    base_net = float(baseline["net_gex"])
    base_spot = float(baseline["spot"])
    base_strikes = dict(baseline["by_strike"])
    n = len(timestamps)
    samples: list[dict[str, Any]] = []
    for i, ts_ms in enumerate(timestamps):
        net = _synthetic_net(base_net, i, n, flat=flat)
        # Tiny spot drift (cosmetic; period bars use net_gex only).
        spot = base_spot * (1.0 + 0.0015 * math.sin(i * 0.21)) if base_spot > 0 else base_spot
        by_strike = _scale_by_strike(base_strikes, net)
        samples.append(
            {
                "ts_ms": int(ts_ms),
                "spot": float(spot),
                "net_gex": float(net),
                "by_strike": {
                    _strike_key(k): float(v)
                    for k, v in by_strike.items()
                    if math.isfinite(float(v)) and abs(float(v)) > 0.0
                },
            }
        )
    return samples


def write_history_doc(
    artifacts_dir: Path,
    samples: list[dict[str, Any]],
    *,
    baseline_source: str,
) -> Path:
    path = history_path(artifacts_dir)
    doc = {
        "version": HISTORY_VERSION,
        "delta_definition": "GEX_now - GEX_at_(now - window)",
        "methodology": (
            "signed cumulative flow inventory; production ledger (blocks/combos excluded)"
        ),
        # Extra metadata — loaders ignore unknown keys.
        "seed": {
            "kind": SEED_KIND,
            "note": SEED_NOTE,
            "baseline_source": baseline_source,
            "seeded_at_utc": datetime.now(tz=UTC).isoformat(),
            "sample_count": len(samples),
        },
        "samples": samples,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)
    return path


def _build_velocity_from_samples(
    samples: list[dict[str, Any]],
    *,
    as_of_ms: int | None = None,
    spot: float | None = None,
    net_gex_now: float | None = None,
    by_strike_now: dict[float, float] | None = None,
) -> dict[str, Any]:
    """Rebuild velocity (windows + period_deltas) from history samples."""
    if not samples:
        return {
            "windows": {},
            "period_deltas": [],
            "sparkline_24h": [],
            "history_sample_count": 0,
        }
    last = samples[-1]
    as_of = int(as_of_ms if as_of_ms is not None else last["ts_ms"])
    if by_strike_now is None:
        by_now = {float(k): float(v) for k, v in (last.get("by_strike") or {}).items()}
    else:
        by_now = by_strike_now
    net = (
        float(net_gex_now)
        if net_gex_now is not None and math.isfinite(float(net_gex_now))
        else float(last.get("net_gex") or sum(by_now.values()))
    )
    spot_val = (
        float(spot)
        if spot is not None and math.isfinite(float(spot))
        else float(last.get("spot") or 0.0)
    )
    payload = build_flow_regime_payload(
        as_of_ms=as_of,
        spot=spot_val,
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
        "as_of_ms": as_of,
        "spot": spot_val,
        "net_gex_now": net,
    }


def patch_snapshot_period_deltas(
    snapshot_path: Path,
    samples: list[dict[str, Any]],
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Inject period_deltas into the live snapshot the API/FE actually read.

    Only mutates flow_regime.velocity (and history_sample_count). Leaves
    Horizon, Regime polarity, rows, levels, etc. untouched.
    """
    if not snapshot_path.exists():
        return {
            "ok": False,
            "reason": f"snapshot not found: {snapshot_path}",
            "period_delta_non_null": 0,
        }

    snap = json.loads(snapshot_path.read_text(encoding="utf-8"))
    if not isinstance(snap, dict):
        return {"ok": False, "reason": "snapshot is not a JSON object", "period_delta_non_null": 0}

    fr = snap.get("flow_regime")
    if not isinstance(fr, dict):
        # Minimal shell so Velocity can still render; Horizon stays empty.
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
                "session_reason": "seeded without existing flow_regime",
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

    as_of_ms = int(fr.get("as_of_ms") or (samples[-1]["ts_ms"] if samples else 0))
    spot = fr.get("spot")
    rebuilt = _build_velocity_from_samples(
        samples,
        as_of_ms=as_of_ms,
        spot=float(spot) if spot is not None else None,
    )
    periods = rebuilt["period_deltas"]
    non_null = sum(1 for p in periods if p.get("delta_net_gex") is not None)

    vel = fr.get("velocity") if isinstance(fr.get("velocity"), dict) else {}
    # Preserve any existing windows if rebuild is thinner; prefer rebuilt.
    vel["period_deltas"] = periods
    vel["windows"] = rebuilt["windows"] or vel.get("windows") or {}
    # Keep sparkline key for older clients; empty is fine (FE prefers period_deltas).
    if "sparkline_24h" not in vel:
        vel["sparkline_24h"] = []
    fr["velocity"] = vel
    fr["history_sample_count"] = int(rebuilt["history_sample_count"])
    # Mark seed so operators can see why period bars appeared without a rematerialize.
    fr["velocity_seed"] = {
        "kind": SEED_KIND,
        "note": SEED_NOTE,
        "seeded_at_utc": datetime.now(tz=UTC).isoformat(),
        "period_delta_non_null": non_null,
        "period_delta_buckets": len(periods),
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
        "period_delta_buckets": len(periods),
        "period_delta_non_null": non_null,
        "as_of_ms": as_of_ms,
        "velocity_1h": (rebuilt["windows"].get("1h") or {}).get("delta_net_gex"),
        "velocity_4h": (rebuilt["windows"].get("4h") or {}).get("delta_net_gex"),
        "velocity_24h": (rebuilt["windows"].get("24h") or {}).get("delta_net_gex"),
    }


def _verify(artifacts_dir: Path, samples: list[dict[str, Any]]) -> dict[str, Any]:
    rebuilt = _build_velocity_from_samples(samples)
    periods = rebuilt["period_deltas"]
    non_null = sum(1 for p in periods if p.get("delta_net_gex") is not None)
    return {
        "history_sample_count": len(samples),
        "period_delta_buckets": len(periods),
        "period_delta_non_null": non_null,
        "velocity_1h": (rebuilt["windows"].get("1h") or {}).get("delta_net_gex"),
        "velocity_4h": (rebuilt["windows"].get("4h") or {}).get("delta_net_gex"),
        "velocity_24h": (rebuilt["windows"].get("24h") or {}).get("delta_net_gex"),
        "span_h": (samples[-1]["ts_ms"] - samples[0]["ts_ms"]) / 3_600_000.0,
        "first_ts": samples[0]["ts_ms"],
        "last_ts": samples[-1]["ts_ms"],
        "last_net_gex": samples[-1]["net_gex"],
        "path": str(history_path(artifacts_dir)),
    }


def main() -> int:
    args = parse_args()
    if not args.force_synthetic:
        print(
            "seed_gex_window_history is DEPRECATED and writes synthetic placeholders.\n"
            "Primary path (real flow inventory replay):\n"
            "  python project/scripts/backfill_gex_window_history.py\n"
            "To force synthetic DEV/UI samples anyway, pass --force-synthetic.",
            file=sys.stderr,
        )
        return 2

    artifacts_dir = _resolve_artifacts_dir(args.artifacts_dir)
    if not artifacts_dir.is_dir():
        print(f"artifacts dir not found: {artifacts_dir}", file=sys.stderr)
        return 1

    baseline = _load_baseline(artifacts_dir)
    samples = build_seed_samples(
        baseline=baseline,
        interval_min=args.interval_min,
        hours=args.hours,
        flat=args.no_variation,
    )

    if not args.dry_run:
        out = write_history_doc(
            artifacts_dir,
            samples,
            baseline_source=str(baseline["source"]),
        )
        print(f"[seed_gex_window_history] wrote {out}")
    else:
        print("[seed_gex_window_history] dry-run (no write)")

    stats = _verify(artifacts_dir, samples)
    first = datetime.fromtimestamp(stats["first_ts"] / 1000.0, tz=UTC).isoformat()
    last = datetime.fromtimestamp(stats["last_ts"] / 1000.0, tz=UTC).isoformat()
    print(
        f"  baseline: {baseline['source']}  net_gex={baseline['net_gex']:.2f}  "
        f"spot={baseline['spot']:.2f}"
    )
    print(
        f"  samples: {stats['history_sample_count']}  "
        f"interval={args.interval_min}m  span≈{stats['span_h']:.2f}h"
    )
    print(f"  range: {first} → {last}")
    print(
        f"  period_deltas: {stats['period_delta_non_null']}/"
        f"{stats['period_delta_buckets']} non-null"
    )
    print(
        f"  velocity windows Δ: 1h={stats['velocity_1h']}  "
        f"4h={stats['velocity_4h']}  24h={stats['velocity_24h']}"
    )
    print(f"  history: {stats['path']}")

    snap_stats: dict[str, Any] | None = None
    if not args.skip_snapshot:
        snap_path = _resolve_path(
            args.snapshot_path,
            "greeks",
            "data",
            "latest_gex_snapshot.json",
        )
        snap_stats = patch_snapshot_period_deltas(
            snap_path,
            samples,
            dry_run=args.dry_run,
        )
        if snap_stats.get("ok"):
            action = "would patch" if args.dry_run else "patched"
            print(
                f"  snapshot: {action} {snap_stats['path']}  "
                f"period_deltas {snap_stats['period_delta_non_null']}/"
                f"{snap_stats['period_delta_buckets']} non-null"
            )
        else:
            print(
                f"  snapshot: SKIPPED ({snap_stats.get('reason')})",
                file=sys.stderr,
            )

    print(f"  note: {SEED_NOTE}")

    if stats["period_delta_non_null"] < PERIOD_DELTA_HOURS:
        print(
            f"  warning: expected {PERIOD_DELTA_HOURS} non-null period bars, "
            f"got {stats['period_delta_non_null']}",
            file=sys.stderr,
        )
        return 2
    if (
        snap_stats is not None
        and snap_stats.get("ok")
        and int(snap_stats.get("period_delta_non_null") or 0) < PERIOD_DELTA_HOURS
    ):
        print(
            "  warning: snapshot period_deltas still incomplete after patch",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
