from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Optional

from .models import CanonicalInstrument

OPTION_NAME_RE = re.compile(
    r"^(?P<underlying>[A-Z]+)-(?P<expiry>\d{1,2}[A-Z]{3}\d{2})-(?P<strike>\d+(?:\.\d+)*)-(?P<option_type>[CP])$"
)


@dataclass(frozen=True, slots=True)
class ParsedOptionName:
    underlying: str
    expiry_ts_ms: int
    expiry_label: str
    strike: Decimal
    option_type: str


def _maybe_decimal(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _normalize_option_type(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"c", "call"}:
        return "call"
    if text in {"p", "put"}:
        return "put"
    return None


def parse_deribit_option_instrument_name(instrument_name: str) -> Optional[ParsedOptionName]:
    match = OPTION_NAME_RE.fullmatch(instrument_name)
    if not match:
        return None

    expiry_label = match.group("expiry").upper()
    expiry_dt = datetime.strptime(expiry_label, "%d%b%y").replace(tzinfo=timezone.utc)

    return ParsedOptionName(
        underlying=match.group("underlying").upper(),
        expiry_ts_ms=int(expiry_dt.timestamp() * 1000),
        expiry_label=expiry_label,
        strike=Decimal(match.group("strike")),
        option_type="call" if match.group("option_type") == "C" else "put",
    )


def normalize_instrument(raw: dict[str, Any]) -> CanonicalInstrument:
    instrument_name = str(raw["instrument_name"])
    parsed = parse_deribit_option_instrument_name(instrument_name)

    raw_kind = str(raw.get("kind") or raw.get("instrument_type") or "").strip().lower()
    option_type = _normalize_option_type(raw.get("option_type")) or (parsed.option_type if parsed else None)

    if parsed:
        kind = "option"
    else:
        kind = raw_kind or "unsupported"

    underlying = str(
        raw.get("base_currency")
        or raw.get("underlying")
        or (parsed.underlying if parsed else instrument_name.split("-")[0])
    ).upper()

    is_combo = (
        raw_kind == "combo"
        or bool(raw.get("combo_id"))
        or bool(raw.get("combo_trade_id"))
    )

    return CanonicalInstrument(
        venue="deribit",
        instrument_name=instrument_name,
        underlying=underlying,
        kind=kind,
        option_type=option_type,
        expiry_ts_ms=parsed.expiry_ts_ms if parsed else None,
        expiry_label=parsed.expiry_label if parsed else None,
        strike=_maybe_decimal(raw.get("strike")) or (parsed.strike if parsed else None),
        contract_size=_maybe_decimal(raw.get("contract_size")),
        tick_size=_maybe_decimal(raw.get("tick_size")),
        quote_currency=raw.get("quote_currency"),
        settlement_currency=raw.get("settlement_currency"),
        settlement_period=raw.get("settlement_period"),
        is_active=raw.get("is_active"),
        is_combo=is_combo,
        raw_payload=raw,
    )


class InstrumentRegistry:
    def __init__(self) -> None:
        self._by_name: dict[str, CanonicalInstrument] = {}

    @classmethod
    def build(cls, raw_instruments: Iterable[dict[str, Any]]) -> "InstrumentRegistry":
        registry = cls()
        for raw in raw_instruments:
            registry.upsert_raw(raw)
        return registry

    def upsert_raw(self, raw: dict[str, Any]) -> CanonicalInstrument:
        instrument = normalize_instrument(raw)
        self._by_name[instrument.instrument_name] = instrument
        return instrument

    def get(self, instrument_name: str) -> Optional[CanonicalInstrument]:
        return self._by_name.get(instrument_name)

    def require(self, instrument_name: str) -> CanonicalInstrument:
        instrument = self.get(instrument_name)
        if instrument is None:
            raise KeyError(f"Unknown instrument_name: {instrument_name}")
        return instrument

    def items(self):
        return self._by_name.items()

    def values(self):
        return self._by_name.values()
