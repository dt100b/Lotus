from __future__ import annotations

from typing import Iterable

from .instruments import InstrumentRegistry
from .trades import normalize_trades


def build_instrument_registry(raw_instruments: Iterable[dict]) -> InstrumentRegistry:
    return InstrumentRegistry.build(raw_instruments)


def normalize_trade_batch(
    raw_instruments: Iterable[dict],
    raw_trades: Iterable[dict],
    *,
    received_timestamp_ms: int | None = None,
    method_version: str = "phase2_v1",
    strict_instrument_lookup: bool = True,
) -> dict[str, list[dict]]:
    registry = build_instrument_registry(raw_instruments)
    normalized_events = normalize_trades(
        raw_trades,
        registry,
        received_timestamp_ms=received_timestamp_ms,
        method_version=method_version,
        strict_instrument_lookup=strict_instrument_lookup,
    )

    instruments = [instrument.to_record() for instrument in sorted(registry.values(), key=lambda x: x.instrument_name)]
    trades = [event.to_record() for event in normalized_events]

    return {
        "instruments": instruments,
        "trades": trades,
    }
