from __future__ import annotations

import hashlib
import json
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Optional

from .instruments import InstrumentRegistry
from .models import NormalizedTradeEvent


def _maybe_decimal(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        parsed = Decimal(str(value))
        return parsed if parsed.is_finite() else None
    except (InvalidOperation, ValueError, TypeError):
        return None


def _maybe_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def _maybe_str(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    return str(value)


def _stable_payload_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _normalize_taker_side(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"buy", "sell"}:
        return text
    return "unknown"


def _detect_block(raw: dict[str, Any]) -> bool:
    trade_type = str(raw.get("trade_type") or "").strip().lower()
    return bool(raw.get("block_trade_id")) or bool(raw.get("block_trade")) or trade_type == "block_trade"


def _detect_combo(raw: dict[str, Any], instrument) -> bool:
    trade_kind = str(raw.get("kind") or raw.get("instrument_type") or "").strip().lower()
    return (
        bool(instrument and instrument.is_combo)
        or bool(raw.get("combo_id"))
        or bool(raw.get("combo_trade_id"))
        or trade_kind == "combo"
    )


def _exclusion_reasons(
    instrument,
    is_block: bool,
    is_combo: bool,
    *,
    missing_instrument_metadata: bool,
    taker_side: str,
    amount: Decimal,
) -> tuple[str, ...]:
    reasons: list[str] = []

    if missing_instrument_metadata:
        reasons.append("missing_instrument_metadata")

    if instrument.underlying != "BTC":
        reasons.append("non_btc")

    if (
        instrument.kind != "option"
        or instrument.option_type is None
        or instrument.expiry_ts_ms is None
        or instrument.strike is None
    ):
        reasons.append("non_single_option")

    if is_combo:
        reasons.append("combo")

    if is_block:
        reasons.append("block")

    if taker_side not in {"buy", "sell"}:
        reasons.append("unknown_taker_side")

    if not amount.is_finite() or amount <= 0:
        reasons.append("invalid_amount")

    return tuple(dict.fromkeys(reasons))


def _assert_unresolved_invariants(
    *,
    missing_instrument_metadata: bool,
    instrument_kind: str,
    excluded_from_v1_derived: bool,
    exclusion_reasons: tuple[str, ...],
) -> None:
    # Non-strict unresolved events must never flow into derived/ledger consumption.
    if missing_instrument_metadata or instrument_kind == "unresolved":
        if instrument_kind != "unresolved":
            raise ValueError("Unresolved instrument metadata must set instrument_kind='unresolved'")
        if not excluded_from_v1_derived:
            raise ValueError("Unresolved instrument metadata must be excluded from v1 derived outputs")
        if "missing_instrument_metadata" not in exclusion_reasons:
            raise ValueError("Unresolved instrument metadata must include 'missing_instrument_metadata' exclusion reason")


def normalize_trade(
    raw: dict[str, Any],
    registry: Optional[InstrumentRegistry] = None,
    *,
    received_timestamp_ms: Optional[int] = None,
    method_version: str = "phase2_v1",
    strict_instrument_lookup: bool = True,
) -> NormalizedTradeEvent:
    instrument_name = str(raw["instrument_name"])
    instrument = registry.get(instrument_name) if registry else None
    missing_instrument_metadata = instrument is None
    if missing_instrument_metadata and strict_instrument_lookup:
        raise KeyError(f"Missing instrument metadata for instrument_name: {instrument_name}")

    is_block = _detect_block(raw)
    is_combo = _detect_combo(raw, instrument)
    if missing_instrument_metadata:
        underlying = str(raw.get("base_currency") or raw.get("underlying") or "UNKNOWN").upper()
        instrument_key = f"UNRESOLVED:{instrument_name}"
        instrument_kind = "unresolved"
        option_type = None
        expiry_ts_ms = None
        strike = None
    else:
        underlying = instrument.underlying
        instrument_key = instrument.instrument_key()
        instrument_kind = instrument.kind
        option_type = instrument.option_type
        expiry_ts_ms = instrument.expiry_ts_ms
        strike = instrument.strike

    class _SyntheticInstrument:
        def __init__(self, u, k, o, e, s):
            self.underlying = u
            self.kind = k
            self.option_type = o
            self.expiry_ts_ms = e
            self.strike = s

    taker_side = _normalize_taker_side(raw.get("direction") or raw.get("side"))
    parsed_amount = _maybe_decimal(raw.get("amount"))
    amount = parsed_amount if parsed_amount is not None else Decimal("0")
    parsed_price = _maybe_decimal(raw.get("price"))
    price = parsed_price if parsed_price is not None else Decimal("0")

    exclusion_reasons = _exclusion_reasons(
        _SyntheticInstrument(underlying, instrument_kind, option_type, expiry_ts_ms, strike),
        is_block=is_block,
        is_combo=is_combo,
        missing_instrument_metadata=missing_instrument_metadata,
        taker_side=taker_side,
        amount=amount,
    )

    trade_id = _maybe_str(raw.get("trade_id")) or _maybe_str(raw.get("trade_seq")) or f"ts:{raw.get('timestamp')}"
    excluded_from_v1_derived = bool(exclusion_reasons)
    _assert_unresolved_invariants(
        missing_instrument_metadata=missing_instrument_metadata,
        instrument_kind=instrument_kind,
        excluded_from_v1_derived=excluded_from_v1_derived,
        exclusion_reasons=exclusion_reasons,
    )

    return NormalizedTradeEvent(
        venue="deribit",
        underlying=underlying,
        method_version=method_version,
        trade_id=trade_id,
        trade_seq=_maybe_int(raw.get("trade_seq") or raw.get("seq")),
        timestamp_ms=_maybe_int(raw.get("timestamp")) or 0,
        received_timestamp_ms=received_timestamp_ms,
        instrument_name=instrument_name,
        instrument_key=instrument_key,
        instrument_kind=instrument_kind,
        option_type=option_type,
        expiry_ts_ms=expiry_ts_ms,
        strike=strike,
        taker_side=taker_side,
        amount=amount,
        price=price,
        index_price=_maybe_decimal(raw.get("index_price")),
        mark_price=_maybe_decimal(raw.get("mark_price")),
        iv=_maybe_decimal(raw.get("iv")),
        liquidation=raw.get("liquidation"),
        block_trade_id=_maybe_str(raw.get("block_trade_id")),
        combo_id=_maybe_str(raw.get("combo_id") or raw.get("combo_trade_id")),
        is_block=is_block,
        is_combo=is_combo,
        excluded_from_v1_derived=excluded_from_v1_derived,
        exclusion_reasons=exclusion_reasons,
        raw_payload_sha256=_stable_payload_hash(raw),
        raw_payload=raw,
    )


def normalize_trades(
    raw_trades: Iterable[dict[str, Any]],
    registry: Optional[InstrumentRegistry] = None,
    *,
    received_timestamp_ms: Optional[int] = None,
    method_version: str = "phase2_v1",
    strict_instrument_lookup: bool = True,
) -> list[NormalizedTradeEvent]:
    return [
        normalize_trade(
            raw,
            registry,
            received_timestamp_ms=received_timestamp_ms,
            method_version=method_version,
            strict_instrument_lookup=strict_instrument_lookup,
        )
        for raw in raw_trades
    ]
