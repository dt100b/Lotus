from __future__ import annotations

import argparse
import json

import _bootstrap  # noqa: F401

from api.config import settings
from pipeline.dashboard_snapshot import materialize_dashboard_snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Materialize the Phase 5 dashboard snapshot from the Phase 1 SQLite database."
    )
    parser.add_argument(
        "--db-path",
        default="project/data/phase1.sqlite3",
        help="Path to the Phase 1 SQLite database.",
    )
    parser.add_argument(
        "--artifacts-dir",
        default="project/runtime/dashboard_build",
        help="Directory for intermediate Phase 2/3/4 artifacts.",
    )
    parser.add_argument(
        "--snapshot-path",
        default=str(settings.snapshot_path),
        help="Destination for the Phase 5 dashboard snapshot JSON.",
    )
    parser.add_argument(
        "--greeks-json",
        default=None,
        help="Optional frozen greeks snapshot JSON. If omitted, live BTC option greeks are fetched from Deribit.",
    )
    parser.add_argument(
        "--snapshot-id",
        default=None,
        help="Optional Phase 3 snapshot_id to export. Defaults to the latest ledger snapshot.",
    )
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="Allow the pipeline to complete even if the final dashboard snapshot has zero rows.",
    )
    parser.add_argument(
        "--mode",
        choices=("auto", "full", "incremental"),
        default="auto",
        help=(
            "auto uses inventory_checkpoint.json when compatible; "
            "full always rebuilds from the entire Phase 1 history; "
            "incremental requires a usable checkpoint."
        ),
    )
    parser.add_argument(
        "--lightweight",
        action="store_true",
        help="Skip multi-GB intermediate JSONL/CSV artifacts (Phase 6 live style).",
    )
    parser.add_argument(
        "--include-otc-secondary",
        action="store_true",
        help=(
            "ARCHIVED feature: also materialize the include-OTC (blocks/combos) "
            "secondary GEX profile. Off by default; see "
            "project/docs/archived_include_otc_prints.md."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = materialize_dashboard_snapshot(
        db_path=args.db_path,
        artifacts_dir=args.artifacts_dir,
        snapshot_path=args.snapshot_path,
        greeks_json=args.greeks_json,
        snapshot_id=args.snapshot_id,
        fail_on_empty=not args.allow_empty,
        mode=args.mode,
        lightweight=args.lightweight,
        enable_include_otc_secondary=args.include_otc_secondary,
    )
    print(json.dumps(result.to_dict(), indent=2))


if __name__ == "__main__":
    main()
