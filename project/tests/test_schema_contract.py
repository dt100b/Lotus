from __future__ import annotations

import unittest
from decimal import InvalidOperation

from ledger.models import NormalizedTradeEvent
from ledger.replay import LedgerReplayer
from ledger.rules import LedgerPolicy


class SchemaContractTests(unittest.TestCase):
    def make_payload(self, **overrides: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "event_id": "evt-1",
            "source_trade_id": "raw-1",
            "trade_seq": 1,
            "ts_ms": 1_700_000_000_000,
            "venue": "deribit",
            "base_currency": "BTC",
            "kind": "option",
            "instrument_name": "BTC-26APR26-90000-C",
            "option_type": "call",
            "strike": "90000",
            "expiry_ts_ms": 1_714_089_600_000,
            "contract_size": "1",
            "amount": "1",
            "price": "0.05",
            "taker_side": "buy",
            "is_block_trade": False,
            "is_combo_trade": False,
            "is_single_leg": True,
            "normalization_version": "phase2.v1",
        }
        payload.update(overrides)
        return payload

    def test_required_fields_missing_are_rejected(self) -> None:
        payload = self.make_payload()
        del payload["event_id"]
        with self.assertRaises(KeyError):
            NormalizedTradeEvent.from_dict(payload)

    def test_invalid_decimal_fields_are_rejected(self) -> None:
        payload = self.make_payload(amount="not-a-decimal")
        with self.assertRaises(InvalidOperation):
            NormalizedTradeEvent.from_dict(payload)

    def test_replay_orders_by_trade_seq_ts_and_event_id(self) -> None:
        events = [
            NormalizedTradeEvent.from_dict(
                self.make_payload(event_id="evt-3", trade_seq=2, ts_ms=2000, amount="1")
            ),
            NormalizedTradeEvent.from_dict(
                self.make_payload(event_id="evt-2", trade_seq=1, ts_ms=1000, amount="2")
            ),
            NormalizedTradeEvent.from_dict(
                self.make_payload(event_id="evt-1", trade_seq=2, ts_ms=2000, amount="3")
            ),
        ]

        result = LedgerReplayer(LedgerPolicy(methodology_version="phase3.contract")).replay(
            events
        )

        ordered_event_ids = [delta.event_id for delta in result.position_deltas]
        self.assertEqual(ordered_event_ids, ["evt-2", "evt-1", "evt-3"])

    def test_versions_are_present_in_derived_outputs(self) -> None:
        event = NormalizedTradeEvent.from_dict(self.make_payload())
        result = LedgerReplayer(
            LedgerPolicy(snapshot_every=1, methodology_version="phase3.contract")
        ).replay([event])

        delta = result.position_deltas[0].to_dict()
        snapshot = result.snapshots[-1].to_dict()
        manifest = result.manifest

        self.assertEqual(delta["normalization_version"], "phase2.v1")
        self.assertEqual(delta["methodology_version"], "phase3.contract")
        self.assertEqual(snapshot["methodology_version"], "phase3.contract")
        self.assertEqual(manifest["methodology_version"], "phase3.contract")

    def test_position_delta_schema_has_required_keys(self) -> None:
        event = NormalizedTradeEvent.from_dict(self.make_payload())
        result = LedgerReplayer(LedgerPolicy(methodology_version="phase3.contract")).replay(
            [event]
        )

        delta = result.position_deltas[0].to_dict()
        required = {
            "event_id",
            "source_trade_id",
            "trade_seq",
            "ts_ms",
            "instrument_name",
            "taker_side",
            "dealer_position_delta",
            "dealer_position_after",
            "applied",
            "exclusion_reason",
            "normalization_version",
            "methodology_version",
        }
        self.assertEqual(set(delta.keys()), required)
        self.assertEqual(delta["dealer_position_delta"], "-1")
        self.assertEqual(delta["dealer_position_after"], "-1")

    def test_snapshot_schema_has_required_keys(self) -> None:
        event = NormalizedTradeEvent.from_dict(self.make_payload(amount="2"))
        result = LedgerReplayer(
            LedgerPolicy(snapshot_every=1, methodology_version="phase3.contract")
        ).replay([event])

        snapshot = result.snapshots[-1].to_dict()
        required = {
            "snapshot_id",
            "ts_ms",
            "last_trade_seq",
            "positions",
            "methodology_version",
        }
        self.assertEqual(set(snapshot.keys()), required)
        self.assertEqual(snapshot["positions"]["BTC-26APR26-90000-C"], "-2")

    def test_manifest_has_required_keys(self) -> None:
        events = [
            NormalizedTradeEvent.from_dict(self.make_payload(event_id="evt-1", trade_seq=1)),
            NormalizedTradeEvent.from_dict(self.make_payload(event_id="evt-2", trade_seq=2)),
        ]
        result = LedgerReplayer(LedgerPolicy(methodology_version="phase3.contract")).replay(
            events
        )
        manifest = result.manifest
        required = {
            "methodology_version",
            "input_event_count",
            "applied_event_count",
            "excluded_event_count",
            "batch_input_event_count",
            "batch_applied_event_count",
            "batch_excluded_event_count",
            "position_delta_count",
            "snapshot_count",
            "final_trade_seq",
            "final_nonzero_position_count",
            "position_deltas_sha256",
            "snapshots_sha256",
            "incremental",
        }
        self.assertEqual(set(manifest.keys()), required)
        self.assertEqual(manifest["input_event_count"], 2)
        self.assertEqual(manifest["applied_event_count"], 2)
        self.assertEqual(manifest["batch_input_event_count"], 2)
        self.assertFalse(manifest["incremental"])
        self.assertIsInstance(manifest["position_deltas_sha256"], str)
        self.assertEqual(len(manifest["position_deltas_sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
