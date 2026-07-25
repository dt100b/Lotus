from __future__ import annotations

import unittest
from decimal import Decimal

from ledger.models import NormalizedTradeEvent
from ledger.replay import LedgerReplayer
from ledger.rules import LedgerPolicy


class Phase3LedgerTests(unittest.TestCase):
    def make_event(self, **overrides: object) -> NormalizedTradeEvent:
        payload = {
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
        return NormalizedTradeEvent.from_dict(payload)

    def test_taker_buy_and_sell_apply_mirror_rule(self) -> None:
        events = [
            self.make_event(
                event_id="evt-1",
                source_trade_id="raw-1",
                trade_seq=1,
                amount="2",
                taker_side="buy",
            ),
            self.make_event(
                event_id="evt-2",
                source_trade_id="raw-2",
                trade_seq=2,
                amount="1",
                taker_side="sell",
            ),
        ]

        result = LedgerReplayer(
            LedgerPolicy(snapshot_every=100, methodology_version="phase3.test")
        ).replay(events)

        first, second = result.position_deltas
        self.assertEqual(first.dealer_position_delta, Decimal("-2"))
        self.assertEqual(first.dealer_position_after, Decimal("-2"))
        self.assertEqual(second.dealer_position_delta, Decimal("1"))
        self.assertEqual(second.dealer_position_after, Decimal("-1"))

    def test_include_otc_policy_applies_block_and_combo_trades(self) -> None:
        from ledger.rules import include_otc_ledger_policy, production_ledger_policy

        events = [
            self.make_event(
                event_id="evt-1",
                source_trade_id="raw-1",
                trade_seq=1,
                amount="2",
                taker_side="buy",
            ),
            self.make_event(
                event_id="evt-2",
                source_trade_id="raw-2",
                trade_seq=2,
                amount="5",
                taker_side="sell",
                is_block_trade=True,
            ),
            self.make_event(
                event_id="evt-3",
                source_trade_id="raw-3",
                trade_seq=3,
                amount="1",
                taker_side="buy",
                is_combo_trade=True,
                is_single_leg=False,
            ),
        ]

        prod = LedgerReplayer(production_ledger_policy(methodology_version="phase3.test")).replay(
            events
        )
        otc = LedgerReplayer(include_otc_ledger_policy()).replay(events)

        # Production: only the listed single-leg taker buy (−2).
        self.assertEqual(
            prod.snapshots[-1].positions.get("BTC-26APR26-90000-C"),
            Decimal("-2"),
        )
        self.assertEqual(prod.manifest["applied_event_count"], 1)
        # Include-OTC: buy −2, block sell +5, combo buy −1 → net +2.
        self.assertEqual(
            otc.snapshots[-1].positions.get("BTC-26APR26-90000-C"),
            Decimal("2"),
        )
        self.assertEqual(otc.manifest["applied_event_count"], 3)

    def test_block_and_combo_trades_are_auditable_but_not_applied(self) -> None:
        events = [
            self.make_event(
                event_id="evt-1",
                source_trade_id="raw-1",
                trade_seq=1,
                amount="3",
                taker_side="sell",
            ),
            self.make_event(
                event_id="evt-2",
                source_trade_id="raw-2",
                trade_seq=2,
                is_block_trade=True,
            ),
            self.make_event(
                event_id="evt-3",
                source_trade_id="raw-3",
                trade_seq=3,
                is_combo_trade=True,
            ),
        ]

        result = LedgerReplayer(
            LedgerPolicy(snapshot_every=100, methodology_version="phase3.test")
        ).replay(events)

        applied, block, combo = result.position_deltas
        self.assertTrue(applied.applied)
        self.assertEqual(applied.dealer_position_after, Decimal("3"))

        self.assertFalse(block.applied)
        self.assertEqual(block.exclusion_reason, "block_trade")
        self.assertEqual(block.dealer_position_delta, Decimal("0"))
        self.assertEqual(block.dealer_position_after, Decimal("3"))

        self.assertFalse(combo.applied)
        self.assertEqual(combo.exclusion_reason, "combo_trade")
        self.assertEqual(combo.dealer_position_delta, Decimal("0"))
        self.assertEqual(combo.dealer_position_after, Decimal("3"))

    def test_replay_is_deterministic(self) -> None:
        events = [
            self.make_event(
                event_id="evt-3",
                source_trade_id="raw-3",
                trade_seq=3,
                amount="1",
                taker_side="sell",
            ),
            self.make_event(
                event_id="evt-1",
                source_trade_id="raw-1",
                trade_seq=1,
                amount="2",
                taker_side="buy",
            ),
            self.make_event(
                event_id="evt-2",
                source_trade_id="raw-2",
                trade_seq=2,
                amount="1",
                taker_side="sell",
            ),
        ]
        policy = LedgerPolicy(snapshot_every=1, methodology_version="phase3.test")

        result_a = LedgerReplayer(policy).replay(events)
        result_b = LedgerReplayer(policy).replay(list(reversed(events)))

        self.assertEqual(
            result_a.manifest["position_deltas_sha256"],
            result_b.manifest["position_deltas_sha256"],
        )
        self.assertEqual(
            result_a.manifest["snapshots_sha256"],
            result_b.manifest["snapshots_sha256"],
        )
        self.assertEqual(
            result_a.snapshots[-1].positions,
            result_b.snapshots[-1].positions,
        )


if __name__ == "__main__":
    unittest.main()
