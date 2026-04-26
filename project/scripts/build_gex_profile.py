from __future__ import annotations

import argparse
import csv
from pathlib import Path

from greeks.gex_engine import compute_gex_profile, write_profile_artifacts
from greeks.providers import (
    DeribitPublicGreeksProvider,
    load_greeks_snapshot_json,
    write_greeks_snapshot_json,
)
from greeks.types import DealerInventoryRow

VALID_OPTION_TYPES = {"call", "put"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Phase 4 GEX artifacts from dealer inventory.")
    parser.add_argument("--inventory-csv", required=True, help="Phase 3 dealer inventory snapshot CSV.")
    parser.add_argument("--output-dir", required=True, help="Directory for Phase 4 GEX artifacts.")
    parser.add_argument("--currency", default="BTC", help="Currency scope for live Deribit greeks.")
    parser.add_argument("--methodology-version", default="phase4.gex.v1")
    parser.add_argument(
        "--greeks-json",
        default=None,
        help="Optional frozen greeks snapshot JSON. If omitted, fetch live greeks from Deribit.",
    )
    parser.add_argument(
        "--fail-on-missing-greeks",
        action="store_true",
        help="Exit non-zero if any inventory row cannot be joined to a greeks snapshot.",
    )
    return parser.parse_args()


def parse_bool(value: str | None, default: bool = True) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "t", "yes", "y"}


def load_inventory_csv(path: str | Path) -> list[DealerInventoryRow]:
    rows: list[DealerInventoryRow] = []

    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {
            "instrument_name",
            "option_type",
            "strike",
            "expiry_ts",
            "net_contracts",
            "contract_multiplier",
        }
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"Inventory CSV missing required columns: {sorted(missing)}")

        for raw_row in reader:
            option_type = raw_row["option_type"].strip().lower()
            if option_type not in VALID_OPTION_TYPES:
                raise ValueError(f"Unsupported option_type for GEX inventory row: {option_type}")

            rows.append(
                DealerInventoryRow(
                    instrument_name=raw_row["instrument_name"].strip(),
                    option_type=option_type,
                    strike=float(raw_row["strike"]),
                    expiry_ts=int(raw_row["expiry_ts"]),
                    net_contracts=float(raw_row["net_contracts"]),
                    contract_multiplier=float(raw_row["contract_multiplier"]),
                    include_in_gex=parse_bool(raw_row.get("include_in_gex"), default=True),
                )
            )

    return rows


def main() -> None:
    args = parse_args()
    currency = args.currency.upper()
    if currency != "BTC":
        raise SystemExit("Phase 4 builder is BTC-only.")

    inventory_rows = load_inventory_csv(args.inventory_csv)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.greeks_json:
        greeks = load_greeks_snapshot_json(args.greeks_json)
    else:
        with DeribitPublicGreeksProvider() as provider:
            greeks = provider.fetch_current_option_greeks(currency=currency)
        write_greeks_snapshot_json(greeks, output_dir / "greeks_snapshot.json")

    profile = compute_gex_profile(
        inventory_rows=inventory_rows,
        greeks_by_instrument=greeks,
        methodology_version=args.methodology_version,
    )
    write_profile_artifacts(profile, output_dir)

    if args.fail_on_missing_greeks and profile.missing_greeks:
        missing = ", ".join(profile.missing_greeks[:10])
        raise SystemExit(f"Missing greeks for {len(profile.missing_greeks)} instrument(s): {missing}")


if __name__ == "__main__":
    main()
