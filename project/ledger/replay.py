from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
import hashlib
import json
from typing import Any, Iterable

from ledger.models import InventorySnapshot, NormalizedTradeEvent, PositionDelta
from ledger.rules import LedgerPolicy, classify_event, dealer_position_delta

ZERO = Decimal("0")
DUST = Decimal("0.0000000001")


def _canonical_sha256(records: list[dict[str, Any]]) -> str:
    payload = "\n".join(
        json.dumps(record, sort_keys=True, separators=(",", ":")) for record in records
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _pruned_positions(positions: dict[str, Decimal]) -> dict[str, Decimal]:
    cleaned: dict[str, Decimal] = {}
    for instrument, position in sorted(positions.items()):
        if abs(position) > DUST:
            cleaned[instrument] = position
    return cleaned


@dataclass(frozen=True, slots=True)
class LedgerReplayResult:
    position_deltas: list[PositionDelta]
    snapshots: list[InventorySnapshot]
    manifest: dict[str, Any]


class LedgerReplayer:
    def __init__(self, policy: LedgerPolicy | None = None) -> None:
        self.policy = policy or LedgerPolicy()

    def replay(
        self,
        events: Iterable[NormalizedTradeEvent],
        *,
        retain_deltas: bool = True,
        retain_intermediate_snapshots: bool = True,
        initial_positions: dict[str, Decimal] | None = None,
        prior_input_event_count: int = 0,
        prior_applied_event_count: int = 0,
        prior_excluded_event_count: int = 0,
        prior_final_trade_seq: int = -1,
        prior_final_ts_ms: int = 0,
    ) -> LedgerReplayResult:
        """Replay dealer inventory.

        For Phase 6 live rematerialization of multi-million trade histories, set
        ``retain_deltas=False`` and ``retain_intermediate_snapshots=False`` to keep
        only genesis + final inventory snapshots (methodology-identical positions).

        ``initial_positions`` enables incremental replay from a prior checkpoint.
        Inventory is per-instrument, so appending only new events to a checkpoint
        yields the same final positions as a full replay (same methodology).
        """
        ordered = sorted(events, key=lambda e: (e.trade_seq, e.ts_ms, e.event_id))
        positions: dict[str, Decimal] = defaultdict(lambda: ZERO)
        if initial_positions:
            for instrument, position in initial_positions.items():
                if abs(position) > DUST:
                    positions[instrument] = position

        position_deltas: list[PositionDelta] = []
        # Incremental: seed "checkpoint" as the starting inventory snapshot.
        if initial_positions is not None:
            snapshots: list[InventorySnapshot] = [
                self._snapshot(
                    "checkpoint",
                    prior_final_ts_ms,
                    prior_final_trade_seq,
                    positions,
                )
            ]
        else:
            snapshots = [self._snapshot("genesis", 0, -1, positions)]
        applied_event_count = 0
        input_event_count = 0
        excluded_event_count = 0

        for event in ordered:
            input_event_count += 1
            applied, exclusion_reason = classify_event(event, self.policy)
            current_position = positions.get(event.inventory_key, ZERO)
            delta = ZERO
            after = current_position

            if applied:
                delta = dealer_position_delta(event)
                after = current_position + delta

                if abs(after) <= DUST:
                    positions.pop(event.inventory_key, None)
                    after = ZERO
                else:
                    positions[event.inventory_key] = after

                applied_event_count += 1
            else:
                excluded_event_count += 1

            if retain_deltas:
                position_deltas.append(
                    PositionDelta(
                        event_id=event.event_id,
                        source_trade_id=event.source_trade_id,
                        trade_seq=event.trade_seq,
                        ts_ms=event.ts_ms,
                        instrument_name=event.instrument_name,
                        taker_side=event.taker_side,
                        dealer_position_delta=delta,
                        dealer_position_after=after,
                        applied=applied,
                        exclusion_reason=exclusion_reason,
                        normalization_version=event.normalization_version,
                        methodology_version=self.policy.methodology_version,
                    )
                )

            if (
                retain_intermediate_snapshots
                and applied
                and applied_event_count % self.policy.snapshot_every == 0
            ):
                snapshots.append(
                    self._snapshot(
                        snapshot_id=f"trade-seq-{event.trade_seq}",
                        ts_ms=event.ts_ms,
                        last_trade_seq=event.trade_seq,
                        positions=positions,
                    )
                )

        if ordered:
            final_trade_seq = ordered[-1].trade_seq
            final_ts_ms = ordered[-1].ts_ms
        else:
            final_trade_seq = prior_final_trade_seq
            final_ts_ms = prior_final_ts_ms

        # Emit a terminal snapshot when the last retained snapshot is not current.
        # Incremental no-op (no new events) still gets an explicit "final" so the
        # live path always selects a stable snapshot_id.
        needs_final = snapshots[-1].last_trade_seq != final_trade_seq
        if initial_positions is not None and snapshots[-1].snapshot_id != "final":
            needs_final = True
        if needs_final:
            snapshots.append(
                self._snapshot(
                    snapshot_id="final",
                    ts_ms=final_ts_ms,
                    last_trade_seq=final_trade_seq,
                    positions=positions,
                )
            )

        delta_dicts = [record.to_dict() for record in position_deltas] if retain_deltas else []
        snapshot_dicts = [record.to_dict() for record in snapshots]
        position_delta_count = len(position_deltas) if retain_deltas else input_event_count

        if retain_deltas:
            deltas_hash = _canonical_sha256(delta_dicts)
        else:
            # Lightweight live path intentionally omits delta artifacts.
            deltas_hash = "0" * 64

        total_input = prior_input_event_count + input_event_count
        total_applied = prior_applied_event_count + applied_event_count
        total_excluded = prior_excluded_event_count + excluded_event_count

        manifest = {
            "methodology_version": self.policy.methodology_version,
            "input_event_count": total_input,
            "applied_event_count": total_applied,
            "excluded_event_count": total_excluded,
            "batch_input_event_count": input_event_count,
            "batch_applied_event_count": applied_event_count,
            "batch_excluded_event_count": excluded_event_count,
            "position_delta_count": (
                position_delta_count if retain_deltas else total_input
            ),
            "snapshot_count": len(snapshots),
            "final_trade_seq": final_trade_seq,
            "final_nonzero_position_count": len(_pruned_positions(dict(positions))),
            "position_deltas_sha256": deltas_hash,
            "snapshots_sha256": _canonical_sha256(snapshot_dicts),
            "incremental": initial_positions is not None,
        }

        return LedgerReplayResult(
            position_deltas=position_deltas,
            snapshots=snapshots,
            manifest=manifest,
        )

    def _snapshot(
        self,
        snapshot_id: str,
        ts_ms: int,
        last_trade_seq: int,
        positions: dict[str, Decimal],
    ) -> InventorySnapshot:
        return InventorySnapshot(
            snapshot_id=snapshot_id,
            ts_ms=ts_ms,
            last_trade_seq=last_trade_seq,
            positions=_pruned_positions(dict(positions)),
            methodology_version=self.policy.methodology_version,
        )
