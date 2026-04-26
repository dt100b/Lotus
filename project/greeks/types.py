from __future__ import annotations

from dataclasses import dataclass
from math import fsum
from typing import Any, Literal

OptionType = Literal["call", "put"]


@dataclass(frozen=True, slots=True)
class DealerInventoryRow:
    instrument_name: str
    option_type: OptionType
    strike: float
    expiry_ts: int
    net_contracts: float
    contract_multiplier: float
    include_in_gex: bool = True


@dataclass(frozen=True, slots=True)
class GreekSnapshot:
    instrument_name: str
    gamma: float
    spot_price: float
    snapshot_ts: int


@dataclass(frozen=True, slots=True)
class GEXInstrumentRow:
    instrument_name: str
    option_type: OptionType
    strike: float
    expiry_ts: int
    net_contracts: float
    contract_multiplier: float
    gamma: float
    spot_price: float
    position_gamma: float
    dollar_gamma_per_1pct: float
    snapshot_ts: int


@dataclass(frozen=True, slots=True)
class StrikeProfileRow:
    strike: float
    call_gex: float
    put_gex: float
    net_gex: float
    gross_gex: float


@dataclass(frozen=True, slots=True)
class ExpiryProfileRow:
    expiry_ts: int
    call_gex: float
    put_gex: float
    net_gex: float
    gross_gex: float


@dataclass(frozen=True, slots=True)
class GEXProfile:
    as_of_ts: int
    methodology_version: str
    instrument_rows: tuple[GEXInstrumentRow, ...]
    by_strike: tuple[StrikeProfileRow, ...]
    by_expiry: tuple[ExpiryProfileRow, ...]
    missing_greeks: tuple[str, ...]

    def to_summary(self) -> dict[str, Any]:
        total_call_gex = fsum(row.call_gex for row in self.by_strike)
        total_put_gex = fsum(row.put_gex for row in self.by_strike)
        total_net_gex = fsum(row.net_gex for row in self.by_strike)
        total_gross_gex = fsum(row.gross_gex for row in self.by_strike)

        return {
            "as_of_ts": self.as_of_ts,
            "methodology_version": self.methodology_version,
            "instrument_count": len(self.instrument_rows),
            "strike_count": len(self.by_strike),
            "expiry_count": len(self.by_expiry),
            "missing_greeks_count": len(self.missing_greeks),
            "missing_greeks": list(self.missing_greeks),
            "total_call_gex": total_call_gex,
            "total_put_gex": total_put_gex,
            "total_net_gex": total_net_gex,
            "total_gross_gex": total_gross_gex,
        }
