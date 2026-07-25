from __future__ import annotations

import argparse
import json
from pathlib import Path

import _bootstrap  # noqa: F401

from pipeline.validation_framework import run_framework


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the Lotus backend architecture validation framework "
            "(Tier 1 + Tier 2) and write framework_diagnostics.json."
        )
    )
    parser.add_argument(
        "--db-path",
        default="project/data/phase1_history.sqlite3",
        help="Phase 1 history SQLite path.",
    )
    parser.add_argument(
        "--artifacts-dir",
        default="project/runtime/dashboard_build",
        help="Live materialization artifacts directory.",
    )
    parser.add_argument(
        "--snapshot-path",
        default="project/greeks/data/latest_gex_snapshot.json",
        help="Live Phase 5 snapshot path.",
    )
    parser.add_argument(
        "--output-dir",
        default="project/runtime/validation_expert",
        help="Directory for diagnostics JSON and scratch materializations.",
    )
    parser.add_argument(
        "--jump-threshold",
        type=float,
        default=50.0,
        help="Flag non-block inventory jumps larger than this (contracts).",
    )
    parser.add_argument(
        "--low-volume-fraction",
        type=float,
        default=0.20,
        help="Flag days below this fraction of the 30-day median trade count.",
    )
    parser.add_argument(
        "--gap-hours",
        type=float,
        default=2.0,
        help="Flag trade timestamp gaps larger than this many hours.",
    )
    parser.add_argument(
        "--skip-full-materialize",
        action="store_true",
        help="Skip the shared full lightweight YTD rematerialize (faster).",
    )
    parser.add_argument(
        "--second-full-replay",
        action="store_true",
        help="Also run a second independent full replay for pure determinism hashing.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = run_framework(
        db_path=args.db_path,
        artifacts_dir=args.artifacts_dir,
        snapshot_path=args.snapshot_path,
        output_dir=args.output_dir,
        jump_threshold=args.jump_threshold,
        low_volume_fraction=args.low_volume_fraction,
        gap_hours=args.gap_hours,
        run_fresh_materialize=not args.skip_full_materialize,
        run_full_determinism=not args.skip_full_materialize,
        run_second_full_replay=args.second_full_replay,
    )
    out = Path(args.output_dir) / "framework_diagnostics.json"
    print(json.dumps({"scorecard": report.get("scorecard"), "output": str(out)}, indent=2))
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
