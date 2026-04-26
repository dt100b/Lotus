from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import _bootstrap  # noqa: F401

from ledger.models import NormalizedTradeEvent
from ledger.replay import LedgerReplayer
from ledger.rules import LedgerPolicy


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True))
            handle.write("\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Phase 3 dealer ledger outputs.")
    parser.add_argument(
        "--input",
        required=True,
        help="Path to Phase 2 normalized events JSONL.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for Phase 3 ledger outputs.",
    )
    parser.add_argument(
        "--snapshot-every",
        type=int,
        default=10_000,
        help="Create a snapshot every N applied events.",
    )
    parser.add_argument(
        "--methodology-version",
        default="phase3.ledger.v1",
        help="Methodology version written into all derived outputs.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    raw_events = read_jsonl(input_path)
    events = [NormalizedTradeEvent.from_dict(record) for record in raw_events]

    policy = LedgerPolicy(
        methodology_version=args.methodology_version,
        snapshot_every=args.snapshot_every,
    )
    result = LedgerReplayer(policy).replay(events)

    write_jsonl(
        output_dir / "position_deltas.jsonl",
        [record.to_dict() for record in result.position_deltas],
    )
    write_jsonl(
        output_dir / "dealer_inventory_snapshots.jsonl",
        [record.to_dict() for record in result.snapshots],
    )

    with (output_dir / "ledger_manifest.json").open("w", encoding="utf-8") as handle:
        json.dump(result.manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
