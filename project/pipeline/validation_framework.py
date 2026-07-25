"""Expert validation framework diagnostics (Tier 1 + Tier 2).

Produces structured metrics for the backend architecture validation report.
Designed to be disk-safe: prefers SQL aggregates and strike-filtered replay
over multi-GB intermediate JSONL dumps.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal
import csv
import hashlib
import json
import math
import sqlite3
import statistics
import time
from pathlib import Path
from typing import Any, Iterable

import httpx

from greeks.providers import load_greeks_snapshot_json
from ledger.models import NormalizedTradeEvent as LedgerEvent
from ledger.models import to_decimal
from ledger.replay import DUST
from ledger.rules import LedgerPolicy, classify_event, dealer_position_delta
from normalizer.service import normalize_trade_batch
from pipeline.dashboard_snapshot import build_phase3_events, materialize_dashboard_snapshot
from pipeline.inventory_checkpoint import (
    DEFAULT_CHECKPOINT_LAG_WARN_THRESHOLD,
    evaluate_checkpoint_lag,
    load_checkpoint,
    measure_checkpoint_inventory_lag,
    positions_sha256,
)
from pipeline.validation import collect_history_summary


MS_DAY = 86_400_000
MS_HOUR = 3_600_000


def _iso_ms(ts_ms: int | None) -> str | None:
    if ts_ms is None:
        return None
    return datetime.fromtimestamp(ts_ms / 1000, tz=UTC).isoformat().replace("+00:00", "Z")


def _day_key(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=UTC).date().isoformat()


def _hour_key(ts_ms: int) -> str:
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=UTC)
    return dt.strftime("%Y-%m-%dT%H:00:00Z")


def _pct(part: float, whole: float) -> float | None:
    if whole == 0:
        return None
    return round(100.0 * part / whole, 6)


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _load_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def inventory_map_sha256(positions: dict[str, float | Decimal | str]) -> str:
    lines = []
    for name, value in sorted((str(k), to_decimal(v)) for k, v in positions.items()):
        if abs(value) <= DUST:
            continue
        lines.append(f"{name},{format(value.normalize(), 'f')}")
    return _sha256_text("\n".join(lines) + ("\n" if lines else ""))


# ---------------------------------------------------------------------------
# Tier 1.1 — coverage & gaps
# ---------------------------------------------------------------------------


def _window_bounds(min_ts: int, max_ts: int) -> dict[str, tuple[int, int]]:
    return {
        "full_history": (min_ts, max_ts),
        "last_90d": (max(min_ts, max_ts - 90 * MS_DAY), max_ts),
        "last_30d": (max(min_ts, max_ts - 30 * MS_DAY), max_ts),
        "last_7d": (max(min_ts, max_ts - 7 * MS_DAY), max_ts),
    }


def _summarize_window(conn: sqlite3.Connection, start_ms: int, end_ms: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN block_trade_id IS NOT NULL AND block_trade_id != '' THEN 1 ELSE 0 END) AS block_count,
          SUM(CASE WHEN combo_trade_id IS NOT NULL AND combo_trade_id != '' THEN 1 ELSE 0 END) AS combo_count,
          SUM(
            CASE
              WHEN (block_trade_id IS NULL OR block_trade_id = '')
               AND (combo_trade_id IS NULL OR combo_trade_id = '')
              THEN 1 ELSE 0
            END
          ) AS single_leg_count,
          SUM(
            CASE
              WHEN (block_trade_id IS NOT NULL AND block_trade_id != '')
                OR (combo_trade_id IS NOT NULL AND combo_trade_id != '')
              THEN 1 ELSE 0
            END
          ) AS block_or_combo_count,
          SUM(
            CASE
              WHEN (block_trade_id IS NOT NULL AND block_trade_id != '')
               AND (combo_trade_id IS NOT NULL AND combo_trade_id != '')
              THEN 1 ELSE 0
            END
          ) AS block_and_combo_count,
          COUNT(DISTINCT instrument_name) AS unique_instruments,
          SUM(COALESCE(CAST(json_extract(payload_json, '$.amount') AS REAL), 0)) AS total_contracts,
          SUM(
            CASE
              WHEN (block_trade_id IS NOT NULL AND block_trade_id != '')
              THEN COALESCE(CAST(json_extract(payload_json, '$.amount') AS REAL), 0)
              ELSE 0
            END
          ) AS block_contracts,
          SUM(
            CASE
              WHEN (combo_trade_id IS NOT NULL AND combo_trade_id != '')
              THEN COALESCE(CAST(json_extract(payload_json, '$.amount') AS REAL), 0)
              ELSE 0
            END
          ) AS combo_contracts,
          SUM(
            CASE
              WHEN (block_trade_id IS NULL OR block_trade_id = '')
               AND (combo_trade_id IS NULL OR combo_trade_id = '')
              THEN COALESCE(CAST(json_extract(payload_json, '$.amount') AS REAL), 0)
              ELSE 0
            END
          ) AS single_leg_contracts,
          SUM(
            COALESCE(CAST(json_extract(payload_json, '$.amount') AS REAL), 0)
            * COALESCE(CAST(json_extract(payload_json, '$.price') AS REAL), 0)
            * COALESCE(CAST(json_extract(payload_json, '$.index_price') AS REAL), 0)
          ) AS notional_premium_usd,
          SUM(
            CASE
              WHEN (block_trade_id IS NOT NULL AND block_trade_id != '')
              THEN COALESCE(CAST(json_extract(payload_json, '$.amount') AS REAL), 0)
                   * COALESCE(CAST(json_extract(payload_json, '$.price') AS REAL), 0)
                   * COALESCE(CAST(json_extract(payload_json, '$.index_price') AS REAL), 0)
              ELSE 0
            END
          ) AS block_notional_premium_usd,
          SUM(
            CASE
              WHEN (combo_trade_id IS NOT NULL AND combo_trade_id != '')
              THEN COALESCE(CAST(json_extract(payload_json, '$.amount') AS REAL), 0)
                   * COALESCE(CAST(json_extract(payload_json, '$.price') AS REAL), 0)
                   * COALESCE(CAST(json_extract(payload_json, '$.index_price') AS REAL), 0)
              ELSE 0
            END
          ) AS combo_notional_premium_usd,
          SUM(
            CASE
              WHEN (block_trade_id IS NULL OR block_trade_id = '')
               AND (combo_trade_id IS NULL OR combo_trade_id = '')
              THEN COALESCE(CAST(json_extract(payload_json, '$.amount') AS REAL), 0)
                   * COALESCE(CAST(json_extract(payload_json, '$.price') AS REAL), 0)
                   * COALESCE(CAST(json_extract(payload_json, '$.index_price') AS REAL), 0)
              ELSE 0
            END
          ) AS single_leg_notional_premium_usd,
          SUM(
            COALESCE(CAST(json_extract(payload_json, '$.amount') AS REAL), 0)
            * COALESCE(CAST(json_extract(payload_json, '$.index_price') AS REAL), 0)
          ) AS notional_underlying_usd
        FROM raw_trades
        WHERE timestamp_ms >= ? AND timestamp_ms <= ?
        """,
        (start_ms, end_ms),
    ).fetchone()

    total = int(row[0] or 0)
    block_count = int(row[1] or 0)
    combo_count = int(row[2] or 0)
    single_leg_count = int(row[3] or 0)
    block_or_combo = int(row[4] or 0)
    block_and_combo = int(row[5] or 0)

    return {
        "window_start_ms": start_ms,
        "window_end_ms": end_ms,
        "window_start_utc": _iso_ms(start_ms),
        "window_end_utc": _iso_ms(end_ms),
        "total_raw_trades": total,
        "block_trade_count": block_count,
        "combo_trade_count": combo_count,
        "single_leg_trade_count": single_leg_count,
        "block_or_combo_trade_count": block_or_combo,
        "block_and_combo_trade_count": block_and_combo,
        "pct_block": _pct(block_count, total),
        "pct_combo": _pct(combo_count, total),
        "pct_single_leg": _pct(single_leg_count, total),
        "pct_block_or_combo": _pct(block_or_combo, total),
        "unique_instrument_names": int(row[6] or 0),
        "total_contracts": float(row[7] or 0.0),
        "block_contracts": float(row[8] or 0.0),
        "combo_contracts": float(row[9] or 0.0),
        "single_leg_contracts": float(row[10] or 0.0),
        "notional_premium_usd": float(row[11] or 0.0),
        "block_notional_premium_usd": float(row[12] or 0.0),
        "combo_notional_premium_usd": float(row[13] or 0.0),
        "single_leg_notional_premium_usd": float(row[14] or 0.0),
        "notional_underlying_usd": float(row[15] or 0.0),
        "pct_contracts_block": _pct(float(row[8] or 0.0), float(row[7] or 0.0)),
        "pct_contracts_combo": _pct(float(row[9] or 0.0), float(row[7] or 0.0)),
        "pct_contracts_single_leg": _pct(float(row[10] or 0.0), float(row[7] or 0.0)),
        "pct_notional_block": _pct(float(row[12] or 0.0), float(row[11] or 0.0)),
        "pct_notional_combo": _pct(float(row[13] or 0.0), float(row[11] or 0.0)),
    }


def diagnose_coverage_and_gaps(
    db_path: str | Path,
    *,
    low_volume_fraction: float = 0.20,
    gap_hours: float = 2.0,
    max_gaps_listed: int = 50,
) -> dict[str, Any]:
    database_path = Path(db_path)
    with sqlite3.connect(database_path) as conn:
        min_ts, max_ts, total = conn.execute(
            "SELECT MIN(timestamp_ms), MAX(timestamp_ms), COUNT(*) FROM raw_trades"
        ).fetchone()
        if min_ts is None or max_ts is None:
            return {
                "status": "FAIL",
                "reason": "raw_trades is empty",
                "total_raw_trades": 0,
            }

        min_ts = int(min_ts)
        max_ts = int(max_ts)
        windows = _window_bounds(min_ts, max_ts)
        window_summaries = {
            name: _summarize_window(conn, start, end) for name, (start, end) in windows.items()
        }

        daily_rows = conn.execute(
            """
            SELECT date(timestamp_ms / 1000, 'unixepoch') AS day_utc, COUNT(*) AS trade_count
            FROM raw_trades
            GROUP BY day_utc
            ORDER BY day_utc
            """
        ).fetchall()
        daily_counts = {str(day): int(count) for day, count in daily_rows}

        # Fill zero days across full calendar span.
        start_day = datetime.fromtimestamp(min_ts / 1000, tz=UTC).date()
        end_day = datetime.fromtimestamp(max_ts / 1000, tz=UTC).date()
        calendar: list[dict[str, Any]] = []
        cursor = start_day
        while cursor <= end_day:
            key = cursor.isoformat()
            calendar.append({"day_utc": key, "trade_count": daily_counts.get(key, 0)})
            cursor += timedelta(days=1)

        # 30-day rolling median of observed (non-leading) days with data preference:
        # use all calendar day counts for median baseline from last 30 observed days.
        recent_30 = [row["trade_count"] for row in calendar[-30:]] or [0]
        median_30 = float(statistics.median(recent_30))
        threshold = median_30 * low_volume_fraction
        suspicious_days = [
            {
                **row,
                "threshold": threshold,
                "median_30d": median_30,
                "reason": "zero" if row["trade_count"] == 0 else "below_20pct_of_30d_median",
            }
            for row in calendar
            if row["trade_count"] < threshold
        ]

        gap_ms = int(gap_hours * MS_HOUR)
        # Consecutive timestamp gaps (all hours).
        timestamps = [
            int(ts)
            for (ts,) in conn.execute(
                "SELECT timestamp_ms FROM raw_trades ORDER BY timestamp_ms"
            )
        ]
        gaps_all: list[dict[str, Any]] = []
        gaps_rth_equiv: list[dict[str, Any]] = []
        prev = timestamps[0]
        for ts in timestamps[1:]:
            delta = ts - prev
            if delta > gap_ms:
                gap = {
                    "from_ms": prev,
                    "to_ms": ts,
                    "from_utc": _iso_ms(prev),
                    "to_utc": _iso_ms(ts),
                    "gap_hours": round(delta / MS_HOUR, 4),
                }
                gaps_all.append(gap)
                # RTH-equivalent: gap intersects 08:00–22:00 UTC on either side.
                prev_dt = datetime.fromtimestamp(prev / 1000, tz=UTC)
                next_dt = datetime.fromtimestamp(ts / 1000, tz=UTC)
                if 8 <= prev_dt.hour < 22 or 8 <= next_dt.hour < 22:
                    gaps_rth_equiv.append(gap)
            prev = ts

        # Sample audit: payload-based block/combo vs columns (500 trades).
        sample = conn.execute(
            """
            SELECT block_trade_id, combo_trade_id, payload_json
            FROM raw_trades
            ORDER BY timestamp_ms DESC
            LIMIT 500
            """
        ).fetchall()
        payload_flag_mismatches = 0
        for block_id, combo_id, payload_json in sample:
            payload = json.loads(payload_json)
            col_block = bool(block_id)
            col_combo = bool(combo_id)
            trade_type = str(payload.get("trade_type") or "").strip().lower()
            det_block = bool(payload.get("block_trade_id") or payload.get("block_trade") or trade_type == "block_trade")
            det_combo = bool(payload.get("combo_id") or payload.get("combo_trade_id"))
            if det_block != col_block or det_combo != col_combo:
                payload_flag_mismatches += 1

        history = collect_history_summary(database_path, minimum_history_hours=1.0)

    status = "PASS"
    if not calendar or suspicious_days and any(d["trade_count"] == 0 for d in suspicious_days):
        status = "FLAG"
    if total == 0:
        status = "FAIL"

    return {
        "status": status,
        "notional_definition": (
            "premium_usd = amount * price * index_price; "
            "underlying_usd = amount * index_price; "
            "block/combo flags from raw_trades.block_trade_id / combo_trade_id columns"
        ),
        "rth_note": (
            "Crypto options trade 24/7; no RTH filter exists in the codebase. "
            "gaps_all flags any >2h silence; gaps_rth_equivalent restricts to gaps "
            "touching 08:00–22:00 UTC as a liquidity-period proxy."
        ),
        "min_timestamp_ms": min_ts,
        "max_timestamp_ms": max_ts,
        "min_timestamp_utc": _iso_ms(min_ts),
        "max_timestamp_utc": _iso_ms(max_ts),
        "total_raw_trades": int(total),
        "windows": window_summaries,
        "daily_trade_counts": calendar,
        "median_30d_trade_count": median_30,
        "low_volume_threshold": threshold,
        "low_volume_fraction": low_volume_fraction,
        "suspicious_days": suspicious_days,
        "gap_hours_threshold": gap_hours,
        "gaps_all_count": len(gaps_all),
        "gaps_all": gaps_all[:max_gaps_listed],
        "gaps_rth_equivalent_count": len(gaps_rth_equiv),
        "gaps_rth_equivalent": gaps_rth_equiv[:max_gaps_listed],
        "payload_flag_sample_size": len(sample),
        "payload_flag_mismatches_in_sample": payload_flag_mismatches,
        "history_summary": history,
    }


# ---------------------------------------------------------------------------
# Shared helpers for strike inventory path / sensitivity
# ---------------------------------------------------------------------------


def load_top_strikes_by_abs_net_gex(
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
    *,
    limit: int = 5,
) -> list[dict[str, Any]]:
    artifacts = Path(artifacts_dir)
    strike_csv = artifacts / "gex" / "gex_by_strike.csv"
    if strike_csv.exists():
        rows = _load_csv(strike_csv)
        ranked = sorted(rows, key=lambda r: abs(float(r["net_gex"])), reverse=True)[:limit]
        return [
            {
                "strike": float(r["strike"]),
                "call_gex": float(r["call_gex"]),
                "put_gex": float(r["put_gex"]),
                "net_gex": float(r["net_gex"]),
                "gross_gex": float(r["gross_gex"]),
                "source": str(strike_csv),
            }
            for r in ranked
        ]

    # Fallback: aggregate Phase 5 snapshot rows by strike.
    payload = _load_json(Path(snapshot_path))
    buckets: dict[float, dict[str, float]] = defaultdict(lambda: {"call_gex": 0.0, "put_gex": 0.0})
    for row in payload.get("rows", []):
        strike = float(row["strike"])
        buckets[strike]["call_gex"] += float(row.get("call_gex", 0.0))
        buckets[strike]["put_gex"] += float(row.get("put_gex", 0.0))
    ranked_rows = []
    for strike, bucket in buckets.items():
        net = bucket["call_gex"] + bucket["put_gex"]
        ranked_rows.append(
            {
                "strike": strike,
                "call_gex": bucket["call_gex"],
                "put_gex": bucket["put_gex"],
                "net_gex": net,
                "gross_gex": abs(bucket["call_gex"]) + abs(bucket["put_gex"]),
                "source": str(snapshot_path),
            }
        )
    ranked_rows.sort(key=lambda r: abs(r["net_gex"]), reverse=True)
    return ranked_rows[:limit]


def instruments_for_strikes(
    inventory_csv: Path,
    strikes: Iterable[float],
) -> dict[float, list[dict[str, Any]]]:
    strike_set = {float(s) for s in strikes}
    by_strike: dict[float, list[dict[str, Any]]] = defaultdict(list)
    for row in _load_csv(inventory_csv):
        strike = float(row["strike"])
        if strike in strike_set:
            by_strike[strike].append(
                {
                    "instrument_name": row["instrument_name"],
                    "option_type": row["option_type"],
                    "strike": strike,
                    "expiry_ts": int(row["expiry_ts"]),
                    "net_contracts": float(row["net_contracts"]),
                    "contract_multiplier": float(row["contract_multiplier"]),
                    "include_in_gex": str(row.get("include_in_gex", "")).lower() == "true",
                }
            )
    return dict(by_strike)


def _stream_raw_trades_for_instruments(
    conn: sqlite3.Connection,
    instrument_names: set[str],
) -> list[dict[str, Any]]:
    if not instrument_names:
        return []
    # Chunk IN lists to stay under SQLite variable limits.
    names = sorted(instrument_names)
    trades: list[dict[str, Any]] = []
    chunk_size = 400
    for i in range(0, len(names), chunk_size):
        chunk = names[i : i + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        query = f"""
            SELECT payload_json
            FROM raw_trades
            WHERE instrument_name IN ({placeholders})
            ORDER BY timestamp_ms, trade_seq, instrument_name, trade_id
        """
        for (payload_json,) in conn.execute(query, chunk):
            trades.append(json.loads(payload_json))
    trades.sort(
        key=lambda t: (
            int(t.get("timestamp") or 0),
            int(t.get("trade_seq") or 0),
            str(t.get("instrument_name") or ""),
            str(t.get("trade_id") or ""),
        )
    )
    return trades


def _phase3_events_for_raw(
    raw_instruments: list[dict[str, Any]],
    raw_trades: list[dict[str, Any]],
    *,
    normalization_version: str = "phase2.v1",
) -> list[LedgerEvent]:
    phase2 = normalize_trade_batch(
        raw_instruments,
        raw_trades,
        method_version=normalization_version,
        strict_instrument_lookup=False,
    )
    phase3 = build_phase3_events(phase2["trades"], normalization_version=normalization_version)
    return [LedgerEvent.from_dict(row) for row in phase3]


def _replay_inventory_path(
    events: list[LedgerEvent],
    instrument_names: set[str],
    *,
    policy: LedgerPolicy | None = None,
    jump_threshold: float = 50.0,
) -> dict[str, Any]:
    policy = policy or LedgerPolicy()
    ordered = sorted(events, key=lambda e: (e.trade_seq, e.ts_ms, e.event_id))
    # Per-instrument positions and strike-aggregated path.
    positions: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    daily_end: dict[str, Decimal] = {}
    hourly_end: dict[str, Decimal] = {}
    max_abs = Decimal("0")
    applied_deltas: list[dict[str, Any]] = []
    large_non_block_jumps: list[dict[str, Any]] = []
    prev_day = None
    prev_hour = None
    prev_day_pos = Decimal("0")
    prev_hour_pos = Decimal("0")
    largest_day_jump = {"delta": 0.0}
    largest_hour_jump = {"delta": 0.0}
    starting = Decimal("0")
    started = False

    for event in ordered:
        if event.instrument_name not in instrument_names:
            continue
        applied, reason = classify_event(event, policy)
        if not applied:
            continue
        delta = dealer_position_delta(event)
        after = positions[event.instrument_name] + delta
        if abs(after) <= DUST:
            positions.pop(event.instrument_name, None)
            after = Decimal("0")
        else:
            positions[event.instrument_name] = after

        # Strike-level net = sum of instruments in scope.
        strike_net = sum(positions.values(), Decimal("0"))
        if not started:
            starting = strike_net
            started = True
            prev_day_pos = strike_net
            prev_hour_pos = strike_net

        abs_net = abs(strike_net)
        if abs_net > max_abs:
            max_abs = abs_net

        day = _day_key(event.ts_ms)
        hour = _hour_key(event.ts_ms)
        if prev_day is not None and day != prev_day:
            day_jump = prev_day_pos - daily_end.get(prev_day, prev_day_pos)
            # jump over the closed day is recorded when day rolls using last pos of day
        daily_end[day] = strike_net
        hourly_end[hour] = strike_net

        if prev_day is not None and day != prev_day:
            jump = float(daily_end[prev_day] - prev_day_pos) if False else float(daily_end[prev_day] - prev_day_pos)
            # Better: jump = end(prev_day) - start(prev_day). Track day_start.
        # Recalculate properly after loop with series.

        applied_deltas.append(
            {
                "event_id": event.event_id,
                "source_trade_id": event.source_trade_id,
                "instrument_name": event.instrument_name,
                "ts_ms": event.ts_ms,
                "ts_utc": _iso_ms(event.ts_ms),
                "amount": float(event.amount),
                "taker_side": event.taker_side,
                "dealer_delta": float(delta),
                "strike_net_after": float(strike_net),
                "is_block_trade": event.is_block_trade,
                "is_combo_trade": event.is_combo_trade,
            }
        )

        if abs(float(delta)) > jump_threshold and not event.is_block_trade:
            large_non_block_jumps.append(
                {
                    "event_id": event.event_id,
                    "source_trade_id": event.source_trade_id,
                    "instrument_name": event.instrument_name,
                    "ts_utc": _iso_ms(event.ts_ms),
                    "dealer_delta": float(delta),
                    "amount": float(event.amount),
                    "taker_side": event.taker_side,
                    "is_block_trade": event.is_block_trade,
                    "is_combo_trade": event.is_combo_trade,
                }
            )

        prev_day = day
        prev_hour = hour

    # Build daily/hourly series properly.
    daily_series = [{"ts": k, "net_contracts": float(v)} for k, v in sorted(daily_end.items())]
    hourly_series = [{"ts": k, "net_contracts": float(v)} for k, v in sorted(hourly_end.items())]

    largest_1d = {"from": None, "to": None, "delta": 0.0, "from_net": 0.0, "to_net": 0.0}
    for i in range(1, len(daily_series)):
        delta = daily_series[i]["net_contracts"] - daily_series[i - 1]["net_contracts"]
        if abs(delta) > abs(largest_1d["delta"]):
            largest_1d = {
                "from": daily_series[i - 1]["ts"],
                "to": daily_series[i]["ts"],
                "delta": delta,
                "from_net": daily_series[i - 1]["net_contracts"],
                "to_net": daily_series[i]["net_contracts"],
            }

    largest_1h = {"from": None, "to": None, "delta": 0.0, "from_net": 0.0, "to_net": 0.0}
    # Prefer last 7 days of hourly if long series.
    hourly_focus = hourly_series
    if hourly_series:
        cutoff = hourly_series[-1]["ts"][:10]
        # keep all; still report max hour jump
    for i in range(1, len(hourly_focus)):
        delta = hourly_focus[i]["net_contracts"] - hourly_focus[i - 1]["net_contracts"]
        if abs(delta) > abs(largest_1h["delta"]):
            largest_1h = {
                "from": hourly_focus[i - 1]["ts"],
                "to": hourly_focus[i]["ts"],
                "delta": delta,
                "from_net": hourly_focus[i - 1]["net_contracts"],
                "to_net": hourly_focus[i]["net_contracts"],
            }

    ending = float(sum(positions.values(), Decimal("0")))
    starting_f = float(starting) if started else 0.0

    # Concentration: largest 5 applied |deltas| vs |ending| (or sum of |applied|).
    top5 = sorted(applied_deltas, key=lambda d: abs(d["dealer_delta"]), reverse=True)[:5]
    top5_sum = sum(d["dealer_delta"] for d in top5)
    concentration_pct = None
    if ending != 0:
        concentration_pct = round(100.0 * top5_sum / ending, 6)

    abs_deltas = sorted(abs(d["dealer_delta"]) for d in applied_deltas)
    p99 = None
    if abs_deltas:
        idx = min(len(abs_deltas) - 1, int(math.ceil(0.99 * len(abs_deltas)) - 1))
        p99 = abs_deltas[max(idx, 0)]

    return {
        "starting_inventory": starting_f,
        "ending_inventory": ending,
        "max_abs_inventory": float(max_abs),
        "applied_trade_count": len(applied_deltas),
        "largest_1d_jump": largest_1d,
        "largest_1h_jump": largest_1h,
        "top5_trades": top5,
        "top5_delta_sum": top5_sum,
        "top5_share_of_final_net_pct": concentration_pct,
        "single_trade_abs_delta_p99": p99,
        "large_non_block_jumps_count": len(large_non_block_jumps),
        "large_non_block_jumps": large_non_block_jumps[:50],
        "daily_series_points": len(daily_series),
        "hourly_series_points": len(hourly_series),
        "daily_series_tail": daily_series[-14:],
        "hourly_series_tail": hourly_series[-48:],
        "final_instrument_positions": {
            name: float(pos) for name, pos in sorted(positions.items()) if abs(pos) > DUST
        },
    }


def diagnose_inventory_paths(
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
    *,
    top_n: int = 5,
    jump_threshold: float = 50.0,
) -> dict[str, Any]:
    artifacts = Path(artifacts_dir)
    inventory_csv = artifacts / "inventory_snapshot.csv"
    top_strikes = load_top_strikes_by_abs_net_gex(artifacts, snapshot_path, limit=top_n)
    strike_values = [row["strike"] for row in top_strikes]
    by_strike = instruments_for_strikes(inventory_csv, strike_values)

    all_names: set[str] = set()
    for rows in by_strike.values():
        for row in rows:
            all_names.add(row["instrument_name"])

    with sqlite3.connect(db_path) as conn:
        # Also include any historical instruments that traded at these strikes
        # (inventory may only list nonzero final positions).
        for strike in strike_values:
            # Instrument names encode strike: BTC-...-64000-C
            pattern = f"%-{int(strike) if float(strike).is_integer() else strike}-%"
            # Safer: parse from inventory + gex instrument file.
            pass
        # Expand from gex_by_instrument if present.
        gex_inst = artifacts / "gex" / "gex_by_instrument.csv"
        if gex_inst.exists():
            for row in _load_csv(gex_inst):
                if float(row["strike"]) in set(strike_values):
                    all_names.add(row["instrument_name"])

        # Expand from raw instruments metadata for these strikes.
        for (payload_json,) in conn.execute("SELECT payload_json FROM raw_instruments"):
            payload = json.loads(payload_json)
            strike = payload.get("strike")
            if strike is None:
                continue
            try:
                if float(strike) in set(strike_values):
                    name = str(payload.get("instrument_name") or "")
                    if name:
                        all_names.add(name)
            except (TypeError, ValueError):
                continue

        raw_instruments = [
            json.loads(payload_json)
            for (payload_json,) in conn.execute("SELECT payload_json FROM raw_instruments")
        ]
        raw_trades = _stream_raw_trades_for_instruments(conn, all_names)

    events = _phase3_events_for_raw(raw_instruments, raw_trades)
    strike_results = []
    for strike_row in top_strikes:
        strike = strike_row["strike"]
        names = {
            row["instrument_name"]
            for row in by_strike.get(strike, [])
        }
        # Also any event instruments whose strike matches.
        for event in events:
            if float(event.strike) == float(strike):
                names.add(event.instrument_name)
        path = _replay_inventory_path(
            events,
            names,
            policy=LedgerPolicy(),
            jump_threshold=jump_threshold,
        )
        live_net = sum(float(r["net_contracts"]) for r in by_strike.get(strike, []))
        strike_results.append(
            {
                "strike": strike,
                "live_net_gex": strike_row["net_gex"],
                "live_inventory_net_contracts": live_net,
                "instrument_count_in_scope": len(names),
                "live_inventory_instruments": by_strike.get(strike, []),
                "path": path,
            }
        )

    any_flags = any(r["path"]["large_non_block_jumps_count"] > 0 for r in strike_results)
    return {
        "status": "FLAG" if any_flags else "PASS",
        "jump_threshold_contracts": jump_threshold,
        "top_strikes": top_strikes,
        "strike_paths": strike_results,
        "scoped_instrument_count": len(all_names),
        "scoped_trade_count": len(raw_trades),
        "scoped_event_count": len(events),
    }


# ---------------------------------------------------------------------------
# Tier 1.3 — materialization / greeks integrity
# ---------------------------------------------------------------------------


def diagnose_materialization_integrity(
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
    output_dir: str | Path,
    *,
    run_fresh_materialize: bool = True,
    shared_full: dict[str, Any] | None = None,
) -> dict[str, Any]:
    artifacts = Path(artifacts_dir)
    snapshot = Path(snapshot_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    live_inventory = {
        row["instrument_name"]: float(row["net_contracts"])
        for row in _load_csv(artifacts / "inventory_snapshot.csv")
    }
    live_inventory_meta = {
        row["instrument_name"]: row for row in _load_csv(artifacts / "inventory_snapshot.csv")
    }
    live_gex_rows = _load_csv(artifacts / "gex" / "gex_by_instrument.csv")
    live_gex_net = {row["instrument_name"]: float(row["net_contracts"]) for row in live_gex_rows}
    live_greeks_path = artifacts / "gex" / "greeks_snapshot.json"
    live_greeks = load_greeks_snapshot_json(live_greeks_path) if live_greeks_path.exists() else {}
    live_summary = (
        _load_json(artifacts / "gex" / "gex_summary.json")
        if (artifacts / "gex" / "gex_summary.json").exists()
        else {}
    )
    live_snapshot = _load_json(snapshot) if snapshot.exists() else {}
    checkpoint = load_checkpoint(artifacts / "inventory_checkpoint.json")

    now_ms = int(time.time() * 1000)
    nonzero = {k: v for k, v in live_inventory.items() if abs(v) > 0}
    missing_greeks_live = list(live_summary.get("missing_greeks") or [])
    dropped_missing_greeks = []
    dropped_expired = []
    for name, net in nonzero.items():
        meta = live_inventory_meta.get(name, {})
        expiry_ts = int(meta.get("expiry_ts") or 0)
        include = str(meta.get("include_in_gex", "")).lower() == "true"
        has_greek = name in live_greeks
        in_gex = name in live_gex_net
        if include and abs(net) > 0 and not in_gex:
            if expiry_ts and expiry_ts < now_ms:
                dropped_expired.append(
                    {"instrument_name": name, "net_contracts": net, "expiry_ts": expiry_ts}
                )
            elif not has_greek:
                dropped_missing_greeks.append({"instrument_name": name, "net_contracts": net})

    # Canonical lag monitor: checkpoint positions vs serving inventory CSV.
    lag = measure_checkpoint_inventory_lag(artifacts)
    lag_eval = evaluate_checkpoint_lag(
        lag,
        warn_threshold=DEFAULT_CHECKPOINT_LAG_WARN_THRESHOLD,
        context="validation.tier1_materialization_integrity",
    )
    ckpt_vs_live_mismatches = []
    for item in lag.mismatches:
        ckpt_vs_live_mismatches.append(
            {
                "instrument_name": item["instrument_name"],
                "checkpoint": float(item["checkpoint"]),
                "live_inventory": float(item["inventory"]),
                "delta": float(item["delta"]),
            }
        )

    fresh: dict[str, Any] | None = None
    inventory_mismatches: list[dict[str, Any]] = []
    greeks_only_live: list[str] = []
    greeks_only_fresh: list[str] = []
    fresh_status = "SKIPPED"

    source = shared_full
    if source is None and run_fresh_materialize:
        source = _run_shared_full_materialize(
            db_path=db_path,
            artifacts_dir=artifacts_dir,
            output_dir=out,
        )

    if source is not None:
        if source.get("status") != "PASS":
            fresh = {"error": source.get("error", "fresh materialize failed")}
            fresh_status = "FAIL"
        else:
            fresh_inventory = dict(source.get("inventory") or {})
            for key in sorted(set(live_inventory) | set(fresh_inventory)):
                left = live_inventory.get(key, 0.0)
                right = fresh_inventory.get(key, 0.0)
                if not math.isclose(left, right, rel_tol=0, abs_tol=1e-9):
                    inventory_mismatches.append(
                        {
                            "instrument_name": key,
                            "live": left,
                            "fresh": right,
                            "delta": right - left,
                        }
                    )
            fresh_greeks_path = Path(source["artifacts_dir"]) / "gex" / "greeks_snapshot.json"
            fresh_greeks = (
                load_greeks_snapshot_json(fresh_greeks_path) if fresh_greeks_path.exists() else {}
            )
            greeks_only_live = sorted(set(live_greeks) - set(fresh_greeks))
            greeks_only_fresh = sorted(set(fresh_greeks) - set(live_greeks))
            fresh = {
                "materialization": source.get("materialization"),
                "inventory_sha256_live": inventory_map_sha256(live_inventory),
                "inventory_sha256_fresh": source.get("inventory_sha256"),
                "inventory_match": len(inventory_mismatches) == 0,
                "mismatch_count": len(inventory_mismatches),
                "elapsed_seconds": source.get("elapsed_seconds"),
            }
            fresh_status = "PASS" if fresh["inventory_match"] else "FLAG"

    status = fresh_status
    if status == "SKIPPED":
        status = "PASS" if lag.delta_count == 0 else "FLAG"
    if lag_eval["exceeded_warn_threshold"] and status == "PASS":
        status = "FLAG"
    if lag.delta_count > 0 and status == "PASS":
        status = "FLAG"
    if dropped_missing_greeks:
        status = "FLAG" if status == "PASS" else status

    return {
        "status": status,
        "live_inventory_count": len(live_inventory),
        "live_nonzero_count": len(nonzero),
        "live_gex_instrument_count": len(live_gex_net),
        "live_greeks_count": len(live_greeks),
        "missing_greeks_count_summary": len(missing_greeks_live),
        "missing_greeks_examples": missing_greeks_live[:25],
        "dropped_expired_nonzero": {
            "count": len(dropped_expired),
            "examples": dropped_expired[:25],
            "total_abs_contracts": sum(abs(x["net_contracts"]) for x in dropped_expired),
        },
        "dropped_missing_greeks_nonzero": {
            "count": len(dropped_missing_greeks),
            "examples": dropped_missing_greeks[:25],
        },
        "dust_threshold": float(DUST),
        "dust_note": "Positions with |net| <= 1e-10 are pruned during ledger replay.",
        "checkpoint_vs_live_inventory": {
            "checkpoint_present": lag.checkpoint_present,
            "checkpoint_positions_sha256": lag.checkpoint_positions_sha256,
            "live_inventory_sha256": lag.inventory_positions_sha256,
            "lag_count": lag.delta_count,
            "mismatch_count": lag.delta_count,
            "positions_sha_match": lag.positions_sha_match,
            "checkpoint_position_count": lag.checkpoint_position_count,
            "inventory_position_count": lag.inventory_position_count,
            "warn_threshold": DEFAULT_CHECKPOINT_LAG_WARN_THRESHOLD,
            "exceeded_warn_threshold": lag_eval["exceeded_warn_threshold"],
            "mismatches": ckpt_vs_live_mismatches[:50],
            "note": (
                "Post-materialize rewrite should keep lag_count at 0. "
                "Non-zero lag means inventory_checkpoint.json drifted from "
                "inventory_snapshot.csv (stale checkpoint or interrupted write)."
            ),
        },
        "checkpoint_inventory_lag": lag_eval,
        "fresh_materialize": fresh,
        "inventory_mismatches": inventory_mismatches[:100],
        "greeks_only_in_live": greeks_only_live[:50],
        "greeks_only_in_fresh": greeks_only_fresh[:50],
        "live_snapshot_as_of": live_snapshot.get("as_of"),
        "live_snapshot_spot": live_snapshot.get("spot_price"),
        "live_snapshot_row_count": len(live_snapshot.get("rows") or []),
    }


# ---------------------------------------------------------------------------
# Tier 1.4 — excluded volume + block sensitivity
# ---------------------------------------------------------------------------


def diagnose_excluded_volume(
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
    coverage: dict[str, Any],
    *,
    top_n_strikes: int = 3,
) -> dict[str, Any]:
    windows = {}
    for name in ("full_history", "last_90d", "last_30d"):
        w = coverage["windows"][name]
        windows[name] = {
            "total_raw_trades": w["total_raw_trades"],
            "block_trade_count": w["block_trade_count"],
            "combo_trade_count": w["combo_trade_count"],
            "block_or_combo_trade_count": w["block_or_combo_trade_count"],
            "pct_trades_block_or_combo": w["pct_block_or_combo"],
            "total_contracts": w["total_contracts"],
            "block_contracts": w["block_contracts"],
            "combo_contracts": w["combo_contracts"],
            "single_leg_contracts": w["single_leg_contracts"],
            "pct_contracts_block": w["pct_contracts_block"],
            "pct_contracts_combo": w["pct_contracts_combo"],
            "notional_premium_usd": w["notional_premium_usd"],
            "block_notional_premium_usd": w["block_notional_premium_usd"],
            "combo_notional_premium_usd": w["combo_notional_premium_usd"],
            "pct_notional_block": w["pct_notional_block"],
            "pct_notional_combo": w["pct_notional_combo"],
        }

    top_strikes = load_top_strikes_by_abs_net_gex(artifacts_dir, snapshot_path, limit=top_n_strikes)
    strike_values = [s["strike"] for s in top_strikes]
    inventory_csv = Path(artifacts_dir) / "inventory_snapshot.csv"
    by_strike = instruments_for_strikes(inventory_csv, strike_values)

    all_names: set[str] = set()
    for rows in by_strike.values():
        for row in rows:
            all_names.add(row["instrument_name"])

    with sqlite3.connect(db_path) as conn:
        for (payload_json,) in conn.execute("SELECT payload_json FROM raw_instruments"):
            payload = json.loads(payload_json)
            try:
                if float(payload.get("strike") or -1) in set(strike_values):
                    all_names.add(str(payload["instrument_name"]))
            except (TypeError, ValueError, KeyError):
                continue
        raw_instruments = [
            json.loads(p) for (p,) in conn.execute("SELECT payload_json FROM raw_instruments")
        ]
        raw_trades = _stream_raw_trades_for_instruments(conn, all_names)

    events = _phase3_events_for_raw(raw_instruments, raw_trades)
    prod_policy = LedgerPolicy()
    sens_policy = LedgerPolicy(
        exclude_block_trades=False,
        exclude_combo_trades=False,
        require_single_leg=False,
    )

    # Load greeks for rough GEX
    greeks_path = Path(artifacts_dir) / "gex" / "greeks_snapshot.json"
    greeks = load_greeks_snapshot_json(greeks_path) if greeks_path.exists() else {}
    gex_inst_rows = {
        row["instrument_name"]: row
        for row in _load_csv(Path(artifacts_dir) / "gex" / "gex_by_instrument.csv")
    }

    sensitivity = []
    for strike_row in top_strikes:
        strike = strike_row["strike"]
        names = {
            e.instrument_name for e in events if float(e.strike) == float(strike)
        } | {r["instrument_name"] for r in by_strike.get(strike, [])}

        def _final_positions(policy: LedgerPolicy) -> dict[str, float]:
            positions: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
            for event in sorted(events, key=lambda e: (e.trade_seq, e.ts_ms, e.event_id)):
                if event.instrument_name not in names:
                    continue
                applied, _ = classify_event(event, policy)
                if not applied:
                    continue
                delta = dealer_position_delta(event)
                after = positions[event.instrument_name] + delta
                if abs(after) <= DUST:
                    positions.pop(event.instrument_name, None)
                else:
                    positions[event.instrument_name] = after
            return {k: float(v) for k, v in positions.items()}

        prod_pos = _final_positions(prod_policy)
        sens_pos = _final_positions(sens_policy)
        prod_net = sum(prod_pos.values())
        sens_net = sum(sens_pos.values())

        # Rough GEX using live greeks when available.
        def _rough_gex(pos_map: dict[str, float]) -> float:
            total = 0.0
            for name, net in pos_map.items():
                greek = greeks.get(name)
                mult = 1.0
                if name in gex_inst_rows:
                    mult = float(gex_inst_rows[name].get("contract_multiplier") or 1.0)
                    if greek is None:
                        try:
                            gamma = float(gex_inst_rows[name]["gamma"])
                            spot = float(gex_inst_rows[name]["spot_price"])
                            total += net * mult * gamma * (spot**2) * 0.01
                            continue
                        except (KeyError, TypeError, ValueError):
                            continue
                if greek is None:
                    continue
                total += net * mult * greek.gamma * (greek.spot_price**2) * 0.01
            return total

        sensitivity.append(
            {
                "strike": strike,
                "live_net_gex": strike_row["net_gex"],
                "production_net_contracts": prod_net,
                "with_blocks_combos_net_contracts": sens_net,
                "delta_net_contracts": sens_net - prod_net,
                "production_rough_gex": _rough_gex(prod_pos),
                "with_blocks_combos_rough_gex": _rough_gex(sens_pos),
                "delta_rough_gex": _rough_gex(sens_pos) - _rough_gex(prod_pos),
                "production_positions": prod_pos,
                "sensitivity_positions": sens_pos,
            }
        )

    return {
        "status": "PASS",
        "label": "offline_sensitivity_only_production_unchanged",
        "windows": windows,
        "top_strike_block_sensitivity": sensitivity,
    }


# ---------------------------------------------------------------------------
# Tier 2.1 — replay determinism / checkpoint fidelity
# ---------------------------------------------------------------------------


def diagnose_replay_determinism(
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
    output_dir: str | Path,
    *,
    run_full_replay: bool = True,
    shared_full: dict[str, Any] | None = None,
    run_second_full: bool = False,
) -> dict[str, Any]:
    artifacts = Path(artifacts_dir)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    checkpoint = load_checkpoint(artifacts / "inventory_checkpoint.json")
    live_inventory = {
        row["instrument_name"]: float(row["net_contracts"])
        for row in _load_csv(artifacts / "inventory_snapshot.csv")
    }
    live_sha = inventory_map_sha256(live_inventory)
    ckpt_sha = positions_sha256(checkpoint.positions) if checkpoint else None
    lag = measure_checkpoint_inventory_lag(artifacts)
    lag_eval = evaluate_checkpoint_lag(
        lag,
        warn_threshold=DEFAULT_CHECKPOINT_LAG_WARN_THRESHOLD,
        context="validation.tier2_replay_determinism",
    )

    double_run: dict[str, Any] | None = None
    full_vs_live: dict[str, Any] | None = None
    status = "PASS"

    run_a = shared_full
    if run_a is None and run_full_replay:
        run_a = _run_shared_full_materialize(
            db_path=db_path,
            artifacts_dir=artifacts_dir,
            output_dir=out,
        )

    if run_a is not None and run_a.get("status") == "PASS":
        inv_a = dict(run_a.get("inventory") or {})
        sha_a = run_a.get("inventory_sha256")
        live_div = []
        for key in sorted(set(inv_a) | set(live_inventory)):
            left = live_inventory.get(key, 0.0)
            right = inv_a.get(key, 0.0)
            if not math.isclose(left, right, rel_tol=0, abs_tol=1e-9):
                live_div.append(
                    {
                        "instrument_name": key,
                        "live": left,
                        "full_replay": right,
                        "delta": right - left,
                    }
                )
        full_vs_live = {
            "live_sha": live_sha,
            "full_replay_sha": sha_a,
            "match": not live_div,
            "mismatch_count": len(live_div),
            "mismatches": live_div[:50],
            "note": (
                "Live inventory may include trades ingested after the diagnostic "
                "DB snapshot was last refreshed; mismatches are flags, not pure "
                "non-determinism, unless double-run also diverges."
            ),
        }

        if run_second_full:
            run_b = _run_shared_full_materialize(
                db_path=db_path,
                artifacts_dir=artifacts_dir,
                output_dir=out / "determinism_run_b_root",
            )
            if run_b.get("status") != "PASS":
                double_run = {"error": run_b.get("error")}
                status = "FAIL"
            else:
                inv_b = dict(run_b.get("inventory") or {})
                sha_b = run_b.get("inventory_sha256")
                diverged = []
                for key in sorted(set(inv_a) | set(inv_b)):
                    left = inv_a.get(key, 0.0)
                    right = inv_b.get(key, 0.0)
                    if not math.isclose(left, right, rel_tol=0, abs_tol=1e-9):
                        diverged.append(
                            {"instrument_name": key, "run_a": left, "run_b": right}
                        )
                double_run = {
                    "inventory_sha_a": sha_a,
                    "inventory_sha_b": sha_b,
                    "inventory_match": sha_a == sha_b and not diverged,
                    "snapshot_sha_a": run_a.get("snapshot_sha256"),
                    "snapshot_sha_b": run_b.get("snapshot_sha256"),
                    "snapshot_match": run_a.get("snapshot_sha256") == run_b.get("snapshot_sha256"),
                    "diverged_instruments": diverged[:50],
                    "method": "two_independent_full_lightweight_replays_frozen_greeks",
                }
                if not double_run["inventory_match"] or not double_run["snapshot_match"]:
                    status = "FAIL"
        else:
            # Single full replay: validate ledger_manifest snapshot hash stability
            # via checkpoint hash integrity + full-vs-live comparison.
            double_run = {
                "method": "single_full_lightweight_plus_checkpoint_hash",
                "inventory_sha_full": sha_a,
                "snapshot_sha_full": run_a.get("snapshot_sha256"),
                "note": (
                    "Second independent full replay skipped (disk/time). "
                    "Determinism is evidenced by unit tests + checkpoint "
                    "positions_sha256 validity + full-vs-live inventory compare."
                ),
            }

        if full_vs_live and not full_vs_live["match"] and status == "PASS":
            status = "FLAG"
    elif run_a is not None:
        double_run = {"error": run_a.get("error")}
        status = "FAIL"
    else:
        status = "FLAG"
        double_run = {"skipped": True, "reason": "no full replay available"}

    ckpt_info: dict[str, Any]
    if checkpoint:
        ckpt_info = {
            "present": True,
            "checkpoint_version": checkpoint.checkpoint_version,
            "normalization_version": checkpoint.normalization_version,
            "ledger_methodology_version": checkpoint.ledger_methodology_version,
            "gex_methodology_version": checkpoint.gex_methodology_version,
            "raw_trade_count": checkpoint.raw_trade_count,
            "input_event_count": checkpoint.input_event_count,
            "applied_event_count": checkpoint.applied_event_count,
            "excluded_event_count": checkpoint.excluded_event_count,
            "positions_sha256": checkpoint.positions_sha256,
            "computed_positions_sha256": ckpt_sha,
            "positions_hash_valid": checkpoint.positions_sha256 == ckpt_sha,
            "created_at_utc": checkpoint.created_at_utc,
            "position_count": len(checkpoint.positions),
            "inventory_lag_count": lag.delta_count,
            "inventory_positions_sha256": lag.inventory_positions_sha256,
            "positions_match_inventory": lag.positions_sha_match,
        }
        if not ckpt_info["positions_hash_valid"]:
            status = "FAIL"
        if lag_eval["exceeded_warn_threshold"] and status == "PASS":
            status = "FLAG"
        elif lag.delta_count > 0 and status == "PASS":
            status = "FLAG"
    else:
        ckpt_info = {"present": False, "inventory_lag_count": lag.delta_count}

    return {
        "status": status,
        "checkpoint": ckpt_info,
        "checkpoint_inventory_lag": lag_eval,
        "live_inventory_sha256": live_sha,
        "double_full_replay": double_run,
        "full_replay_vs_live": full_vs_live,
    }


# ---------------------------------------------------------------------------
# Tier 2.2 — scale sanity vs public Deribit
# ---------------------------------------------------------------------------


def diagnose_scale_sanity(
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
) -> dict[str, Any]:
    artifacts = Path(artifacts_dir)
    inventory = _load_csv(artifacts / "inventory_snapshot.csv")
    gex_rows = _load_csv(artifacts / "gex" / "gex_by_instrument.csv")
    snapshot = _load_json(Path(snapshot_path)) if Path(snapshot_path).exists() else {}

    our_abs_net = sum(abs(float(r["net_contracts"])) for r in inventory if str(r.get("include_in_gex", "")).lower() == "true")
    our_abs_net_gex_live = sum(abs(float(r["net_contracts"])) for r in gex_rows)
    our_snapshot_oi = sum(float(r.get("open_interest") or 0.0) for r in snapshot.get("rows") or [])

    with sqlite3.connect(db_path) as conn:
        max_ts = int(conn.execute("SELECT MAX(timestamp_ms) FROM raw_trades").fetchone()[0])
        start_24h = max_ts - MS_DAY
        # Applied single-leg volume ≈ trades without block/combo ids (raw proxy).
        row = conn.execute(
            """
            SELECT
              SUM(COALESCE(CAST(json_extract(payload_json,'$.amount') AS REAL),0)),
              COUNT(*)
            FROM raw_trades
            WHERE timestamp_ms >= ? AND timestamp_ms <= ?
              AND (block_trade_id IS NULL OR block_trade_id = '')
              AND (combo_trade_id IS NULL OR combo_trade_id = '')
            """,
            (start_24h, max_ts),
        ).fetchone()
        our_24h_single_leg_contracts = float(row[0] or 0.0)
        our_24h_single_leg_trades = int(row[1] or 0)
        total_24h = conn.execute(
            "SELECT SUM(COALESCE(CAST(json_extract(payload_json,'$.amount') AS REAL),0)), COUNT(*) FROM raw_trades WHERE timestamp_ms >= ? AND timestamp_ms <= ?",
            (start_24h, max_ts),
        ).fetchone()

    deribit: dict[str, Any] = {}
    status = "PASS"
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(
                "https://www.deribit.com/api/v2/public/get_book_summary_by_currency",
                params={"currency": "BTC", "kind": "option"},
            )
            resp.raise_for_status()
            result = resp.json().get("result") or []
            total_oi = 0.0
            total_volume = 0.0
            for item in result:
                total_oi += _safe_float(item.get("open_interest"))
                # Deribit book summary volume is typically 24h volume in contracts.
                total_volume += _safe_float(item.get("volume"))
            deribit = {
                "instrument_count": len(result),
                "total_open_interest_contracts": total_oi,
                "total_volume_24h_contracts": total_volume,
                "source": "public/get_book_summary_by_currency kind=option",
            }
    except Exception as exc:  # noqa: BLE001
        deribit = {"error": f"{type(exc).__name__}: {exc}"}
        status = "FLAG"

    volume_pct = None
    oi_fraction = None
    if deribit.get("total_volume_24h_contracts"):
        volume_pct = _pct(our_24h_single_leg_contracts, float(deribit["total_volume_24h_contracts"]))
    if deribit.get("total_open_interest_contracts"):
        oi_fraction = our_abs_net_gex_live / float(deribit["total_open_interest_contracts"])

    return {
        "status": status,
        "caveat": (
            "Rough order-of-magnitude only. Our inventory is flow-netted dealer "
            "position (path-dependent), not OI. Volume comparison uses raw single-leg "
            "amount sums vs Deribit book-summary 24h volume field."
        ),
        "window_24h": {
            "start_ms": start_24h,
            "end_ms": max_ts,
            "start_utc": _iso_ms(start_24h),
            "end_utc": _iso_ms(max_ts),
            "our_single_leg_contracts": our_24h_single_leg_contracts,
            "our_single_leg_trades": our_24h_single_leg_trades,
            "our_all_contracts": float(total_24h[0] or 0.0),
            "our_all_trades": int(total_24h[1] or 0),
        },
        "our_abs_net_contracts_include_in_gex_inventory": our_abs_net,
        "our_abs_net_contracts_live_gex_instruments": our_abs_net_gex_live,
        "our_snapshot_open_interest_sum": our_snapshot_oi,
        "deribit_public": deribit,
        "our_24h_single_leg_volume_as_pct_of_deribit_24h_volume": volume_pct,
        "our_abs_net_as_fraction_of_deribit_oi": oi_fraction,
    }


# ---------------------------------------------------------------------------
# Tier 2.3 — formula confirmation
# ---------------------------------------------------------------------------


def diagnose_formula_confirmation(
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
) -> dict[str, Any]:
    artifacts = Path(artifacts_dir)
    top = load_top_strikes_by_abs_net_gex(artifacts, snapshot_path, limit=1)
    top_strike = top[0]["strike"] if top else None
    gex_rows = _load_csv(artifacts / "gex" / "gex_by_instrument.csv")
    example_row = None
    if top_strike is not None:
        candidates = [r for r in gex_rows if float(r["strike"]) == float(top_strike)]
        if candidates:
            example_row = max(candidates, key=lambda r: abs(float(r["dollar_gamma_per_1pct"])))
    if example_row is None and gex_rows:
        example_row = max(gex_rows, key=lambda r: abs(float(r["dollar_gamma_per_1pct"])))

    worked = None
    if example_row is not None:
        net = float(example_row["net_contracts"])
        mult = float(example_row["contract_multiplier"])
        gamma = float(example_row["gamma"])
        spot = float(example_row["spot_price"])
        position_gamma = net * mult * gamma
        dollar = position_gamma * (spot**2) * 0.01
        stored = float(example_row["dollar_gamma_per_1pct"])
        worked = {
            "instrument_name": example_row["instrument_name"],
            "strike": float(example_row["strike"]),
            "option_type": example_row["option_type"],
            "net_contracts": net,
            "contract_multiplier": mult,
            "gamma": gamma,
            "spot_price": spot,
            "position_gamma": position_gamma,
            "computed_dollar_gamma_per_1pct": dollar,
            "stored_dollar_gamma_per_1pct": stored,
            "matches_stored": math.isclose(dollar, stored, rel_tol=1e-9, abs_tol=1e-6),
            "formula": "position_gamma = net_contracts * contract_multiplier * gamma; dollar_gamma_per_1pct = position_gamma * spot^2 * 0.01",
        }

    unit_test_example = {
        "description": "tests/test_gex_engine.py call leg",
        "net_contracts": 2.0,
        "multiplier": 1.0,
        "gamma": 0.0002,
        "spot": 100000.0,
        "expected_dollar_gex": 40000.0,
        "arithmetic": "2 * 1 * 0.0002 * (100000**2) * 0.01 = 40000",
    }

    return {
        "status": "PASS" if worked and worked["matches_stored"] else "FAIL",
        "source_file": "project/greeks/gex_engine.py",
        "source_lines": "59-60",
        "code": [
            "position_gamma = row.net_contracts * row.contract_multiplier * greek.gamma",
            "dollar_gamma_per_1pct = position_gamma * (greek.spot_price**2) * 0.01",
        ],
        "uses_s_squared_times_0_01": True,
        "convention": "USD GEX per 1% move (S^2 * 0.01)",
        "methodology_version": "phase4.gex.v1",
        "put_sign_flip": False,
        "sign_source": "dealer net_contracts from taker-flow mirror only",
        "top_strike": top_strike,
        "worked_example": worked,
        "unit_test_reference": unit_test_example,
    }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_framework(
    *,
    db_path: str | Path,
    artifacts_dir: str | Path,
    snapshot_path: str | Path,
    output_dir: str | Path,
    jump_threshold: float = 50.0,
    low_volume_fraction: float = 0.20,
    gap_hours: float = 2.0,
    run_fresh_materialize: bool = True,
    run_full_determinism: bool = True,
    run_second_full_replay: bool = False,
) -> dict[str, Any]:
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    report: dict[str, Any] = {
        "generated_at_utc": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "db_path": str(db_path),
        "artifacts_dir": str(artifacts_dir),
        "snapshot_path": str(snapshot_path),
        "parameters": {
            "jump_threshold": jump_threshold,
            "low_volume_fraction": low_volume_fraction,
            "gap_hours": gap_hours,
            "run_fresh_materialize": run_fresh_materialize,
            "run_full_determinism": run_full_determinism,
            "run_second_full_replay": run_second_full_replay,
        },
        "checks": {},
    }

    print("[1/7] Tier 1.1 coverage & gaps...")
    coverage = diagnose_coverage_and_gaps(
        db_path,
        low_volume_fraction=low_volume_fraction,
        gap_hours=gap_hours,
    )
    report["checks"]["tier1_coverage_gaps"] = coverage
    _write_partial(out, report)

    print("[2/7] Tier 1.2 inventory paths for top GEX strikes...")
    paths = diagnose_inventory_paths(
        db_path,
        artifacts_dir,
        snapshot_path,
        jump_threshold=jump_threshold,
    )
    report["checks"]["tier1_inventory_paths"] = paths
    _write_partial(out, report)

    print("[3/7] Tier 1.4 excluded volume + block sensitivity...")
    excluded = diagnose_excluded_volume(
        db_path,
        artifacts_dir,
        snapshot_path,
        coverage,
    )
    report["checks"]["tier1_excluded_volume"] = excluded
    _write_partial(out, report)

    print("[4/7] Tier 2.2 scale sanity vs Deribit public...")
    scale = diagnose_scale_sanity(db_path, artifacts_dir, snapshot_path)
    report["checks"]["tier2_scale_sanity"] = scale
    _write_partial(out, report)

    print("[5/7] Tier 2.3 formula confirmation...")
    formula = diagnose_formula_confirmation(artifacts_dir, snapshot_path)
    report["checks"]["tier2_formula_confirmation"] = formula
    _write_partial(out, report)

    # Shared full lightweight rematerialize (disk-safe; one YTD pass reused by
    # integrity + determinism to avoid triple full replays).
    shared_full: dict[str, Any] | None = None
    if run_fresh_materialize or run_full_determinism:
        print("[6/7] Shared full lightweight YTD rematerialize (integrity + determinism)...")
        shared_full = _run_shared_full_materialize(
            db_path=db_path,
            artifacts_dir=artifacts_dir,
            output_dir=out,
        )
        report["shared_full_materialize"] = {
            k: shared_full[k]
            for k in ("status", "error", "elapsed_seconds", "materialization", "inventory_sha256")
            if k in shared_full
        }
        _write_partial(out, report)

    print("[6b/7] Tier 1.3 materialization / Greeks integrity...")
    integrity = diagnose_materialization_integrity(
        db_path,
        artifacts_dir,
        snapshot_path,
        out,
        run_fresh_materialize=False,
        shared_full=shared_full if run_fresh_materialize else None,
    )
    report["checks"]["tier1_materialization_integrity"] = integrity
    _write_partial(out, report)

    print("[7/7] Tier 2.1 replay determinism / checkpoint fidelity...")
    determinism = diagnose_replay_determinism(
        db_path,
        artifacts_dir,
        snapshot_path,
        out,
        run_full_replay=False,
        shared_full=shared_full if run_full_determinism else None,
        run_second_full=run_second_full_replay,
    )
    report["checks"]["tier2_replay_determinism"] = determinism

    report["elapsed_seconds"] = round(time.time() - started, 3)
    report["scorecard"] = {
        key: value.get("status", "UNKNOWN") for key, value in report["checks"].items()
    }
    # Promote lag count into top-level diagnostics for operator dashboards.
    integrity = report["checks"].get("tier1_materialization_integrity") or {}
    ckpt_lag = integrity.get("checkpoint_vs_live_inventory") or {}
    report["checkpoint_inventory_lag"] = {
        "lag_count": ckpt_lag.get("lag_count"),
        "positions_sha_match": ckpt_lag.get("positions_sha_match"),
        "warn_threshold": ckpt_lag.get("warn_threshold"),
        "exceeded_warn_threshold": ckpt_lag.get("exceeded_warn_threshold"),
        "checkpoint_positions_sha256": ckpt_lag.get("checkpoint_positions_sha256"),
        "live_inventory_sha256": ckpt_lag.get("live_inventory_sha256"),
    }
    _write_partial(out, report)
    return report


def _run_shared_full_materialize(
    *,
    db_path: str | Path,
    artifacts_dir: str | Path,
    output_dir: str | Path,
) -> dict[str, Any]:
    artifacts = Path(artifacts_dir)
    out = Path(output_dir)
    fresh_dir = out / "fresh_materialize"
    fresh_snapshot = out / "fresh_latest_gex_snapshot.json"
    frozen = artifacts / "gex" / "greeks_snapshot.json"
    t0 = time.time()
    try:
        result = materialize_dashboard_snapshot(
            db_path=db_path,
            artifacts_dir=fresh_dir,
            snapshot_path=fresh_snapshot,
            greeks_json=frozen if frozen.exists() else None,
            lightweight=True,
            mode="full",
            write_inventory_checkpoint=False,
            fail_on_empty=False,
            strict_instrument_lookup=False,
        )
        inv = {
            row["instrument_name"]: float(row["net_contracts"])
            for row in _load_csv(fresh_dir / "inventory_snapshot.csv")
        }
        return {
            "status": "PASS",
            "elapsed_seconds": round(time.time() - t0, 3),
            "materialization": result.to_dict(),
            "inventory": inv,
            "inventory_sha256": inventory_map_sha256(inv),
            "artifacts_dir": str(fresh_dir),
            "snapshot_path": str(fresh_snapshot),
            "snapshot_sha256": (
                hashlib.sha256(fresh_snapshot.read_bytes()).hexdigest()
                if fresh_snapshot.exists()
                else None
            ),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "FAIL",
            "elapsed_seconds": round(time.time() - t0, 3),
            "error": f"{type(exc).__name__}: {exc}",
        }


def _write_partial(out: Path, report: dict[str, Any]) -> None:
    path = out / "framework_diagnostics.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
