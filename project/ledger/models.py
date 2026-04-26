from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any


def to_decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def decimal_to_str(value: Decimal) -> str:
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


@dataclass(frozen=True, slots=True)
class NormalizedTradeEvent:
    event_id: str
    source_trade_id: str
    trade_seq: int
    ts_ms: int
    venue: str
    base_currency: str
    kind: str
    instrument_name: str
    option_type: str
    strike: Decimal
    expiry_ts_ms: int
    contract_size: Decimal
    amount: Decimal
    price: Decimal
    taker_side: str
    is_block_trade: bool
    is_combo_trade: bool
    is_single_leg: bool
    normalization_version: str

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "NormalizedTradeEvent":
        return cls(
            event_id=str(payload["event_id"]),
            source_trade_id=str(payload.get("source_trade_id", payload["event_id"])),
            trade_seq=int(payload["trade_seq"]),
            ts_ms=int(payload["ts_ms"]),
            venue=str(payload.get("venue", "deribit")).lower(),
            base_currency=str(payload["base_currency"]).upper(),
            kind=str(payload.get("kind", "option")).lower(),
            instrument_name=str(payload["instrument_name"]),
            option_type=str(payload["option_type"]).lower(),
            strike=to_decimal(payload["strike"]),
            expiry_ts_ms=int(payload["expiry_ts_ms"]),
            contract_size=to_decimal(payload.get("contract_size", "1")),
            amount=to_decimal(payload["amount"]),
            price=to_decimal(payload["price"]),
            taker_side=str(payload["taker_side"]).lower(),
            is_block_trade=bool(payload.get("is_block_trade", False)),
            is_combo_trade=bool(payload.get("is_combo_trade", False)),
            is_single_leg=bool(payload.get("is_single_leg", True)),
            normalization_version=str(payload.get("normalization_version", "phase2.v1")),
        )

    @property
    def inventory_key(self) -> str:
        return self.instrument_name

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "source_trade_id": self.source_trade_id,
            "trade_seq": self.trade_seq,
            "ts_ms": self.ts_ms,
            "venue": self.venue,
            "base_currency": self.base_currency,
            "kind": self.kind,
            "instrument_name": self.instrument_name,
            "option_type": self.option_type,
            "strike": decimal_to_str(self.strike),
            "expiry_ts_ms": self.expiry_ts_ms,
            "contract_size": decimal_to_str(self.contract_size),
            "amount": decimal_to_str(self.amount),
            "price": decimal_to_str(self.price),
            "taker_side": self.taker_side,
            "is_block_trade": self.is_block_trade,
            "is_combo_trade": self.is_combo_trade,
            "is_single_leg": self.is_single_leg,
            "normalization_version": self.normalization_version,
        }


@dataclass(frozen=True, slots=True)
class PositionDelta:
    event_id: str
    source_trade_id: str
    trade_seq: int
    ts_ms: int
    instrument_name: str
    taker_side: str
    dealer_position_delta: Decimal
    dealer_position_after: Decimal
    applied: bool
    exclusion_reason: str | None
    normalization_version: str
    methodology_version: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "source_trade_id": self.source_trade_id,
            "trade_seq": self.trade_seq,
            "ts_ms": self.ts_ms,
            "instrument_name": self.instrument_name,
            "taker_side": self.taker_side,
            "dealer_position_delta": decimal_to_str(self.dealer_position_delta),
            "dealer_position_after": decimal_to_str(self.dealer_position_after),
            "applied": self.applied,
            "exclusion_reason": self.exclusion_reason,
            "normalization_version": self.normalization_version,
            "methodology_version": self.methodology_version,
        }


@dataclass(frozen=True, slots=True)
class InventorySnapshot:
    snapshot_id: str
    ts_ms: int
    last_trade_seq: int
    positions: dict[str, Decimal]
    methodology_version: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "snapshot_id": self.snapshot_id,
            "ts_ms": self.ts_ms,
            "last_trade_seq": self.last_trade_seq,
            "positions": {
                instrument: decimal_to_str(position)
                for instrument, position in sorted(self.positions.items())
            },
            "methodology_version": self.methodology_version,
        }
