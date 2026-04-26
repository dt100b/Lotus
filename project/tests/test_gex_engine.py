from __future__ import annotations

import csv
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from greeks.gex_engine import compute_gex_profile, write_profile_artifacts
from greeks.providers import load_greeks_snapshot_json, write_greeks_snapshot_json
from greeks.types import DealerInventoryRow, GreekSnapshot


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_compute_gex_profile_aggregates_by_strike_and_expiry() -> None:
    inventory_rows = [
        DealerInventoryRow(
            instrument_name="BTC-31DEC26-100000-C",
            option_type="call",
            strike=100000.0,
            expiry_ts=1798675200000,
            net_contracts=2.0,
            contract_multiplier=1.0,
            include_in_gex=True,
        ),
        DealerInventoryRow(
            instrument_name="BTC-31DEC26-100000-P",
            option_type="put",
            strike=100000.0,
            expiry_ts=1798675200000,
            net_contracts=-1.0,
            contract_multiplier=1.0,
            include_in_gex=True,
        ),
    ]
    greeks = {
        "BTC-31DEC26-100000-C": GreekSnapshot(
            instrument_name="BTC-31DEC26-100000-C",
            gamma=0.0002,
            spot_price=100000.0,
            snapshot_ts=1,
        ),
        "BTC-31DEC26-100000-P": GreekSnapshot(
            instrument_name="BTC-31DEC26-100000-P",
            gamma=0.00015,
            spot_price=100000.0,
            snapshot_ts=1,
        ),
    }

    profile = compute_gex_profile(
        inventory_rows=inventory_rows,
        greeks_by_instrument=greeks,
        methodology_version="phase4-test",
        as_of_ts=1,
    )

    assert len(profile.instrument_rows) == 2
    assert len(profile.by_strike) == 1
    assert len(profile.by_expiry) == 1

    strike_row = profile.by_strike[0]
    assert strike_row.call_gex == pytest.approx(40000.0)
    assert strike_row.put_gex == pytest.approx(-15000.0)
    assert strike_row.net_gex == pytest.approx(25000.0)
    assert strike_row.gross_gex == pytest.approx(55000.0)

    expiry_row = profile.by_expiry[0]
    assert expiry_row.net_gex == pytest.approx(25000.0)
    assert profile.to_summary()["total_net_gex"] == pytest.approx(25000.0)


def test_missing_greeks_are_reported_and_skipped() -> None:
    inventory_rows = [
        DealerInventoryRow(
            instrument_name="BTC-31DEC26-120000-C",
            option_type="call",
            strike=120000.0,
            expiry_ts=1798675200000,
            net_contracts=1.0,
            contract_multiplier=1.0,
            include_in_gex=True,
        )
    ]

    profile = compute_gex_profile(
        inventory_rows=inventory_rows,
        greeks_by_instrument={},
        methodology_version="phase4-test",
        as_of_ts=1,
    )

    assert len(profile.instrument_rows) == 0
    assert profile.missing_greeks == ("BTC-31DEC26-120000-C",)


def test_rows_marked_out_of_scope_do_not_contribute() -> None:
    inventory_rows = [
        DealerInventoryRow(
            instrument_name="BTC-31DEC26-90000-C",
            option_type="call",
            strike=90000.0,
            expiry_ts=1798675200000,
            net_contracts=10.0,
            contract_multiplier=1.0,
            include_in_gex=False,
        )
    ]
    greeks = {
        "BTC-31DEC26-90000-C": GreekSnapshot(
            instrument_name="BTC-31DEC26-90000-C",
            gamma=0.0003,
            spot_price=100000.0,
            snapshot_ts=1,
        )
    }

    profile = compute_gex_profile(
        inventory_rows=inventory_rows,
        greeks_by_instrument=greeks,
        methodology_version="phase4-test",
        as_of_ts=1,
    )

    assert len(profile.instrument_rows) == 0
    assert len(profile.by_strike) == 0
    assert len(profile.by_expiry) == 0


def test_same_inputs_produce_identical_profile_and_artifacts(tmp_path: Path) -> None:
    inventory_rows_a = [
        DealerInventoryRow(
            instrument_name="BTC-31DEC26-100000-P",
            option_type="put",
            strike=100000.0,
            expiry_ts=1798675200000,
            net_contracts=-1.0,
            contract_multiplier=1.0,
        ),
        DealerInventoryRow(
            instrument_name="BTC-31DEC26-95000-C",
            option_type="call",
            strike=95000.0,
            expiry_ts=1798675200000,
            net_contracts=3.0,
            contract_multiplier=1.0,
        ),
    ]
    inventory_rows_b = list(reversed(inventory_rows_a))
    greeks_a = {
        "BTC-31DEC26-95000-C": GreekSnapshot(
            instrument_name="BTC-31DEC26-95000-C",
            gamma=0.0001,
            spot_price=100000.0,
            snapshot_ts=123,
        ),
        "BTC-31DEC26-100000-P": GreekSnapshot(
            instrument_name="BTC-31DEC26-100000-P",
            gamma=0.00015,
            spot_price=100000.0,
            snapshot_ts=123,
        ),
    }
    greeks_b = dict(reversed(list(greeks_a.items())))

    profile_a = compute_gex_profile(
        inventory_rows=inventory_rows_a,
        greeks_by_instrument=greeks_a,
        methodology_version="phase4-test",
    )
    profile_b = compute_gex_profile(
        inventory_rows=inventory_rows_b,
        greeks_by_instrument=greeks_b,
        methodology_version="phase4-test",
    )

    assert profile_a == profile_b

    output_a = tmp_path / "out_a"
    output_b = tmp_path / "out_b"
    write_profile_artifacts(profile_a, output_a)
    write_profile_artifacts(profile_b, output_b)

    assert sha256_file(output_a / "gex_by_instrument.csv") == sha256_file(output_b / "gex_by_instrument.csv")
    assert sha256_file(output_a / "gex_by_strike.csv") == sha256_file(output_b / "gex_by_strike.csv")
    assert sha256_file(output_a / "gex_by_expiry.csv") == sha256_file(output_b / "gex_by_expiry.csv")
    assert sha256_file(output_a / "gex_summary.json") == sha256_file(output_b / "gex_summary.json")


def test_greeks_snapshot_round_trip_and_cli_replay_are_deterministic(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    inventory_csv = tmp_path / "inventory.csv"
    greeks_json = tmp_path / "greeks_snapshot.json"
    output_dir_a = tmp_path / "gex_out_a"
    output_dir_b = tmp_path / "gex_out_b"

    with inventory_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "instrument_name",
                "option_type",
                "strike",
                "expiry_ts",
                "net_contracts",
                "contract_multiplier",
                "include_in_gex",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "instrument_name": "BTC-31DEC26-100000-C",
                "option_type": "call",
                "strike": "100000",
                "expiry_ts": "1798675200000",
                "net_contracts": "2",
                "contract_multiplier": "1",
                "include_in_gex": "true",
            }
        )
        writer.writerow(
            {
                "instrument_name": "BTC-31DEC26-100000-P",
                "option_type": "put",
                "strike": "100000",
                "expiry_ts": "1798675200000",
                "net_contracts": "-1",
                "contract_multiplier": "1",
                "include_in_gex": "true",
            }
        )

    snapshots = {
        "BTC-31DEC26-100000-C": GreekSnapshot(
            instrument_name="BTC-31DEC26-100000-C",
            gamma=0.0002,
            spot_price=100000.0,
            snapshot_ts=456,
        ),
        "BTC-31DEC26-100000-P": GreekSnapshot(
            instrument_name="BTC-31DEC26-100000-P",
            gamma=0.00015,
            spot_price=100000.0,
            snapshot_ts=456,
        ),
    }
    write_greeks_snapshot_json(snapshots, greeks_json)
    loaded = load_greeks_snapshot_json(greeks_json)
    assert loaded == snapshots

    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(repo_root) if not existing_pythonpath else f"{repo_root}{os.pathsep}{existing_pythonpath}"

    cmd = [
        sys.executable,
        str(repo_root / "scripts" / "build_gex_profile.py"),
        "--inventory-csv",
        str(inventory_csv),
        "--output-dir",
        str(output_dir_a),
        "--greeks-json",
        str(greeks_json),
        "--methodology-version",
        "phase4.test.cli",
    ]
    subprocess.run(cmd, check=True, cwd=repo_root, env=env)

    cmd[5] = str(output_dir_b)
    subprocess.run(cmd, check=True, cwd=repo_root, env=env)

    for name in ("gex_by_instrument.csv", "gex_by_strike.csv", "gex_by_expiry.csv", "gex_summary.json"):
        assert sha256_file(output_dir_a / name) == sha256_file(output_dir_b / name)

    summary = json.loads((output_dir_a / "gex_summary.json").read_text(encoding="utf-8"))
    assert summary["methodology_version"] == "phase4.test.cli"
    assert summary["missing_greeks_count"] == 0
    assert summary["total_net_gex"] == pytest.approx(25000.0)
