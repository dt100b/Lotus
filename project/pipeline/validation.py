from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from decimal import Decimal
import csv
import hashlib
import json
import math
import random
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from api.repository import SnapshotRepository
from api.schemas import GexProfileResponse
from ledger.models import NormalizedTradeEvent
from ledger.replay import DUST
from ledger.rules import LedgerPolicy, classify_event, dealer_position_delta


def collect_history_summary(
    db_path: str | Path,
    *,
    minimum_history_hours: float,
) -> dict[str, Any]:
    database_path = Path(db_path)
    with sqlite3.connect(database_path) as conn:
        raw_trade_count = _fetch_count(conn, "raw_trades")
        raw_instrument_count = _fetch_count(conn, "raw_instruments")
        ingest_run_count = _fetch_count(conn, "ingest_runs")
        backfill_job_count = _fetch_count(conn, "backfill_jobs")
        backfill_cursor_count = _fetch_count(conn, "backfill_cursors")
        duplicate_trade_groups = conn.execute(
            """
            SELECT COUNT(*)
            FROM (
              SELECT instrument_name, trade_id
              FROM raw_trades
              GROUP BY instrument_name, trade_id
              HAVING COUNT(*) > 1
            )
            """
        ).fetchone()[0]

        min_ts, max_ts = conn.execute(
            "SELECT MIN(timestamp_ms), MAX(timestamp_ms) FROM raw_trades"
        ).fetchone()
        latest_job = conn.execute(
            """
            SELECT job_name, window_start_ms, window_end_ms, status
            FROM backfill_jobs
            ORDER BY updated_at_ms DESC
            LIMIT 1
            """
        ).fetchone()

    coverage_hours = 0.0
    if min_ts is not None and max_ts is not None:
        coverage_hours = max((int(max_ts) - int(min_ts)) / 3_600_000, 0.0)

    passed = (
        raw_trade_count > 0
        and duplicate_trade_groups == 0
        and coverage_hours >= minimum_history_hours
    )

    return {
        "passed": passed,
        "minimum_history_hours": minimum_history_hours,
        "raw_trade_count": raw_trade_count,
        "raw_instrument_count": raw_instrument_count,
        "ingest_run_count": ingest_run_count,
        "backfill_job_count": backfill_job_count,
        "backfill_cursor_count": backfill_cursor_count,
        "duplicate_trade_groups": duplicate_trade_groups,
        "coverage_hours": round(coverage_hours, 6),
        "window_start_ms": min_ts,
        "window_end_ms": max_ts,
        "window_start_utc": _isoformat_millis(min_ts),
        "window_end_utc": _isoformat_millis(max_ts),
        "latest_backfill_job": (
            {
                "job_name": str(latest_job[0]),
                "window_start_ms": int(latest_job[1]),
                "window_end_ms": int(latest_job[2]),
                "status": str(latest_job[3]),
                "window_start_utc": _isoformat_millis(int(latest_job[1])),
                "window_end_utc": _isoformat_millis(int(latest_job[2])),
            }
            if latest_job is not None
            else None
        ),
    }


def validate_raw_to_normalized(
    raw_trades: Iterable[dict[str, Any]],
    normalized_trades: Iterable[dict[str, Any]],
    *,
    sample_size: int,
    sample_seed: int,
) -> dict[str, Any]:
    raw_by_key = {
        _trade_key(row): row
        for row in raw_trades
    }
    normalized_rows = list(normalized_trades)
    normalized_by_key = {
        _trade_key(row): row
        for row in normalized_rows
    }

    missing_from_normalized = sorted(raw_by_key.keys() - normalized_by_key.keys())
    extra_normalized = sorted(normalized_by_key.keys() - raw_by_key.keys())
    hash_mismatches: list[dict[str, Any]] = []
    taker_side_mismatches: list[dict[str, Any]] = []

    for key, normalized in normalized_by_key.items():
        raw = raw_by_key.get(key)
        if raw is None:
            continue

        expected_hash = _stable_payload_hash(raw)
        actual_hash = str(normalized.get("raw_payload_sha256"))
        if expected_hash != actual_hash and len(hash_mismatches) < 5:
            hash_mismatches.append(
                {
                    "instrument_name": key[0],
                    "trade_id": key[1],
                    "expected_raw_payload_sha256": expected_hash,
                    "actual_raw_payload_sha256": actual_hash,
                }
            )

        expected_taker_side = str(raw.get("direction") or raw.get("side") or "").strip().lower()
        actual_taker_side = str(normalized.get("taker_side") or "").strip().lower()
        if expected_taker_side != actual_taker_side and len(taker_side_mismatches) < 5:
            taker_side_mismatches.append(
                {
                    "instrument_name": key[0],
                    "trade_id": key[1],
                    "expected_taker_side": expected_taker_side,
                    "actual_taker_side": actual_taker_side,
                }
            )

    sample_examples = []
    sample_keys = _sample_keys(sorted(normalized_by_key.keys()), sample_size, sample_seed)
    for key in sample_keys:
        raw = raw_by_key[key]
        normalized = normalized_by_key[key]
        sample_examples.append(
            {
                "instrument_name": key[0],
                "trade_id": key[1],
                "timestamp_ms": int(raw["timestamp"]),
                "taker_side": str(normalized["taker_side"]),
                "amount": str(normalized["amount"]),
                "option_type": normalized.get("option_type"),
            }
        )

    passed = (
        not missing_from_normalized
        and not extra_normalized
        and not hash_mismatches
        and not taker_side_mismatches
    )

    return {
        "passed": passed,
        "raw_trade_count": len(raw_by_key),
        "normalized_trade_count": len(normalized_rows),
        "missing_from_normalized_count": len(missing_from_normalized),
        "extra_normalized_count": len(extra_normalized),
        "hash_mismatch_count": len(hash_mismatches),
        "taker_side_mismatch_count": len(taker_side_mismatches),
        "missing_from_normalized_examples": _format_trade_keys(missing_from_normalized[:5]),
        "extra_normalized_examples": _format_trade_keys(extra_normalized[:5]),
        "hash_mismatch_examples": hash_mismatches,
        "taker_side_mismatch_examples": taker_side_mismatches,
        "sample_examples": sample_examples,
    }


def validate_position_chain(
    phase3_events: Iterable[dict[str, Any]],
    position_deltas: Iterable[dict[str, Any]],
    *,
    sample_size: int,
    sample_seed: int,
) -> dict[str, Any]:
    ordered_events = sorted(
        [NormalizedTradeEvent.from_dict(row) for row in phase3_events],
        key=lambda row: (row.trade_seq, row.ts_ms, row.event_id),
    )
    delta_rows = list(position_deltas)
    event_by_id = {event.event_id: event for event in ordered_events}
    positions: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    policy = LedgerPolicy()

    sign_violations: list[dict[str, Any]] = []
    chain_violations: list[dict[str, Any]] = []
    missing_deltas: list[str] = []

    if len(ordered_events) != len(delta_rows):
        expected_count = len(ordered_events)
    else:
        expected_count = len(delta_rows)

    for delta_row in delta_rows:
        event_id = str(delta_row["event_id"])
        event = event_by_id.get(event_id)
        if event is None:
            if len(missing_deltas) < 5:
                missing_deltas.append(event_id)
            continue

        applied_expected, exclusion_reason = classify_event(event, policy)
        current = positions.get(event.inventory_key, Decimal("0"))
        expected_delta = dealer_position_delta(event) if applied_expected else Decimal("0")
        expected_after = current + expected_delta
        if abs(expected_after) <= DUST:
            expected_after = Decimal("0")
        actual_delta = Decimal(str(delta_row["dealer_position_delta"]))
        actual_after = Decimal(str(delta_row["dealer_position_after"]))
        actual_applied = bool(delta_row["applied"])
        actual_exclusion = delta_row.get("exclusion_reason")

        if actual_delta != expected_delta and len(sign_violations) < 5:
            sign_violations.append(
                {
                    "event_id": event_id,
                    "instrument_name": event.instrument_name,
                    "taker_side": event.taker_side,
                    "expected_delta": str(expected_delta),
                    "actual_delta": str(actual_delta),
                }
            )

        if (
            actual_after != expected_after
            or actual_applied != applied_expected
            or actual_exclusion != exclusion_reason
        ) and len(chain_violations) < 5:
            chain_violations.append(
                {
                    "event_id": event_id,
                    "instrument_name": event.instrument_name,
                    "expected_after": str(expected_after),
                    "actual_after": str(actual_after),
                    "expected_applied": applied_expected,
                    "actual_applied": actual_applied,
                    "expected_exclusion_reason": exclusion_reason,
                    "actual_exclusion_reason": actual_exclusion,
                }
            )

        if applied_expected:
            if abs(expected_after) <= DUST:
                positions.pop(event.inventory_key, None)
            else:
                positions[event.inventory_key] = expected_after

    sample_examples = []
    sample_event_ids = _sample_keys([event.event_id for event in ordered_events], sample_size, sample_seed)
    delta_by_event_id = {str(row["event_id"]): row for row in delta_rows}
    for event_id in sample_event_ids:
        event = event_by_id[event_id]
        delta_row = delta_by_event_id.get(event_id)
        if delta_row is None:
            continue
        sample_examples.append(
            {
                "event_id": event_id,
                "instrument_name": event.instrument_name,
                "option_type": event.option_type,
                "taker_side": event.taker_side,
                "amount": str(event.amount),
                "dealer_position_delta": str(delta_row["dealer_position_delta"]),
                "dealer_position_after": str(delta_row["dealer_position_after"]),
            }
        )

    passed = (
        len(ordered_events) == len(delta_rows)
        and not missing_deltas
        and not sign_violations
        and not chain_violations
    )

    return {
        "passed": passed,
        "phase3_event_count": len(ordered_events),
        "position_delta_count": len(delta_rows),
        "missing_delta_count": max(len(ordered_events) - len(delta_rows), 0),
        "missing_delta_examples": missing_deltas,
        "sign_violation_count": len(sign_violations),
        "chain_violation_count": len(chain_violations),
        "sign_violation_examples": sign_violations,
        "chain_violation_examples": chain_violations,
        "sample_examples": sample_examples,
        "expected_count": expected_count,
    }


def validate_snapshot_consistency(
    snapshot_payload: dict[str, Any],
    gex_instrument_rows: Iterable[dict[str, Any]],
    gex_by_strike_rows: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    row_violations: list[dict[str, Any]] = []
    for row in snapshot_payload["rows"]:
        call_gex = float(row["call_gex"])
        put_gex = float(row["put_gex"])
        net_gex = float(row["net_gex"])
        if not math.isclose(net_gex, call_gex + put_gex, rel_tol=1e-9, abs_tol=1e-9):
            if len(row_violations) < 5:
                row_violations.append(dict(row))

    aggregated_from_instruments: dict[tuple[str, float], dict[str, float]] = defaultdict(
        lambda: {"call_gex": 0.0, "put_gex": 0.0}
    )
    strike_totals_from_instruments: dict[float, dict[str, float]] = defaultdict(
        lambda: {"call_gex": 0.0, "put_gex": 0.0}
    )

    for row in gex_instrument_rows:
        expiry = _iso_date_from_ms(int(row["expiry_ts"]))
        strike = float(row["strike"])
        option_type = str(row["option_type"])
        value = float(row["dollar_gamma_per_1pct"])
        aggregated_from_instruments[(expiry, strike)][option_type + "_gex"] += value
        strike_totals_from_instruments[strike][option_type + "_gex"] += value

    snapshot_examples: list[dict[str, Any]] = []
    for row in snapshot_payload["rows"]:
        expiry = str(row["expiry"])
        strike = float(row["strike"])
        expected = aggregated_from_instruments[(expiry, strike)]
        if not _row_matches_totals(row, expected):
            if len(snapshot_examples) < 5:
                snapshot_examples.append(
                    {
                        "expiry": expiry,
                        "strike": strike,
                        "snapshot": {
                            "call_gex": float(row["call_gex"]),
                            "put_gex": float(row["put_gex"]),
                            "net_gex": float(row["net_gex"]),
                        },
                        "from_instruments": {
                            "call_gex": expected["call_gex"],
                            "put_gex": expected["put_gex"],
                            "net_gex": expected["call_gex"] + expected["put_gex"],
                        },
                    }
                )

    strike_examples: list[dict[str, Any]] = []
    for row in gex_by_strike_rows:
        strike = float(row["strike"])
        expected = strike_totals_from_instruments[strike]
        if not _row_matches_totals(row, expected):
            if len(strike_examples) < 5:
                strike_examples.append(
                    {
                        "strike": strike,
                        "snapshot": {
                            "call_gex": float(row["call_gex"]),
                            "put_gex": float(row["put_gex"]),
                            "net_gex": float(row["net_gex"]),
                        },
                        "from_instruments": {
                            "call_gex": expected["call_gex"],
                            "put_gex": expected["put_gex"],
                            "net_gex": expected["call_gex"] + expected["put_gex"],
                        },
                    }
                )

    passed = not row_violations and not snapshot_examples and not strike_examples
    return {
        "passed": passed,
        "snapshot_row_count": len(snapshot_payload["rows"]),
        "row_violation_count": len(row_violations),
        "snapshot_vs_instrument_violation_count": len(snapshot_examples),
        "strike_vs_instrument_violation_count": len(strike_examples),
        "row_violation_examples": row_violations,
        "snapshot_vs_instrument_examples": snapshot_examples,
        "strike_vs_instrument_examples": strike_examples,
    }


def validate_expiry_filtering(snapshot_path: str | Path) -> dict[str, Any]:
    repository = SnapshotRepository(Path(snapshot_path))
    expiries = repository.list_expiries().expiries
    all_profile = repository.get_profile("ALL", "net")
    aggregated_points = _aggregate_profiles_by_strike(
        repository.get_profile(expiry, "net") for expiry in expiries
    )

    mismatches: list[dict[str, Any]] = []
    all_points = {float(point.strike): point.net_gex for point in all_profile.points}
    for strike in sorted(set(all_points) | set(aggregated_points)):
        total = aggregated_points.get(strike, 0.0)
        whole = all_points.get(strike, 0.0)
        if not math.isclose(whole, total, rel_tol=1e-9, abs_tol=1e-9):
            if len(mismatches) < 5:
                mismatches.append(
                    {
                        "strike": strike,
                        "all_net_gex": whole,
                        "summed_expiry_net_gex": total,
                    }
                )

    return {
        "passed": not mismatches,
        "expiry_count": len(expiries),
        "all_point_count": len(all_profile.points),
        "mismatch_count": len(mismatches),
        "mismatch_examples": mismatches,
    }


def compare_materializations(
    first_dir: str | Path,
    first_snapshot_path: str | Path,
    second_dir: str | Path,
    second_snapshot_path: str | Path,
) -> dict[str, Any]:
    tracked_files = {
        "normalized_events_phase3": ("normalized_events_phase3.jsonl", "normalized_events_phase3.jsonl"),
        "position_deltas": ("position_deltas.jsonl", "position_deltas.jsonl"),
        "dealer_inventory_snapshots": ("dealer_inventory_snapshots.jsonl", "dealer_inventory_snapshots.jsonl"),
        "ledger_manifest": ("ledger_manifest.json", "ledger_manifest.json"),
        "inventory_snapshot": ("inventory_snapshot.csv", "inventory_snapshot.csv"),
        "gex_by_instrument": ("gex/gex_by_instrument.csv", "gex/gex_by_instrument.csv"),
        "gex_by_strike": ("gex/gex_by_strike.csv", "gex/gex_by_strike.csv"),
        "gex_by_expiry": ("gex/gex_by_expiry.csv", "gex/gex_by_expiry.csv"),
        "gex_summary": ("gex/gex_summary.json", "gex/gex_summary.json"),
    }

    comparisons = {}
    mismatches = []
    first_root = Path(first_dir)
    second_root = Path(second_dir)
    for name, (left_rel, right_rel) in tracked_files.items():
        left_path = first_root / left_rel if not Path(left_rel).is_absolute() else Path(left_rel)
        right_path = second_root / right_rel if not Path(right_rel).is_absolute() else Path(right_rel)
        same = _sha256_file(left_path) == _sha256_file(right_path)
        comparisons[name] = {
            "left": str(left_path),
            "right": str(right_path),
            "same_sha256": same,
        }
        if not same:
            mismatches.append(name)

    phase5_left = Path(first_snapshot_path)
    phase5_right = Path(second_snapshot_path)
    phase5_same = _sha256_file(phase5_left) == _sha256_file(phase5_right)
    comparisons["phase5_snapshot"] = {
        "left": str(phase5_left),
        "right": str(phase5_right),
        "same_sha256": phase5_same,
    }
    if not phase5_same:
        mismatches.append("phase5_snapshot")

    return {
        "passed": not mismatches,
        "mismatch_count": len(mismatches),
        "mismatched_artifacts": mismatches,
        "artifacts": comparisons,
    }


def summarize_market_shape(snapshot_payload: dict[str, Any], *, limit: int = 10) -> dict[str, Any]:
    rows = list(snapshot_payload["rows"])
    top_abs_rows = sorted(
        rows,
        key=lambda row: abs(float(row["net_gex"])),
        reverse=True,
    )[:limit]

    expiry_totals: dict[str, float] = defaultdict(float)
    sign_flips_by_expiry: dict[str, int] = defaultdict(int)
    rows_by_expiry: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        expiry = str(row["expiry"])
        expiry_totals[expiry] += float(row["net_gex"])
        rows_by_expiry[expiry].append(row)

    for expiry, expiry_rows in rows_by_expiry.items():
        previous_sign = 0
        for row in sorted(expiry_rows, key=lambda item: float(item["strike"])):
            current_sign = _signed_bucket(float(row["net_gex"]))
            if current_sign == 0:
                continue
            if previous_sign != 0 and current_sign != previous_sign:
                sign_flips_by_expiry[expiry] += 1
            previous_sign = current_sign

    return {
        "top_absolute_net_gex_rows": top_abs_rows,
        "expiry_net_gex_totals": [
            {"expiry": expiry, "net_gex": total}
            for expiry, total in sorted(expiry_totals.items(), key=lambda item: item[0])
        ],
        "sign_flips_by_expiry": [
            {"expiry": expiry, "sign_flip_count": sign_flips_by_expiry.get(expiry, 0)}
            for expiry in sorted(rows_by_expiry)
        ],
    }


def load_json_file(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_jsonl_file(path: str | Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_csv_file(path: str | Path) -> list[dict[str, str]]:
    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader)


def _aggregate_profiles_by_strike(profiles: Iterable[GexProfileResponse]) -> dict[float, float]:
    totals: dict[float, float] = defaultdict(float)
    for profile in profiles:
        for point in profile.points:
            totals[float(point.strike)] += float(point.net_gex)
    return totals


def _fetch_count(conn: sqlite3.Connection, table_name: str) -> int:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    if row is None:
        return 0
    return int(conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0])


def _format_trade_keys(keys: Iterable[tuple[str, str]]) -> list[dict[str, str]]:
    return [
        {"instrument_name": instrument_name, "trade_id": trade_id}
        for instrument_name, trade_id in keys
    ]


def _isoformat_millis(timestamp_ms: int | None) -> str | None:
    if timestamp_ms is None:
        return None
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC).isoformat().replace("+00:00", "Z")


def _iso_date_from_ms(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC).date().isoformat()


def _row_matches_totals(row: dict[str, Any], expected: dict[str, float]) -> bool:
    call_gex = float(row["call_gex"])
    put_gex = float(row["put_gex"])
    net_gex = float(row["net_gex"])
    return (
        math.isclose(call_gex, expected["call_gex"], rel_tol=1e-9, abs_tol=1e-9)
        and math.isclose(put_gex, expected["put_gex"], rel_tol=1e-9, abs_tol=1e-9)
        and math.isclose(net_gex, expected["call_gex"] + expected["put_gex"], rel_tol=1e-9, abs_tol=1e-9)
    )


def _sample_keys(items: list[Any], sample_size: int, sample_seed: int) -> list[Any]:
    if sample_size <= 0 or not items:
        return []
    if len(items) <= sample_size:
        return list(items)
    generator = random.Random(sample_seed)
    return sorted(generator.sample(items, sample_size))


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _signed_bucket(value: float, *, epsilon: float = 1e-9) -> int:
    if value > epsilon:
        return 1
    if value < -epsilon:
        return -1
    return 0


def _stable_payload_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _trade_key(row: dict[str, Any]) -> tuple[str, str]:
    return (str(row["instrument_name"]), str(row["trade_id"]))
