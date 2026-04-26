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

    def replay(self, events: Iterable[NormalizedTradeEvent]) -> LedgerReplayResult:
        ordered = sorted(events, key=lambda e: (e.trade_seq, e.ts_ms, e.event_id))
        positions: dict[str, Decimal] = defaultdict(lambda: ZERO)
        position_deltas: list[PositionDelta] = []
        snapshots: list[InventorySnapshot] = [self._snapshot("genesis", 0, -1, positions)]
        applied_event_count = 0

        for event in ordered:
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

            if applied and applied_event_count % self.policy.snapshot_every == 0:
                snapshots.append(
                    self._snapshot(
                        snapshot_id=f"trade-seq-{event.trade_seq}",
                        ts_ms=event.ts_ms,
                        last_trade_seq=event.trade_seq,
                        positions=positions,
                    )
                )

        final_trade_seq = ordered[-1].trade_seq if ordered else -1
        final_ts_ms = ordered[-1].ts_ms if ordered else 0

        if snapshots[-1].last_trade_seq != final_trade_seq:
            snapshots.append(
                self._snapshot(
                    snapshot_id="final",
                    ts_ms=final_ts_ms,
                    last_trade_seq=final_trade_seq,
                    positions=positions,
                )
            )

        delta_dicts = [record.to_dict() for record in position_deltas]
        snapshot_dicts = [record.to_dict() for record in snapshots]

        manifest = {
            "methodology_version": self.policy.methodology_version,
            "input_event_count": len(ordered),
            "applied_event_count": applied_event_count,
            "excluded_event_count": len(ordered) - applied_event_count,
            "position_delta_count": len(position_deltas),
            "snapshot_count": len(snapshots),
            "final_trade_seq": final_trade_seq,
            "final_nonzero_position_count": len(_pruned_positions(dict(positions))),
            "position_deltas_sha256": _canonical_sha256(delta_dicts),
            "snapshots_sha256": _canonical_sha256(snapshot_dicts),
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
