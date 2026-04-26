from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from normalizer.models import CanonicalInstrument
from normalizer.instruments import normalize_instrument


def _decimal_to_str(value: Decimal) -> str:
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


@dataclass(frozen=True, slots=True)
class EnrichedInventoryRow:
    instrument_name: str
    option_type: str
    strike: Decimal
    expiry_ts: int
    net_contracts: Decimal
    contract_multiplier: Decimal
    include_in_gex: bool

    def to_csv_row(self) -> dict[str, str]:
        return {
            "instrument_name": self.instrument_name,
            "option_type": self.option_type,
            "strike": _decimal_to_str(self.strike),
            "expiry_ts": str(self.expiry_ts),
            "net_contracts": _decimal_to_str(self.net_contracts),
            "contract_multiplier": _decimal_to_str(self.contract_multiplier),
            "include_in_gex": "true" if self.include_in_gex else "false",
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a Phase 3 dealer inventory snapshot into the canonical Phase 4 inventory CSV."
    )
    parser.add_argument("--snapshot-jsonl", required=True, help="Path to dealer_inventory_snapshots.jsonl.")
    parser.add_argument(
        "--instruments-jsonl",
        default=None,
        help="Path to canonical instrument metadata JSONL.",
    )
    parser.add_argument(
        "--instruments-csv",
        default=None,
        help="Path to canonical instrument metadata CSV.",
    )
    parser.add_argument("--output-csv", required=True, help="Destination CSV for Phase 4 inventory rows.")
    parser.add_argument(
        "--snapshot-id",
        default=None,
        help="Optional snapshot_id to export. Defaults to the latest snapshot in the JSONL file.",
    )
    args = parser.parse_args()

    if bool(args.instruments_jsonl) == bool(args.instruments_csv):
        parser.error("Provide exactly one of --instruments-jsonl or --instruments-csv.")

    return args


def load_snapshot_records(path: str | Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def select_snapshot(records: list[dict[str, Any]], snapshot_id: str | None = None) -> dict[str, Any]:
    if not records:
        raise ValueError("Snapshot JSONL is empty.")

    if snapshot_id is None:
        return records[-1]

    for record in records:
        if str(record.get("snapshot_id")) == snapshot_id:
            return record

    raise KeyError(f"Unknown snapshot_id: {snapshot_id}")


def load_instruments_jsonl(path: str | Path) -> dict[str, CanonicalInstrument]:
    instruments: dict[str, CanonicalInstrument] = {}
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)
            instrument = normalize_instrument(raw)
            instruments[instrument.instrument_name] = instrument
    return instruments


def load_instruments_csv(path: str | Path) -> dict[str, CanonicalInstrument]:
    instruments: dict[str, CanonicalInstrument] = {}
    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            instrument = normalize_instrument(row)
            instruments[instrument.instrument_name] = instrument
    return instruments


def _include_in_gex(instrument: CanonicalInstrument) -> bool:
    return (
        instrument.venue == "deribit"
        and instrument.underlying == "BTC"
        and instrument.kind == "option"
        and instrument.option_type in {"call", "put"}
        and instrument.expiry_ts_ms is not None
        and instrument.strike is not None
        and instrument.contract_size is not None
        and not instrument.is_combo
    )


def enrich_snapshot_positions(
    snapshot: dict[str, Any],
    instruments_by_name: dict[str, CanonicalInstrument],
) -> list[EnrichedInventoryRow]:
    positions = snapshot.get("positions")
    if not isinstance(positions, dict):
        raise ValueError("Snapshot record missing positions map.")

    rows: list[EnrichedInventoryRow] = []

    for instrument_name, position_value in sorted(positions.items(), key=lambda item: item[0]):
        instrument = instruments_by_name.get(str(instrument_name))
        if instrument is None:
            raise KeyError(f"Missing instrument metadata for inventory position: {instrument_name}")

        # The Phase 4 inventory CSV is option-shaped. Non-option and combo instruments
        # remain preserved in upstream artifacts, but are not emitted into this adapter output.
        if instrument.kind != "option" or instrument.is_combo:
            continue

        if instrument.option_type is None or instrument.expiry_ts_ms is None or instrument.strike is None:
            raise ValueError(f"Incomplete option metadata for inventory position: {instrument_name}")

        if instrument.contract_size is None:
            raise ValueError(f"Missing contract_size for inventory position: {instrument_name}")

        rows.append(
            EnrichedInventoryRow(
                instrument_name=instrument.instrument_name,
                option_type=instrument.option_type,
                strike=instrument.strike,
                expiry_ts=instrument.expiry_ts_ms,
                net_contracts=Decimal(str(position_value)),
                contract_multiplier=instrument.contract_size,
                include_in_gex=_include_in_gex(instrument),
            )
        )

    rows.sort(key=lambda row: (row.expiry_ts, row.strike, row.option_type, row.instrument_name))
    return rows


def write_inventory_csv(rows: list[EnrichedInventoryRow], path: str | Path) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "instrument_name",
        "option_type",
        "strike",
        "expiry_ts",
        "net_contracts",
        "contract_multiplier",
        "include_in_gex",
    ]
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in sorted(rows, key=lambda row: (row.expiry_ts, row.strike, row.option_type, row.instrument_name)):
            writer.writerow(row.to_csv_row())


def main() -> None:
    args = parse_args()
    snapshot_records = load_snapshot_records(args.snapshot_jsonl)
    snapshot = select_snapshot(snapshot_records, snapshot_id=args.snapshot_id)
    if args.instruments_jsonl:
        instruments_by_name = load_instruments_jsonl(args.instruments_jsonl)
    else:
        instruments_by_name = load_instruments_csv(args.instruments_csv)

    rows = enrich_snapshot_positions(snapshot, instruments_by_name)
    write_inventory_csv(rows, args.output_csv)


if __name__ == "__main__":
    main()
