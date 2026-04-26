from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from statistics import median
from typing import Any, Iterable
import csv
import json
import sqlite3

from greeks.gex_engine import compute_gex_profile, write_profile_artifacts
from greeks.providers import (
    DeribitPublicGreeksProvider,
    load_greeks_snapshot_json,
    write_greeks_snapshot_json,
)
from greeks.types import DealerInventoryRow, GEXProfile, GreekSnapshot
from ledger.models import NormalizedTradeEvent as LedgerNormalizedTradeEvent
from ledger.replay import LedgerReplayer
from ledger.rules import LedgerPolicy
from normalizer.service import normalize_trade_batch
from scripts.export_inventory_snapshot import (
    enrich_snapshot_positions,
    load_instruments_jsonl,
    select_snapshot,
    write_inventory_csv,
)


@dataclass(frozen=True)
class MaterializationResult:
    raw_instrument_count: int
    raw_trade_count: int
    phase2_instrument_count: int
    phase2_trade_count: int
    phase3_event_count: int
    ledger_snapshot_count: int
    inventory_row_count: int
    gex_instrument_count: int
    gex_strike_count: int
    snapshot_row_count: int
    artifacts_dir: Path
    greeks_dir: Path
    phase5_snapshot_path: Path
    latest_snapshot_id: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "raw_instrument_count": self.raw_instrument_count,
            "raw_trade_count": self.raw_trade_count,
            "phase2_instrument_count": self.phase2_instrument_count,
            "phase2_trade_count": self.phase2_trade_count,
            "phase3_event_count": self.phase3_event_count,
            "ledger_snapshot_count": self.ledger_snapshot_count,
            "inventory_row_count": self.inventory_row_count,
            "gex_instrument_count": self.gex_instrument_count,
            "gex_strike_count": self.gex_strike_count,
            "snapshot_row_count": self.snapshot_row_count,
            "artifacts_dir": str(self.artifacts_dir),
            "greeks_dir": str(self.greeks_dir),
            "phase5_snapshot_path": str(self.phase5_snapshot_path),
            "latest_snapshot_id": self.latest_snapshot_id,
        }


def load_raw_phase1_records(db_path: str | Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    database_path = Path(db_path)
    if not database_path.exists():
        raise FileNotFoundError(f"Phase 1 SQLite database not found: {database_path}")

    with sqlite3.connect(database_path) as conn:
        instrument_rows = _load_payload_rows(
            conn,
            """
            SELECT payload_json
            FROM raw_instruments
            ORDER BY instrument_name
            """,
        )
        trade_rows = _load_payload_rows(
            conn,
            """
            SELECT payload_json
            FROM raw_trades
            ORDER BY timestamp_ms, trade_seq, instrument_name, trade_id
            """,
        )

    return instrument_rows, trade_rows


def materialize_dashboard_snapshot(
    *,
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
    greeks_json: str | Path | None = None,
    snapshot_id: str | None = None,
    normalization_version: str = "phase2.v1",
    ledger_methodology_version: str = "phase3.ledger.v1",
    gex_methodology_version: str = "phase4.gex.v1",
    fail_on_empty: bool = True,
) -> MaterializationResult:
    artifacts_root = Path(artifacts_dir)
    artifacts_root.mkdir(parents=True, exist_ok=True)
    greeks_dir = artifacts_root / "gex"
    greeks_dir.mkdir(parents=True, exist_ok=True)

    raw_instruments, raw_trades = load_raw_phase1_records(db_path)
    if fail_on_empty and not raw_trades:
        raise ValueError("raw_trades is empty; backfill data before building the dashboard snapshot.")

    phase2 = normalize_trade_batch(
        raw_instruments,
        raw_trades,
        method_version=normalization_version,
        strict_instrument_lookup=True,
    )
    _write_jsonl(artifacts_root / "canonical_instruments.jsonl", phase2["instruments"])
    _write_jsonl(artifacts_root / "normalized_trades_phase2.jsonl", phase2["trades"])

    phase3_events = build_phase3_events(phase2["trades"], normalization_version=normalization_version)
    if fail_on_empty and not phase3_events:
        raise ValueError("No Phase 3 eligible events were produced from normalized trades.")
    _write_jsonl(artifacts_root / "normalized_events_phase3.jsonl", phase3_events)

    ledger_result = LedgerReplayer(
        LedgerPolicy(
            methodology_version=ledger_methodology_version,
            snapshot_every=max(len(phase3_events), 1),
        )
    ).replay([LedgerNormalizedTradeEvent.from_dict(row) for row in phase3_events])

    position_deltas = [record.to_dict() for record in ledger_result.position_deltas]
    snapshots = [record.to_dict() for record in ledger_result.snapshots]
    _write_jsonl(artifacts_root / "position_deltas.jsonl", position_deltas)
    _write_jsonl(artifacts_root / "dealer_inventory_snapshots.jsonl", snapshots)
    _write_json(artifacts_root / "ledger_manifest.json", ledger_result.manifest)

    selected_snapshot = select_snapshot(snapshots, snapshot_id=snapshot_id)
    inventory_rows = enrich_snapshot_positions(
        selected_snapshot,
        load_instruments_jsonl(artifacts_root / "canonical_instruments.jsonl"),
    )
    inventory_csv_path = artifacts_root / "inventory_snapshot.csv"
    write_inventory_csv(inventory_rows, inventory_csv_path)
    gex_inventory_rows = [
        DealerInventoryRow(
            instrument_name=row.instrument_name,
            option_type=row.option_type,
            strike=float(row.strike),
            expiry_ts=int(row.expiry_ts),
            net_contracts=float(row.net_contracts),
            contract_multiplier=float(row.contract_multiplier),
            include_in_gex=bool(row.include_in_gex),
        )
        for row in inventory_rows
    ]

    greeks = _load_or_fetch_greeks(
        greeks_dir=greeks_dir,
        greeks_json=greeks_json,
        instrument_names=[row.instrument_name for row in gex_inventory_rows],
    )
    profile = compute_gex_profile(
        inventory_rows=gex_inventory_rows,
        greeks_by_instrument=greeks,
        methodology_version=gex_methodology_version,
    )
    write_profile_artifacts(profile, greeks_dir)
    phase5_payload = build_phase5_snapshot_payload(profile)
    if fail_on_empty and not phase5_payload["rows"]:
        raise ValueError("Phase 5 snapshot rows are empty; no visible GEX strikes would be rendered.")

    phase5_target = Path(snapshot_path)
    phase5_target.parent.mkdir(parents=True, exist_ok=True)
    _write_json(phase5_target, phase5_payload)

    return MaterializationResult(
        raw_instrument_count=len(raw_instruments),
        raw_trade_count=len(raw_trades),
        phase2_instrument_count=len(phase2["instruments"]),
        phase2_trade_count=len(phase2["trades"]),
        phase3_event_count=len(phase3_events),
        ledger_snapshot_count=len(snapshots),
        inventory_row_count=len(inventory_rows),
        gex_instrument_count=len(profile.instrument_rows),
        gex_strike_count=len(profile.by_strike),
        snapshot_row_count=len(phase5_payload["rows"]),
        artifacts_dir=artifacts_root,
        greeks_dir=greeks_dir,
        phase5_snapshot_path=phase5_target,
        latest_snapshot_id=str(selected_snapshot["snapshot_id"]),
    )


def build_phase3_events(
    normalized_trade_rows: Iterable[dict[str, Any]],
    *,
    normalization_version: str = "phase2.v1",
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    for row in normalized_trade_rows:
        if str(row.get("underlying", "")).upper() != "BTC":
            continue
        if str(row.get("instrument_kind", "")).lower() != "option":
            continue

        trade_seq = row.get("trade_seq")
        option_type = row.get("option_type")
        expiry_ts_ms = row.get("expiry_ts_ms")
        strike = row.get("strike")

        if trade_seq is None or option_type is None or expiry_ts_ms is None or strike is None:
            raise ValueError(
                f"Normalized trade cannot be adapted into Phase 3 input: {row.get('instrument_name')}"
            )

        source_trade_id = str(row.get("trade_id") or row.get("raw_payload_sha256"))
        event_id = str(row.get("raw_payload_sha256") or f"{row.get('instrument_name')}:{source_trade_id}")
        events.append(
            {
                "event_id": event_id,
                "source_trade_id": source_trade_id,
                "trade_seq": int(trade_seq),
                "ts_ms": int(row["timestamp_ms"]),
                "venue": str(row.get("venue", "deribit")).lower(),
                "base_currency": str(row["underlying"]).upper(),
                "kind": "option",
                "instrument_name": str(row["instrument_name"]),
                "option_type": str(option_type).lower(),
                "strike": row["strike"],
                "expiry_ts_ms": int(expiry_ts_ms),
                "contract_size": "1",
                "amount": row["amount"],
                "price": row["price"],
                "taker_side": str(row["taker_side"]).lower(),
                "is_block_trade": bool(row.get("is_block", False)),
                "is_combo_trade": bool(row.get("is_combo", False)),
                "is_single_leg": not bool(row.get("is_combo", False)),
                "normalization_version": normalization_version,
            }
        )

    events.sort(key=lambda row: (int(row["trade_seq"]), int(row["ts_ms"]), str(row["event_id"])))
    return events


def build_phase5_snapshot_payload(profile: GEXProfile) -> dict[str, Any]:
    rows_by_bucket: dict[tuple[str, float], dict[str, float]] = {}

    for row in profile.instrument_rows:
        expiry = datetime.fromtimestamp(row.expiry_ts / 1000, tz=UTC).date().isoformat()
        bucket = rows_by_bucket.setdefault(
            (expiry, float(row.strike)),
            {
                "expiry": expiry,
                "strike": float(row.strike),
                "call_gex": 0.0,
                "put_gex": 0.0,
            },
        )
        bucket[row.option_type + "_gex"] += float(row.dollar_gamma_per_1pct)

    rows = []
    for _, bucket in sorted(rows_by_bucket.items(), key=lambda item: (item[0][0], item[0][1])):
        call_gex = float(bucket["call_gex"])
        put_gex = float(bucket["put_gex"])
        rows.append(
            {
                "expiry": str(bucket["expiry"]),
                "strike": float(bucket["strike"]),
                "net_gex": call_gex + put_gex,
                "call_gex": call_gex,
                "put_gex": put_gex,
            }
        )

    spot_candidates = [float(row.spot_price) for row in profile.instrument_rows]
    if not spot_candidates:
        spot_candidates = [0.0]

    return {
        "as_of": _isoformat_utc(profile.as_of_ts),
        "underlying": "BTC",
        "spot_price": float(median(spot_candidates)),
        "rows": rows,
    }


def _load_or_fetch_greeks(
    *,
    greeks_dir: Path,
    greeks_json: str | Path | None,
    instrument_names: Iterable[str],
) -> dict[str, GreekSnapshot]:
    if greeks_json is not None:
        return load_greeks_snapshot_json(greeks_json)

    with DeribitPublicGreeksProvider() as provider:
        snapshots = provider.fetch_greeks_for_instruments(instrument_names)

    write_greeks_snapshot_json(snapshots, greeks_dir / "greeks_snapshot.json")
    return snapshots


def _load_payload_rows(conn: sqlite3.Connection, query: str) -> list[dict[str, Any]]:
    rows = conn.execute(query).fetchall()
    return [json.loads(row[0]) for row in rows]


def _write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True))
            handle.write("\n")


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _isoformat_utc(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC).isoformat().replace("+00:00", "Z")
