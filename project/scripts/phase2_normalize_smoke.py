from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from normalizer.service import normalize_trade_batch


def load_records(path: str):
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")

    if file_path.suffix in {".jsonl", ".ndjson"}:
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    payload = json.loads(text)
    if isinstance(payload, list):
        return payload

    if isinstance(payload, dict):
        for key in ("result", "data", "trades", "instruments"):
            if isinstance(payload.get(key), list):
                return payload[key]

    raise ValueError(f"Unsupported JSON shape in {path}")


def write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--instruments", required=True, help="Path to raw instrument JSON/JSONL")
    parser.add_argument("--trades", required=True, help="Path to raw trade JSON/JSONL")
    parser.add_argument("--out-dir", required=True, help="Directory for normalized JSONL outputs")
    parser.add_argument(
        "--non-strict-instrument-lookup",
        action="store_true",
        help="Allow unresolved instrument metadata events instead of failing on missing instrument_name",
    )
    args = parser.parse_args()

    raw_instruments = load_records(args.instruments)
    raw_trades = load_records(args.trades)

    normalized = normalize_trade_batch(
        raw_instruments,
        raw_trades,
        strict_instrument_lookup=not args.non_strict_instrument_lookup,
    )

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    write_jsonl(out_dir / "canonical_instruments.jsonl", normalized["instruments"])
    write_jsonl(out_dir / "normalized_trades.jsonl", normalized["trades"])

    excluded = [row for row in normalized["trades"] if row["excluded_from_v1_derived"]]
    eligible = [row for row in normalized["trades"] if not row["excluded_from_v1_derived"]]
    unresolved = [
        row for row in normalized["trades"]
        if "missing_instrument_metadata" in row.get("exclusion_reasons", [])
    ]
    block_excluded = [row for row in excluded if "block" in row.get("exclusion_reasons", [])]
    combo_excluded = [row for row in excluded if "combo" in row.get("exclusion_reasons", [])]

    summary = {
        "instrument_count": len(normalized["instruments"]),
        "trade_count": len(normalized["trades"]),
        "eligible_trade_count": len(eligible),
        "excluded_trade_count": len(excluded),
        "unresolved_instrument_trade_count": len(unresolved),
        "block_excluded_trade_count": len(block_excluded),
        "combo_excluded_trade_count": len(combo_excluded),
    }

    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
