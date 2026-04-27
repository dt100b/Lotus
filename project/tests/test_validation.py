from __future__ import annotations

import json
from pathlib import Path

from ledger.models import NormalizedTradeEvent
from ledger.replay import LedgerReplayer
from ledger.rules import LedgerPolicy
from pipeline.validation import (
    audit_deribit_trade_payloads,
    validate_expiry_filtering,
    validate_greeks_coverage,
    validate_position_chain,
    validate_snapshot_consistency,
)


def make_phase3_event(**overrides: object) -> dict[str, object]:
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


def test_validate_position_chain_passes_for_valid_replay() -> None:
    phase3_events = [
        make_phase3_event(event_id="evt-1", source_trade_id="raw-1", trade_seq=1, amount="2", taker_side="buy"),
        make_phase3_event(event_id="evt-2", source_trade_id="raw-2", trade_seq=2, amount="1", taker_side="sell"),
        make_phase3_event(
            event_id="evt-3",
            source_trade_id="raw-3",
            trade_seq=3,
            instrument_name="BTC-26APR26-90000-P",
            option_type="put",
            taker_side="buy",
            amount="0.5",
        ),
    ]

    replay = LedgerReplayer(LedgerPolicy(snapshot_every=100)).replay(
        [NormalizedTradeEvent.from_dict(row) for row in phase3_events]
    )

    result = validate_position_chain(
        phase3_events,
        [row.to_dict() for row in replay.position_deltas],
        sample_size=2,
        sample_seed=3,
    )

    assert result["passed"] is True
    assert result["sign_violation_count"] == 0
    assert result["chain_violation_count"] == 0


def test_validate_snapshot_consistency_passes_for_balanced_rows() -> None:
    snapshot_payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 94750.25,
        "rows": [
            {
                "expiry": "2026-05-01",
                "strike": 80000.0,
                "net_gex": 1.0,
                "call_gex": 3.0,
                "put_gex": -2.0,
            },
            {
                "expiry": "2026-06-26",
                "strike": 90000.0,
                "net_gex": -2.0,
                "call_gex": 0.5,
                "put_gex": -2.5,
            },
        ],
    }
    gex_instrument_rows = [
        {
            "instrument_name": "BTC-1MAY26-80000-C",
            "option_type": "call",
            "strike": "80000",
            "expiry_ts": "1777593600000",
            "dollar_gamma_per_1pct": "3.0",
        },
        {
            "instrument_name": "BTC-1MAY26-80000-P",
            "option_type": "put",
            "strike": "80000",
            "expiry_ts": "1777593600000",
            "dollar_gamma_per_1pct": "-2.0",
        },
        {
            "instrument_name": "BTC-26JUN26-90000-C",
            "option_type": "call",
            "strike": "90000",
            "expiry_ts": "1782432000000",
            "dollar_gamma_per_1pct": "0.5",
        },
        {
            "instrument_name": "BTC-26JUN26-90000-P",
            "option_type": "put",
            "strike": "90000",
            "expiry_ts": "1782432000000",
            "dollar_gamma_per_1pct": "-2.5",
        },
    ]
    gex_by_strike_rows = [
        {
            "strike": "80000",
            "call_gex": "3.0",
            "put_gex": "-2.0",
            "net_gex": "1.0",
        },
        {
            "strike": "90000",
            "call_gex": "0.5",
            "put_gex": "-2.5",
            "net_gex": "-2.0",
        },
    ]

    result = validate_snapshot_consistency(
        snapshot_payload,
        gex_instrument_rows,
        gex_by_strike_rows,
    )

    assert result["passed"] is True
    assert result["row_violation_count"] == 0


def test_validate_expiry_filtering_passes_for_additive_all_view(tmp_path: Path) -> None:
    snapshot_path = tmp_path / "latest_gex_snapshot.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "as_of": "2026-04-25T21:45:00Z",
                "underlying": "BTC",
                "spot_price": 94750.25,
                "rows": [
                    {
                        "expiry": "2026-05-01",
                        "strike": 80000,
                        "net_gex": 1.0,
                        "call_gex": 3.0,
                        "put_gex": -2.0,
                    },
                    {
                        "expiry": "2026-06-26",
                        "strike": 80000,
                        "net_gex": 2.0,
                        "call_gex": 2.5,
                        "put_gex": -0.5,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    result = validate_expiry_filtering(snapshot_path)

    assert result["passed"] is True
    assert result["mismatch_count"] == 0


def test_audit_deribit_trade_payloads_allows_missing_contracts_but_requires_amount_and_direction() -> None:
    result = audit_deribit_trade_payloads(
        [
            {
                "instrument_name": "BTC-26APR26-90000-C",
                "trade_id": "1",
                "direction": "buy",
                "amount": "2",
            },
            {
                "instrument_name": "BTC-26APR26-90000-P",
                "trade_id": "2",
                "direction": "sell",
                "amount": "1",
                "contracts": "1",
            },
        ]
    )

    assert result["passed"] is True
    assert result["missing_contracts_count"] == 1
    assert "amount" in result["inventory_unit_policy"]


def test_audit_deribit_trade_payloads_fails_invalid_taker_side_or_amount() -> None:
    result = audit_deribit_trade_payloads(
        [
            {
                "instrument_name": "BTC-26APR26-90000-C",
                "trade_id": "1",
                "direction": "hold",
                "amount": "",
            }
        ]
    )

    assert result["passed"] is False
    assert result["missing_or_invalid_direction_count"] == 1
    assert result["missing_amount_count"] == 1


def test_validate_greeks_coverage_fails_missing_greeks() -> None:
    result = validate_greeks_coverage(
        {
            "missing_greeks_count": 2,
            "missing_greeks": ["BTC-26APR26-90000-C", "BTC-26APR26-90000-P"],
        }
    )

    assert result["passed"] is False
    assert result["missing_greeks_count"] == 2
