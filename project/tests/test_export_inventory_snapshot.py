from __future__ import annotations

import csv
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.export_inventory_snapshot import (
    enrich_snapshot_positions,
    load_instruments_csv,
    load_instruments_jsonl,
    load_snapshot_records,
    select_snapshot,
    write_inventory_csv,
)


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(__import__("json").dumps(row, separators=(",", ":")) + "\n")


def test_exporter_enriches_selected_snapshot_and_marks_exclusions(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "dealer_inventory_snapshots.jsonl"
    instruments_path = tmp_path / "canonical_instruments.jsonl"

    _write_jsonl(
        snapshots_path,
        [
            {
                "snapshot_id": "genesis",
                "ts_ms": 0,
                "last_trade_seq": -1,
                "positions": {},
                "methodology_version": "phase3.test",
            },
            {
                "snapshot_id": "final",
                "ts_ms": 1700000003000,
                "last_trade_seq": 3,
                "positions": {
                    "BTC-31DEC26-95000-C": "3",
                    "BTC-COMBO-BOX": "2",
                    "ETH-31DEC26-3000-C": "1",
                },
                "methodology_version": "phase3.test",
            },
        ],
    )
    _write_jsonl(
        instruments_path,
        [
            {
                "venue": "deribit",
                "instrument_name": "ETH-31DEC26-3000-C",
                "underlying": "ETH",
                "kind": "option",
                "option_type": "call",
                "expiry_ts_ms": 1798675200000,
                "expiry_label": "31DEC26",
                "strike": "3000",
                "contract_size": "1",
                "tick_size": "0.0001",
                "quote_currency": "BTC",
                "settlement_currency": "BTC",
                "settlement_period": "month",
                "is_active": True,
                "is_combo": False,
                "raw_payload": {"instrument_name": "ETH-31DEC26-3000-C"},
            },
            {
                "venue": "deribit",
                "instrument_name": "BTC-31DEC26-95000-C",
                "underlying": "BTC",
                "kind": "option",
                "option_type": "call",
                "expiry_ts_ms": 1798675200000,
                "expiry_label": "31DEC26",
                "strike": "95000",
                "contract_size": "1",
                "tick_size": "0.0001",
                "quote_currency": "BTC",
                "settlement_currency": "BTC",
                "settlement_period": "month",
                "is_active": True,
                "is_combo": False,
                "raw_payload": {"instrument_name": "BTC-31DEC26-95000-C"},
            },
            {
                "instrument_name": "BTC-COMBO-BOX",
                "base_currency": "BTC",
                "kind": "combo",
                "contract_size": "1",
            },
        ],
    )

    snapshot = select_snapshot(load_snapshot_records(snapshots_path), snapshot_id="final")
    rows = enrich_snapshot_positions(snapshot, load_instruments_jsonl(instruments_path))

    assert [row.instrument_name for row in rows] == [
        "ETH-31DEC26-3000-C",
        "BTC-31DEC26-95000-C",
    ]
    assert rows[0].include_in_gex is False
    assert rows[1].include_in_gex is True
    assert rows[1].contract_multiplier == 1


def test_exporter_orders_csv_deterministically(tmp_path: Path) -> None:
    snapshot = {
        "snapshot_id": "final",
        "positions": {
            "BTC-31DEC26-100000-P": "-1",
            "BTC-31DEC26-95000-C": "3",
        },
    }
    instruments_path = tmp_path / "canonical_instruments.csv"
    with instruments_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "instrument_name",
                "base_currency",
                "kind",
                "option_type",
                "strike",
                "contract_size",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "instrument_name": "BTC-31DEC26-100000-P",
                "base_currency": "BTC",
                "kind": "option",
                "option_type": "put",
                "strike": "100000",
                "contract_size": "1",
            }
        )
        writer.writerow(
            {
                "instrument_name": "BTC-31DEC26-95000-C",
                "base_currency": "BTC",
                "kind": "option",
                "option_type": "call",
                "strike": "95000",
                "contract_size": "1",
            }
        )

    rows = enrich_snapshot_positions(snapshot, load_instruments_csv(instruments_path))
    output_a = tmp_path / "inventory_a.csv"
    output_b = tmp_path / "inventory_b.csv"
    write_inventory_csv(rows, output_a)
    write_inventory_csv(list(reversed(rows)), output_b)

    assert output_a.read_text(encoding="utf-8") == output_b.read_text(encoding="utf-8")
    lines = output_a.read_text(encoding="utf-8").splitlines()
    assert lines[1].startswith("BTC-31DEC26-95000-C")
    assert lines[2].startswith("BTC-31DEC26-100000-P")


def test_exporter_raises_for_missing_metadata(tmp_path: Path) -> None:
    snapshot = {
        "snapshot_id": "final",
        "positions": {"BTC-31DEC26-95000-C": "3"},
    }

    with pytest.raises(KeyError):
        enrich_snapshot_positions(snapshot, {})


def test_export_inventory_snapshot_cli(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    snapshots_path = tmp_path / "dealer_inventory_snapshots.jsonl"
    instruments_path = tmp_path / "canonical_instruments.jsonl"
    output_csv = tmp_path / "inventory.csv"

    _write_jsonl(
        snapshots_path,
        [
            {
                "snapshot_id": "genesis",
                "ts_ms": 0,
                "last_trade_seq": -1,
                "positions": {},
                "methodology_version": "phase3.test",
            },
            {
                "snapshot_id": "final",
                "ts_ms": 1700000003000,
                "last_trade_seq": 3,
                "positions": {
                    "BTC-31DEC26-100000-C": "2",
                    "BTC-31DEC26-100000-P": "-1",
                },
                "methodology_version": "phase3.test",
            },
        ],
    )
    _write_jsonl(
        instruments_path,
        [
            {
                "venue": "deribit",
                "instrument_name": "BTC-31DEC26-100000-C",
                "underlying": "BTC",
                "kind": "option",
                "option_type": "call",
                "expiry_ts_ms": 1798675200000,
                "expiry_label": "31DEC26",
                "strike": "100000",
                "contract_size": "1",
                "tick_size": "0.0001",
                "quote_currency": "BTC",
                "settlement_currency": "BTC",
                "settlement_period": "month",
                "is_active": True,
                "is_combo": False,
                "raw_payload": {"instrument_name": "BTC-31DEC26-100000-C"},
            },
            {
                "venue": "deribit",
                "instrument_name": "BTC-31DEC26-100000-P",
                "underlying": "BTC",
                "kind": "option",
                "option_type": "put",
                "expiry_ts_ms": 1798675200000,
                "expiry_label": "31DEC26",
                "strike": "100000",
                "contract_size": "1",
                "tick_size": "0.0001",
                "quote_currency": "BTC",
                "settlement_currency": "BTC",
                "settlement_period": "month",
                "is_active": True,
                "is_combo": False,
                "raw_payload": {"instrument_name": "BTC-31DEC26-100000-P"},
            },
        ],
    )

    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(repo_root) if not existing_pythonpath else f"{repo_root}{os.pathsep}{existing_pythonpath}"
    cmd = [
        sys.executable,
        str(repo_root / "scripts" / "export_inventory_snapshot.py"),
        "--snapshot-jsonl",
        str(snapshots_path),
        "--instruments-jsonl",
        str(instruments_path),
        "--output-csv",
        str(output_csv),
    ]
    subprocess.run(cmd, check=True, cwd=repo_root, env=env)

    with output_csv.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    assert rows == [
        {
            "instrument_name": "BTC-31DEC26-100000-C",
            "option_type": "call",
            "strike": "100000",
            "expiry_ts": "1798675200000",
            "net_contracts": "2",
            "contract_multiplier": "1",
            "include_in_gex": "true",
        },
        {
            "instrument_name": "BTC-31DEC26-100000-P",
            "option_type": "put",
            "strike": "100000",
            "expiry_ts": "1798675200000",
            "net_contracts": "-1",
            "contract_multiplier": "1",
            "include_in_gex": "true",
        },
    ]
