from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

import _bootstrap  # noqa: F401

from collector.config import Settings
from collector.deribit_client import DeribitPublicClient
from collector.phase1_sync import Phase1SyncService
from ledger.raw_store import RawStore
from pipeline.dashboard_snapshot import load_raw_phase1_records, materialize_dashboard_snapshot
from pipeline.validation import (
    collect_history_summary,
    compare_materializations,
    load_csv_file,
    load_json_file,
    load_jsonl_file,
    summarize_market_shape,
    validate_expiry_filtering,
    validate_position_chain,
    validate_raw_to_normalized,
    validate_snapshot_consistency,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run end-to-end validation for the Deribit BTC GEX pipeline."
    )
    parser.add_argument(
        "--db-path",
        default="project/data/phase1.sqlite3",
        help="Path to the Phase 1 SQLite database.",
    )
    parser.add_argument(
        "--artifacts-dir",
        default="project/runtime/validation_build",
        help="Directory for the primary validation materialization run.",
    )
    parser.add_argument(
        "--snapshot-path",
        default="project/runtime/validation_build/latest_gex_snapshot.json",
        help="Path for the primary validation snapshot JSON.",
    )
    parser.add_argument(
        "--greeks-json",
        default=None,
        help="Optional frozen greeks snapshot JSON. If omitted, live greeks are fetched once and then replayed deterministically.",
    )
    parser.add_argument(
        "--snapshot-id",
        default=None,
        help="Optional ledger snapshot_id to validate. Defaults to the latest Phase 3 snapshot.",
    )
    parser.add_argument(
        "--minimum-history-hours",
        type=float,
        default=24.0,
        help="Minimum raw trade history coverage required for the history audit to pass.",
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=20,
        help="Sample size for traceability examples.",
    )
    parser.add_argument(
        "--sample-seed",
        type=int,
        default=7,
        help="Deterministic seed for sampled traceability examples.",
    )
    parser.add_argument(
        "--validate-remote",
        action="store_true",
        help="Compare the local DB against live Deribit sample windows using the Phase 1 validator.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    artifacts_dir = Path(args.artifacts_dir)
    snapshot_path = Path(args.snapshot_path)

    first_run = materialize_dashboard_snapshot(
        db_path=args.db_path,
        artifacts_dir=artifacts_dir,
        snapshot_path=snapshot_path,
        greeks_json=args.greeks_json,
        snapshot_id=args.snapshot_id,
        fail_on_empty=False,
    )

    frozen_greeks = Path(args.greeks_json) if args.greeks_json else first_run.greeks_dir / "greeks_snapshot.json"
    with tempfile.TemporaryDirectory(prefix="lotus_validation_") as replay_dir:
        replay_root = Path(replay_dir)
        replay_artifacts_dir = replay_root / "artifacts"
        replay_snapshot_path = replay_root / "latest_gex_snapshot.json"
        materialize_dashboard_snapshot(
            db_path=args.db_path,
            artifacts_dir=replay_artifacts_dir,
            snapshot_path=replay_snapshot_path,
            greeks_json=frozen_greeks,
            snapshot_id=args.snapshot_id,
            fail_on_empty=False,
        )

        report = build_report(
            db_path=args.db_path,
            artifacts_dir=artifacts_dir,
            snapshot_path=snapshot_path,
            replay_artifacts_dir=replay_artifacts_dir,
            replay_snapshot_path=replay_snapshot_path,
            minimum_history_hours=args.minimum_history_hours,
            sample_size=args.sample_size,
            sample_seed=args.sample_seed,
            validate_remote=args.validate_remote,
        )

    report_path = artifacts_dir / "validation_report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))


def build_report(
    *,
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
    replay_artifacts_dir: str | Path,
    replay_snapshot_path: str | Path,
    minimum_history_hours: float,
    sample_size: int,
    sample_seed: int,
    validate_remote: bool,
) -> dict[str, object]:
    artifacts_root = Path(artifacts_dir)
    snapshot_payload = load_json_file(snapshot_path)
    raw_instruments, raw_trades = load_raw_phase1_records(db_path)
    normalized_trades = load_jsonl_file(artifacts_root / "normalized_trades_phase2.jsonl")
    phase3_events = load_jsonl_file(artifacts_root / "normalized_events_phase3.jsonl")
    position_deltas = load_jsonl_file(artifacts_root / "position_deltas.jsonl")
    gex_by_instrument = load_csv_file(artifacts_root / "gex" / "gex_by_instrument.csv")
    gex_by_strike = load_csv_file(artifacts_root / "gex" / "gex_by_strike.csv")

    history = collect_history_summary(
        db_path,
        minimum_history_hours=minimum_history_hours,
    )
    raw_to_normalized = validate_raw_to_normalized(
        raw_trades,
        normalized_trades,
        sample_size=sample_size,
        sample_seed=sample_seed,
    )
    position_chain = validate_position_chain(
        phase3_events,
        position_deltas,
        sample_size=sample_size,
        sample_seed=sample_seed,
    )
    snapshot_consistency = validate_snapshot_consistency(
        snapshot_payload,
        gex_by_instrument,
        gex_by_strike,
    )
    expiry_filtering = validate_expiry_filtering(snapshot_path)
    determinism = compare_materializations(
        artifacts_root,
        snapshot_path,
        replay_artifacts_dir,
        replay_snapshot_path,
    )
    remote_validation = (
        run_remote_validation(db_path)
        if validate_remote
        else {"passed": None, "skipped": True, "reason": "remote validation disabled"}
    )
    market_shape = summarize_market_shape(snapshot_payload)

    checks = {
        "history": history,
        "raw_to_normalized": raw_to_normalized,
        "position_chain": position_chain,
        "snapshot_consistency": snapshot_consistency,
        "expiry_filtering": expiry_filtering,
        "determinism": determinism,
        "remote_validation": remote_validation,
    }

    hard_failures = [
        name
        for name, result in checks.items()
        if result.get("passed") is False
    ]

    return {
        "passed": not hard_failures,
        "hard_failures": hard_failures,
        "db_path": str(db_path),
        "artifacts_dir": str(artifacts_dir),
        "snapshot_path": str(snapshot_path),
        "report_generated_at_utc": snapshot_payload["as_of"],
        "checks": checks,
        "counts": {
            "raw_instrument_count": len(raw_instruments),
            "raw_trade_count": len(raw_trades),
            "phase2_trade_count": len(normalized_trades),
            "phase3_event_count": len(phase3_events),
            "position_delta_count": len(position_deltas),
            "snapshot_row_count": len(snapshot_payload["rows"]),
            "gex_instrument_count": len(gex_by_instrument),
            "gex_strike_count": len(gex_by_strike),
        },
        "market_shape": market_shape,
    }


def run_remote_validation(db_path: str | Path) -> dict[str, object]:
    settings = Settings.from_env().with_overrides(db_path=Path(db_path))
    store = RawStore(settings.db_path)

    try:
        history = collect_history_summary(settings.db_path, minimum_history_hours=0.0)
        start_ms = history["window_start_ms"]
        end_ms = history["window_end_ms"]
        if start_ms is None or end_ms is None or end_ms <= start_ms:
            return {
                "passed": False,
                "skipped": True,
                "reason": "raw_trades window is empty",
            }

        with DeribitPublicClient(
            settings.deribit_base_url,
            settings.request_timeout_s,
            settings.max_retries,
            settings.retry_backoff_s,
        ) as client:
            service = Phase1SyncService(client, store, settings)
            rows = service.validate_sample_windows(int(start_ms), int(end_ms))

        payload = [
            {
                "window_start_ms": row.window_start_ms,
                "window_end_ms": row.window_end_ms,
                "local_count": row.local_count,
                "remote_count": row.remote_count,
                "missing_count": row.missing_count,
                "extra_count": row.extra_count,
            }
            for row in rows
        ]
        passed = all(row["missing_count"] == 0 and row["extra_count"] == 0 for row in payload)
        return {
            "passed": passed,
            "skipped": False,
            "sample_windows": payload,
        }
    finally:
        store.close()


if __name__ == "__main__":
    main()
