from __future__ import annotations

import csv
import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Iterable

from greeks.types import (
    DealerInventoryRow,
    ExpiryProfileRow,
    GEXInstrumentRow,
    GEXProfile,
    GreekSnapshot,
    StrikeProfileRow,
)


def compute_gex_profile(
    inventory_rows: Iterable[DealerInventoryRow],
    greeks_by_instrument: dict[str, GreekSnapshot],
    methodology_version: str,
    as_of_ts: int | None = None,
) -> GEXProfile:
    ordered_inventory = sorted(
        inventory_rows,
        key=lambda row: (
            row.expiry_ts,
            row.strike,
            row.option_type,
            row.instrument_name,
            row.net_contracts,
            row.contract_multiplier,
            row.include_in_gex,
        ),
    )

    if as_of_ts is None:
        as_of_ts = max(
            (snapshot.snapshot_ts for snapshot in greeks_by_instrument.values()),
            default=int(time.time() * 1000),
        )

    instrument_rows: list[GEXInstrumentRow] = []
    strike_buckets: dict[float, dict[str, float]] = {}
    expiry_buckets: dict[int, dict[str, float]] = {}
    missing_greeks: set[str] = set()

    for row in ordered_inventory:
        if not row.include_in_gex or row.net_contracts == 0:
            continue

        greek = greeks_by_instrument.get(row.instrument_name)
        if greek is None:
            missing_greeks.add(row.instrument_name)
            continue

        position_gamma = row.net_contracts * row.contract_multiplier * greek.gamma
        dollar_gamma_per_1pct = position_gamma * (greek.spot_price**2) * 0.01

        instrument_row = GEXInstrumentRow(
            instrument_name=row.instrument_name,
            option_type=row.option_type,
            strike=row.strike,
            expiry_ts=row.expiry_ts,
            net_contracts=row.net_contracts,
            contract_multiplier=row.contract_multiplier,
            gamma=greek.gamma,
            spot_price=greek.spot_price,
            open_interest=greek.open_interest,
            mark_iv=greek.mark_iv,
            position_gamma=position_gamma,
            dollar_gamma_per_1pct=dollar_gamma_per_1pct,
            snapshot_ts=greek.snapshot_ts,
        )
        instrument_rows.append(instrument_row)

        strike_bucket = strike_buckets.setdefault(row.strike, {"call": 0.0, "put": 0.0})
        strike_bucket[row.option_type] += dollar_gamma_per_1pct

        expiry_bucket = expiry_buckets.setdefault(row.expiry_ts, {"call": 0.0, "put": 0.0})
        expiry_bucket[row.option_type] += dollar_gamma_per_1pct

    by_strike = tuple(
        StrikeProfileRow(
            strike=strike,
            call_gex=bucket["call"],
            put_gex=bucket["put"],
            net_gex=bucket["call"] + bucket["put"],
            gross_gex=abs(bucket["call"]) + abs(bucket["put"]),
        )
        for strike, bucket in sorted(strike_buckets.items(), key=lambda item: item[0])
    )

    by_expiry = tuple(
        ExpiryProfileRow(
            expiry_ts=expiry_ts,
            call_gex=bucket["call"],
            put_gex=bucket["put"],
            net_gex=bucket["call"] + bucket["put"],
            gross_gex=abs(bucket["call"]) + abs(bucket["put"]),
        )
        for expiry_ts, bucket in sorted(expiry_buckets.items(), key=lambda item: item[0])
    )

    return GEXProfile(
        as_of_ts=as_of_ts,
        methodology_version=methodology_version,
        instrument_rows=tuple(instrument_rows),
        by_strike=by_strike,
        by_expiry=by_expiry,
        missing_greeks=tuple(sorted(missing_greeks)),
    )


def write_profile_artifacts(profile: GEXProfile, output_dir: str | Path) -> None:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    _write_csv(output_path / "gex_by_instrument.csv", profile.instrument_rows)
    _write_csv(output_path / "gex_by_strike.csv", profile.by_strike)
    _write_csv(output_path / "gex_by_expiry.csv", profile.by_expiry)
    (output_path / "gex_summary.json").write_text(
        json.dumps(profile.to_summary(), indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _write_csv(path: Path, rows: Iterable[object]) -> None:
    records = list(rows)
    if not records:
        path.write_text("", encoding="utf-8")
        return

    first_row = asdict(records[0])
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(first_row.keys()))
        writer.writeheader()
        writer.writerow(first_row)

        for row in records[1:]:
            writer.writerow(asdict(row))
