from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Any, Optional


def _serialize(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, list):
        return [_serialize(v) for v in value]
    if isinstance(value, dict):
        return {k: _serialize(v) for k, v in value.items()}
    return value


@dataclass(frozen=True, slots=True)
class CanonicalInstrument:
    venue: str
    instrument_name: str
    underlying: str
    kind: str
    option_type: Optional[str]
    expiry_ts_ms: Optional[int]
    expiry_label: Optional[str]
    strike: Optional[Decimal]
    contract_size: Optional[Decimal]
    tick_size: Optional[Decimal]
    quote_currency: Optional[str]
    settlement_currency: Optional[str]
    settlement_period: Optional[str]
    is_active: Optional[bool]
    is_combo: bool
    raw_payload: dict[str, Any] = field(repr=False)

    def instrument_key(self) -> str:
        strike = str(self.strike) if self.strike is not None else "NA"
        expiry = str(self.expiry_ts_ms) if self.expiry_ts_ms is not None else "NA"
        option_type = self.option_type or "NA"
        return f"{self.underlying}:{expiry}:{strike}:{option_type}"

    def to_record(self) -> dict[str, Any]:
        return _serialize(asdict(self))


@dataclass(frozen=True, slots=True)
class NormalizedTradeEvent:
    venue: str
    underlying: str
    method_version: str

    trade_id: str
    trade_seq: Optional[int]
    timestamp_ms: int
    received_timestamp_ms: Optional[int]

    instrument_name: str
    instrument_key: str
    instrument_kind: str
    option_type: Optional[str]
    expiry_ts_ms: Optional[int]
    strike: Optional[Decimal]

    taker_side: str
    amount: Decimal
    price: Decimal
    index_price: Optional[Decimal]
    mark_price: Optional[Decimal]
    iv: Optional[Decimal]
    liquidation: Optional[bool]

    block_trade_id: Optional[str]
    combo_id: Optional[str]
    is_block: bool
    is_combo: bool

    excluded_from_v1_derived: bool
    exclusion_reasons: tuple[str, ...]

    raw_payload_sha256: str
    raw_payload: dict[str, Any] = field(repr=False)

    def to_record(self) -> dict[str, Any]:
        return _serialize(asdict(self))
