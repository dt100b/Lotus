"""Durable dealer-inventory checkpoints for Phase 6 live rematerialization.

Full-history normalize + ledger replay is O(N) in cumulative trades. Live ops
only need the final inventory book, so we persist that book after each
successful materialize and apply only newly ingested trades on subsequent
cycles. Methodology (taker-flow mirror rule) is unchanged; Phase 1 raw trades
remain the immutable source of truth and a full rebuild always remains valid.

Ops hygiene: after every successful materialize the checkpoint positions map
must match the serving ``inventory_snapshot.csv`` (same instruments/nets,
recomputed ``positions_sha256``). Atomic temp+rename writes avoid partial books.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
import csv
import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from ledger.models import decimal_to_str, to_decimal

CHECKPOINT_VERSION = "phase6.inventory_checkpoint.v1"
DEFAULT_CHECKPOINT_NAME = "inventory_checkpoint.json"
DEFAULT_INVENTORY_CSV_NAME = "inventory_snapshot.csv"
# Secondary include-OTC path artifacts (must never overwrite production names).
INCLUDE_OTC_CHECKPOINT_NAME = "inventory_checkpoint_with_blocks.json"
INCLUDE_OTC_INVENTORY_CSV_NAME = "inventory_snapshot_with_blocks.csv"
# Soft ops alert when checkpoint positions diverge from serving inventory.
DEFAULT_CHECKPOINT_LAG_WARN_THRESHOLD = 50
# Hard fail threshold (None = never raise from the lag monitor alone).
DEFAULT_CHECKPOINT_LAG_RAISE_THRESHOLD: int | None = None
_DUST = Decimal("0.0000000001")
_ABS_TOL = Decimal("0.000000001")

logger = logging.getLogger(__name__)


def _pruned_positions(positions: dict[str, Decimal]) -> dict[str, Decimal]:
    return {
        instrument: position
        for instrument, position in sorted(positions.items())
        if abs(position) > _DUST
    }


@dataclass(frozen=True, slots=True)
class InventoryCheckpoint:
    checkpoint_version: str
    normalization_version: str
    ledger_methodology_version: str
    gex_methodology_version: str
    raw_trade_count: int
    raw_instrument_count: int
    max_timestamp_ms: int
    last_trade_seq: int
    final_ts_ms: int
    input_event_count: int
    applied_event_count: int
    excluded_event_count: int
    positions: dict[str, Decimal]
    instrument_cursors: dict[str, int]
    positions_sha256: str
    created_at_utc: str

    def to_dict(self) -> dict[str, Any]:
        pruned = _pruned_positions(dict(self.positions))
        return {
            "checkpoint_version": self.checkpoint_version,
            "normalization_version": self.normalization_version,
            "ledger_methodology_version": self.ledger_methodology_version,
            "gex_methodology_version": self.gex_methodology_version,
            "raw_trade_count": int(self.raw_trade_count),
            "raw_instrument_count": int(self.raw_instrument_count),
            "max_timestamp_ms": int(self.max_timestamp_ms),
            "last_trade_seq": int(self.last_trade_seq),
            "final_ts_ms": int(self.final_ts_ms),
            "input_event_count": int(self.input_event_count),
            "applied_event_count": int(self.applied_event_count),
            "excluded_event_count": int(self.excluded_event_count),
            "positions": {
                name: decimal_to_str(pos) for name, pos in sorted(pruned.items())
            },
            "instrument_cursors": {
                name: int(seq)
                for name, seq in sorted(self.instrument_cursors.items())
            },
            "positions_sha256": self.positions_sha256,
            "created_at_utc": self.created_at_utc,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "InventoryCheckpoint":
        positions = {
            str(name): to_decimal(value)
            for name, value in dict(payload.get("positions") or {}).items()
        }
        cursors = {
            str(name): int(seq)
            for name, seq in dict(payload.get("instrument_cursors") or {}).items()
        }
        return cls(
            checkpoint_version=str(payload.get("checkpoint_version", "")),
            normalization_version=str(payload.get("normalization_version", "")),
            ledger_methodology_version=str(
                payload.get("ledger_methodology_version", "")
            ),
            gex_methodology_version=str(payload.get("gex_methodology_version", "")),
            raw_trade_count=int(payload.get("raw_trade_count", 0)),
            raw_instrument_count=int(payload.get("raw_instrument_count", 0)),
            max_timestamp_ms=int(payload.get("max_timestamp_ms", 0)),
            last_trade_seq=int(payload.get("last_trade_seq", -1)),
            final_ts_ms=int(payload.get("final_ts_ms", 0)),
            input_event_count=int(payload.get("input_event_count", 0)),
            applied_event_count=int(payload.get("applied_event_count", 0)),
            excluded_event_count=int(payload.get("excluded_event_count", 0)),
            positions=positions,
            instrument_cursors=cursors,
            positions_sha256=str(payload.get("positions_sha256", "")),
            created_at_utc=str(payload.get("created_at_utc", "")),
        )


def checkpoint_path(artifacts_dir: str | Path) -> Path:
    return Path(artifacts_dir) / DEFAULT_CHECKPOINT_NAME


def include_otc_checkpoint_path(artifacts_dir: str | Path) -> Path:
    """Checkpoint for the include-blocks/combo (OTC) ledger path only."""
    return Path(artifacts_dir) / INCLUDE_OTC_CHECKPOINT_NAME


def include_otc_inventory_csv_path(artifacts_dir: str | Path) -> Path:
    """Inventory CSV for the include-OTC path; never the production snapshot name."""
    return Path(artifacts_dir) / INCLUDE_OTC_INVENTORY_CSV_NAME


def load_checkpoint(path: str | Path) -> InventoryCheckpoint | None:
    target = Path(path)
    if not target.exists():
        return None
    payload = json.loads(target.read_text(encoding="utf-8"))
    checkpoint = InventoryCheckpoint.from_dict(payload)
    expected = positions_sha256(checkpoint.positions)
    if checkpoint.positions_sha256 and checkpoint.positions_sha256 != expected:
        raise ValueError(
            f"Inventory checkpoint positions hash mismatch at {target}: "
            f"stored={checkpoint.positions_sha256} computed={expected}"
        )
    return checkpoint


def write_checkpoint(path: str | Path, checkpoint: InventoryCheckpoint) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Atomic replace so a crashed writer cannot leave a half-written book.
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(
        json.dumps(checkpoint.to_dict(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp.replace(target)
    return target


def build_checkpoint(
    *,
    normalization_version: str,
    ledger_methodology_version: str,
    gex_methodology_version: str,
    raw_trade_count: int,
    raw_instrument_count: int,
    max_timestamp_ms: int,
    last_trade_seq: int,
    final_ts_ms: int,
    input_event_count: int,
    applied_event_count: int,
    excluded_event_count: int,
    positions: dict[str, Decimal],
    instrument_cursors: dict[str, int],
) -> InventoryCheckpoint:
    pruned = _pruned_positions(dict(positions))
    return InventoryCheckpoint(
        checkpoint_version=CHECKPOINT_VERSION,
        normalization_version=normalization_version,
        ledger_methodology_version=ledger_methodology_version,
        gex_methodology_version=gex_methodology_version,
        raw_trade_count=raw_trade_count,
        raw_instrument_count=raw_instrument_count,
        max_timestamp_ms=max_timestamp_ms,
        last_trade_seq=last_trade_seq,
        final_ts_ms=final_ts_ms,
        input_event_count=input_event_count,
        applied_event_count=applied_event_count,
        excluded_event_count=excluded_event_count,
        positions=pruned,
        instrument_cursors=dict(instrument_cursors),
        positions_sha256=positions_sha256(pruned),
        created_at_utc=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    )


def positions_sha256(positions: dict[str, Decimal]) -> str:
    pruned = _pruned_positions(dict(positions))
    payload = json.dumps(
        {name: decimal_to_str(pos) for name, pos in sorted(pruned.items())},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def inventory_csv_path(artifacts_dir: str | Path) -> Path:
    return Path(artifacts_dir) / DEFAULT_INVENTORY_CSV_NAME


def load_positions_from_inventory_csv(path: str | Path) -> dict[str, Decimal]:
    """Load serving inventory positions from ``inventory_snapshot.csv``.

    Zero / dust rows are dropped so the map matches checkpoint pruning.
    """
    target = Path(path)
    if not target.exists():
        raise FileNotFoundError(f"Inventory snapshot CSV not found: {target}")

    positions: dict[str, Decimal] = {}
    with target.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            name = str(row.get("instrument_name") or "").strip()
            if not name:
                continue
            net = to_decimal(row.get("net_contracts", "0"))
            if abs(net) <= _DUST:
                continue
            positions[name] = net
    return _pruned_positions(positions)


def positions_from_inventory_rows(
    rows: list[Any],
) -> dict[str, Decimal]:
    """Build a pruned positions map from enriched inventory row objects/dicts."""
    positions: dict[str, Decimal] = {}
    for row in rows:
        if isinstance(row, dict):
            name = str(row.get("instrument_name") or "")
            net = to_decimal(row.get("net_contracts", "0"))
        else:
            name = str(getattr(row, "instrument_name"))
            net = to_decimal(getattr(row, "net_contracts"))
        if not name:
            continue
        if abs(net) <= _DUST:
            continue
        positions[name] = net
    return _pruned_positions(positions)


@dataclass(frozen=True, slots=True)
class CheckpointInventoryLag:
    """Instrument-level divergence between checkpoint and serving inventory."""

    delta_count: int
    checkpoint_position_count: int
    inventory_position_count: int
    checkpoint_positions_sha256: str | None
    inventory_positions_sha256: str
    positions_sha_match: bool
    mismatches: list[dict[str, Any]] = field(default_factory=list)
    checkpoint_present: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "checkpoint_present": self.checkpoint_present,
            "delta_count": self.delta_count,
            "checkpoint_position_count": self.checkpoint_position_count,
            "inventory_position_count": self.inventory_position_count,
            "checkpoint_positions_sha256": self.checkpoint_positions_sha256,
            "inventory_positions_sha256": self.inventory_positions_sha256,
            "positions_sha_match": self.positions_sha_match,
            "mismatches": list(self.mismatches),
        }


def compare_checkpoint_to_inventory(
    checkpoint: InventoryCheckpoint | None,
    inventory_positions: dict[str, Decimal],
    *,
    max_examples: int = 50,
    abs_tol: Decimal = _ABS_TOL,
) -> CheckpointInventoryLag:
    """Count instrument deltas between checkpoint positions and inventory map."""
    inv = _pruned_positions(dict(inventory_positions))
    inv_sha = positions_sha256(inv)

    if checkpoint is None:
        # Every inventory row is a lag if there is no checkpoint at all.
        examples = [
            {
                "instrument_name": name,
                "checkpoint": "0",
                "inventory": decimal_to_str(net),
                "delta": decimal_to_str(net),
            }
            for name, net in list(inv.items())[:max_examples]
        ]
        return CheckpointInventoryLag(
            delta_count=len(inv),
            checkpoint_position_count=0,
            inventory_position_count=len(inv),
            checkpoint_positions_sha256=None,
            inventory_positions_sha256=inv_sha,
            positions_sha_match=False,
            mismatches=examples,
            checkpoint_present=False,
        )

    ckpt = _pruned_positions(dict(checkpoint.positions))
    ckpt_sha = checkpoint.positions_sha256 or positions_sha256(ckpt)
    mismatches: list[dict[str, Any]] = []
    delta_count = 0
    for name in sorted(set(ckpt) | set(inv)):
        left = ckpt.get(name, Decimal("0"))
        right = inv.get(name, Decimal("0"))
        if abs(left - right) <= abs_tol:
            continue
        delta_count += 1
        if len(mismatches) < max_examples:
            mismatches.append(
                {
                    "instrument_name": name,
                    "checkpoint": decimal_to_str(left),
                    "inventory": decimal_to_str(right),
                    "delta": decimal_to_str(right - left),
                }
            )

    return CheckpointInventoryLag(
        delta_count=delta_count,
        checkpoint_position_count=len(ckpt),
        inventory_position_count=len(inv),
        checkpoint_positions_sha256=ckpt_sha,
        inventory_positions_sha256=inv_sha,
        positions_sha_match=ckpt_sha == inv_sha and delta_count == 0,
        mismatches=mismatches,
        checkpoint_present=True,
    )


def measure_checkpoint_inventory_lag(
    artifacts_dir: str | Path,
    *,
    checkpoint_file: str | Path | None = None,
    inventory_file: str | Path | None = None,
    max_examples: int = 50,
) -> CheckpointInventoryLag:
    """Compare on-disk checkpoint vs serving inventory CSV under an artifacts dir."""
    root = Path(artifacts_dir)
    ckpt_path = Path(checkpoint_file) if checkpoint_file else checkpoint_path(root)
    inv_path = Path(inventory_file) if inventory_file else inventory_csv_path(root)
    checkpoint = load_checkpoint(ckpt_path) if ckpt_path.exists() else None
    inventory_positions = (
        load_positions_from_inventory_csv(inv_path) if inv_path.exists() else {}
    )
    return compare_checkpoint_to_inventory(
        checkpoint,
        inventory_positions,
        max_examples=max_examples,
    )


def rewrite_checkpoint_from_inventory(
    *,
    checkpoint_file: str | Path,
    inventory_csv: str | Path | None = None,
    inventory_positions: dict[str, Decimal] | None = None,
    normalization_version: str,
    ledger_methodology_version: str,
    gex_methodology_version: str,
    raw_trade_count: int,
    raw_instrument_count: int,
    max_timestamp_ms: int,
    last_trade_seq: int,
    final_ts_ms: int,
    input_event_count: int,
    applied_event_count: int,
    excluded_event_count: int,
    instrument_cursors: dict[str, int],
) -> InventoryCheckpoint:
    """Rewrite checkpoint so positions exactly match serving inventory.

    Positions come from ``inventory_positions`` when provided, otherwise from
    the on-disk inventory CSV. Metadata is refreshed to the current materialize.
    Write is atomic (temp file + rename).
    """
    if inventory_positions is None:
        if inventory_csv is None:
            raise ValueError(
                "rewrite_checkpoint_from_inventory requires inventory_csv or inventory_positions"
            )
        positions = load_positions_from_inventory_csv(inventory_csv)
    else:
        positions = _pruned_positions(dict(inventory_positions))

    checkpoint = build_checkpoint(
        normalization_version=normalization_version,
        ledger_methodology_version=ledger_methodology_version,
        gex_methodology_version=gex_methodology_version,
        raw_trade_count=raw_trade_count,
        raw_instrument_count=raw_instrument_count,
        max_timestamp_ms=max_timestamp_ms,
        last_trade_seq=last_trade_seq,
        final_ts_ms=final_ts_ms,
        input_event_count=input_event_count,
        applied_event_count=applied_event_count,
        excluded_event_count=excluded_event_count,
        positions=positions,
        instrument_cursors=instrument_cursors,
    )
    write_checkpoint(checkpoint_file, checkpoint)
    return checkpoint


def evaluate_checkpoint_lag(
    lag: CheckpointInventoryLag,
    *,
    warn_threshold: int = DEFAULT_CHECKPOINT_LAG_WARN_THRESHOLD,
    raise_threshold: int | None = DEFAULT_CHECKPOINT_LAG_RAISE_THRESHOLD,
    context: str = "checkpoint_vs_inventory",
) -> dict[str, Any]:
    """Log and optionally raise when instrument lag exceeds configured thresholds."""
    exceeded_warn = lag.delta_count > warn_threshold
    exceeded_raise = raise_threshold is not None and lag.delta_count > raise_threshold
    if lag.delta_count == 0:
        logger.info(
            "%s: checkpoint aligned with inventory (0 instrument deltas, sha=%s)",
            context,
            lag.inventory_positions_sha256[:12],
        )
    elif exceeded_warn:
        logger.warning(
            "%s: checkpoint lags inventory by %s instrument deltas "
            "(warn_threshold=%s). checkpoint_sha=%s inventory_sha=%s examples=%s",
            context,
            lag.delta_count,
            warn_threshold,
            lag.checkpoint_positions_sha256,
            lag.inventory_positions_sha256,
            lag.mismatches[:5],
        )
    else:
        logger.info(
            "%s: minor checkpoint/inventory lag of %s instrument deltas "
            "(warn_threshold=%s)",
            context,
            lag.delta_count,
            warn_threshold,
        )

    if exceeded_raise:
        raise RuntimeError(
            f"{context}: checkpoint inventory lag {lag.delta_count} exceeds "
            f"raise_threshold={raise_threshold}"
        )

    return {
        **lag.to_dict(),
        "warn_threshold": warn_threshold,
        "raise_threshold": raise_threshold,
        "exceeded_warn_threshold": exceeded_warn,
        "exceeded_raise_threshold": exceeded_raise,
    }


def checkpoint_is_compatible(
    checkpoint: InventoryCheckpoint,
    *,
    normalization_version: str,
    ledger_methodology_version: str,
    gex_methodology_version: str,
    raw_trade_count: int,
) -> tuple[bool, str]:
    if checkpoint.checkpoint_version != CHECKPOINT_VERSION:
        return False, "checkpoint_version_mismatch"
    if checkpoint.normalization_version != normalization_version:
        return False, "normalization_version_mismatch"
    if checkpoint.ledger_methodology_version != ledger_methodology_version:
        return False, "ledger_methodology_version_mismatch"
    if checkpoint.gex_methodology_version != gex_methodology_version:
        return False, "gex_methodology_version_mismatch"
    if raw_trade_count < checkpoint.raw_trade_count:
        return False, "raw_trade_count_regressed"
    return True, "ok"


def merge_instrument_cursors(
    base: dict[str, int],
    events: list[Any],
) -> dict[str, int]:
    """Update per-instrument max trade_seq cursors from ledger/normalized events."""
    cursors = dict(base)
    for event in events:
        name = str(getattr(event, "instrument_name", None) or event["instrument_name"])
        seq = int(getattr(event, "trade_seq", None) or event["trade_seq"])
        prev = cursors.get(name)
        if prev is None or seq > prev:
            cursors[name] = seq
    return cursors


def filter_events_after_cursors(
    events: list[Any],
    cursors: dict[str, int],
) -> list[Any]:
    """Drop events already covered by instrument trade_seq cursors."""
    if not cursors:
        return list(events)
    kept: list[Any] = []
    for event in events:
        name = str(getattr(event, "instrument_name", None) or event["instrument_name"])
        seq = int(getattr(event, "trade_seq", None) or event["trade_seq"])
        prior = cursors.get(name)
        if prior is not None and seq <= prior:
            continue
        kept.append(event)
    return kept
