from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_records_hash(path: Path) -> str:
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            records.append(json.loads(line))
    payload = "\n".join(
        json.dumps(record, sort_keys=True, separators=(",", ":")) for record in records
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def run_cli(repo_root: Path, fixture: Path, output_dir: Path) -> None:
    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH")
    env["PYTHONPATH"] = (
        str(repo_root)
        if not existing_pythonpath
        else f"{repo_root}{os.pathsep}{existing_pythonpath}"
    )
    cmd = [
        sys.executable,
        str(repo_root / "scripts" / "build_ledger.py"),
        "--input",
        str(fixture),
        "--output-dir",
        str(output_dir),
        "--snapshot-every",
        "1",
        "--methodology-version",
        "phase3.test.cli",
    ]
    subprocess.run(cmd, check=True, cwd=repo_root, env=env)


def test_build_ledger_cli(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    fixture = repo_root / "tests" / "fixtures" / "normalized_events_small.jsonl"

    output_dir_a = tmp_path / "ledger_out_a"
    output_dir_b = tmp_path / "ledger_out_b"
    run_cli(repo_root=repo_root, fixture=fixture, output_dir=output_dir_a)
    run_cli(repo_root=repo_root, fixture=fixture, output_dir=output_dir_b)

    position_deltas_a = output_dir_a / "position_deltas.jsonl"
    snapshots_a = output_dir_a / "dealer_inventory_snapshots.jsonl"
    manifest_path_a = output_dir_a / "ledger_manifest.json"

    position_deltas_b = output_dir_b / "position_deltas.jsonl"
    snapshots_b = output_dir_b / "dealer_inventory_snapshots.jsonl"
    manifest_path_b = output_dir_b / "ledger_manifest.json"

    assert position_deltas_a.exists()
    assert snapshots_a.exists()
    assert manifest_path_a.exists()

    manifest = json.loads(manifest_path_a.read_text(encoding="utf-8"))

    assert manifest["methodology_version"] == "phase3.test.cli"
    assert manifest["input_event_count"] == 3
    assert manifest["applied_event_count"] == 2
    assert manifest["excluded_event_count"] == 1
    assert manifest["final_trade_seq"] == 3

    assert manifest["position_deltas_sha256"] == canonical_records_hash(position_deltas_a)
    assert manifest["snapshots_sha256"] == canonical_records_hash(snapshots_a)

    assert sha256_file(position_deltas_a) == sha256_file(position_deltas_b)
    assert sha256_file(snapshots_a) == sha256_file(snapshots_b)
    assert sha256_file(manifest_path_a) == sha256_file(manifest_path_b)

    lines = position_deltas_a.read_text(encoding="utf-8").strip().splitlines()
    first = json.loads(lines[0])
    second = json.loads(lines[1])
    third = json.loads(lines[2])

    assert first["trade_seq"] == 1
    assert first["dealer_position_delta"] == "-2"
    assert first["dealer_position_after"] == "-2"
    assert first["applied"] is True

    assert second["trade_seq"] == 2
    assert second["dealer_position_delta"] == "1"
    assert second["dealer_position_after"] == "-1"
    assert second["applied"] is True

    assert third["trade_seq"] == 3
    assert third["dealer_position_delta"] == "0"
    assert third["dealer_position_after"] == "0"
    assert third["applied"] is False
    assert third["exclusion_reason"] == "block_trade"

    snapshot_lines = snapshots_a.read_text(encoding="utf-8").strip().splitlines()
    final_snapshot = json.loads(snapshot_lines[-1])
    assert final_snapshot["positions"]["BTC-26APR26-90000-C"] == "-1"
