"""Backfill gex_window_history from real production flow inventory.

Primary path for Velocity 1h period-delta bars. Replaces the synthetic
``seed_gex_window_history`` DEV/UI helper as the source of truth.

See ``pipeline.gex_window_backfill`` for method details (checkpoint reverse
replay + timed forward sampling + current-Greeks revaluation).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import _bootstrap  # noqa: F401

from pipeline.flow_regime import PERIOD_DELTA_HOURS
from pipeline.gex_window_backfill import (
    DEFAULT_HOURS,
    DEFAULT_INTERVAL_MIN,
    run_gex_window_backfill,
    verify_samples_are_not_synthetic,
)
from pipeline.flow_regime import load_history_doc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Backfill gex_window_history.json from real Phase 1 trades + inventory "
            "checkpoint replay, then inject velocity.period_deltas into the live "
            "snapshot. Idempotent / re-runnable."
        )
    )
    parser.add_argument(
        "--db-path",
        default="project/data/phase1_history.sqlite3",
        help="Phase 1 history SQLite (default: phase1_history.sqlite3).",
    )
    parser.add_argument(
        "--artifacts-dir",
        default="project/runtime/dashboard_build",
        help="Artifacts dir with inventory_checkpoint.json + gex_window_history.json.",
    )
    parser.add_argument(
        "--snapshot-path",
        default="project/greeks/data/latest_gex_snapshot.json",
        help="Live Phase 5 snapshot the API serves (gets period_deltas injected).",
    )
    parser.add_argument(
        "--greeks-json",
        default=None,
        help=(
            "Frozen Greeks JSON for revaluation (default: "
            "artifacts/gex/greeks_snapshot.json). Historical Greeks unavailable → "
            "current surface is used and logged."
        ),
    )
    parser.add_argument(
        "--interval-min",
        type=int,
        default=DEFAULT_INTERVAL_MIN,
        help="Sample spacing in minutes (default 15).",
    )
    parser.add_argument(
        "--hours",
        type=float,
        default=DEFAULT_HOURS,
        help="Target lookback hours (default 26; fills max available if shorter).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute samples and report stats without writing files.",
    )
    parser.add_argument(
        "--skip-snapshot",
        action="store_true",
        help="Only write history; do not patch latest_gex_snapshot.json.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Also print machine-readable BackfillResult JSON on stdout.",
    )
    return parser.parse_args()


def _resolve_path(raw: str, *fallback_parts: str) -> Path:
    path = Path(raw)
    if path.exists():
        return path.resolve()
    candidates = [
        Path.cwd() / raw,
        Path(__file__).resolve().parents[2] / raw,
        Path(__file__).resolve().parents[1].joinpath(*fallback_parts),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return path.resolve()


def main() -> int:
    args = parse_args()
    artifacts_dir = _resolve_path(args.artifacts_dir, "runtime", "dashboard_build")
    db_path = _resolve_path(args.db_path, "data", "phase1_history.sqlite3")
    snapshot_path = _resolve_path(
        args.snapshot_path, "greeks", "data", "latest_gex_snapshot.json"
    )
    greeks_json = (
        _resolve_path(args.greeks_json) if args.greeks_json else None
    )

    print("[backfill_gex_window_history] starting real inventory replay backfill")
    print(f"  db:        {db_path}")
    print(f"  artifacts: {artifacts_dir}")
    print(f"  snapshot:  {snapshot_path}")
    print(f"  hours={args.hours}  interval={args.interval_min}m  dry_run={args.dry_run}")

    try:
        result = run_gex_window_backfill(
            db_path=db_path,
            artifacts_dir=artifacts_dir,
            snapshot_path=None if args.skip_snapshot else snapshot_path,
            greeks_json=greeks_json,
            hours=args.hours,
            interval_min=args.interval_min,
            dry_run=args.dry_run,
            skip_snapshot=args.skip_snapshot,
        )
    except Exception as exc:  # noqa: BLE001 — CLI boundary
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    first = datetime.fromtimestamp(result.first_ts_ms / 1000.0, tz=UTC).isoformat()
    last = datetime.fromtimestamp(result.last_ts_ms / 1000.0, tz=UTC).isoformat()

    print(
        f"  method: inventory_checkpoint reverse-replay + timed forward sample "
        f"({result.greeks_mode} revaluation)"
    )
    print(
        f"  greeks: {result.greeks_mode}  path={result.greeks_path}  "
        f"instruments={result.greeks_instrument_count}"
    )
    print(
        f"  window trades: {result.window_trade_count}  "
        f"applied={result.applied_event_count}  excluded={result.excluded_event_count}"
    )
    print(
        f"  samples: {result.sample_count}  span≈{result.span_hours:.2f}h  "
        f"interval={result.interval_min}m"
    )
    print(f"  range: {first} → {last}")
    print(
        f"  requested={result.requested_hours:.2f}h  "
        f"available≈{result.available_hours:.2f}h  "
        f"gap≈{result.gap_hours:.2f}h"
    )
    print(
        f"  period_deltas: {result.period_delta_non_null}/"
        f"{result.period_delta_buckets} non-null  "
        f"(real hour-by-hour ΔNetGEX from flow book)"
    )
    print(
        f"  velocity windows Δ: 1h={result.velocity_1h}  "
        f"4h={result.velocity_4h}  24h={result.velocity_24h}"
    )
    print(f"  final net_gex: {result.final_net_gex:.4f}")
    print(f"  history: {result.history_path}")
    if result.snapshot_path:
        action = "would patch" if result.dry_run else "patched"
        print(f"  snapshot: {action} {result.snapshot_path}")
    elif not args.skip_snapshot:
        print("  snapshot: SKIPPED (file not found)", file=sys.stderr)
    print(f"  timings_s: {result.timings_seconds}")
    print(
        "  note: Inventory is true production flow (blocks/combos excluded). "
        "GEX uses a single current/frozen Greeks surface at every sample — "
        "not historical Greeks."
    )

    # Post-write verification on the history that would be / was written.
    if not result.dry_run:
        doc = load_history_doc(artifacts_dir)
        check = verify_samples_are_not_synthetic(list(doc.get("samples") or []))
        if not check["ok"]:
            print(
                f"  warning: strike-shape diversity low ({check}); "
                "review whether samples collapsed under sparse Greeks coverage",
                file=sys.stderr,
            )
        else:
            print(
                f"  shape_check: ok unique_shapes={check['unique_shapes']} "
                "(not a synthetic scaled ring)"
            )
        if doc.get("backfill", {}).get("kind") != "inventory_replay_current_greeks":
            print("  warning: history missing backfill provenance", file=sys.stderr)

    if args.json:
        print(json.dumps(result.to_dict(), indent=2, sort_keys=True))

    if result.period_delta_non_null < min(PERIOD_DELTA_HOURS, int(result.span_hours)):
        # Soft fail only when we clearly have enough span for more bars.
        if result.span_hours >= PERIOD_DELTA_HOURS and result.period_delta_non_null < PERIOD_DELTA_HOURS:
            print(
                f"  warning: expected {PERIOD_DELTA_HOURS} non-null period bars, "
                f"got {result.period_delta_non_null}",
                file=sys.stderr,
            )
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
