from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from ledger.models import NormalizedTradeEvent


@dataclass(frozen=True, slots=True)
class LedgerPolicy:
    methodology_version: str = "phase3.ledger.v1"
    snapshot_every: int = 10_000
    allowed_venue: str = "deribit"
    allowed_base_currency: str = "BTC"
    required_kind: str = "option"
    exclude_block_trades: bool = True
    exclude_combo_trades: bool = True
    require_single_leg: bool = True


def classify_event(
    event: NormalizedTradeEvent, policy: LedgerPolicy
) -> tuple[bool, str | None]:
    if event.venue != policy.allowed_venue:
        return False, "wrong_venue"
    if event.base_currency != policy.allowed_base_currency:
        return False, "wrong_base_currency"
    if event.kind != policy.required_kind:
        return False, "wrong_kind"
    if event.taker_side not in {"buy", "sell"}:
        return False, "unknown_taker_side"
    if policy.require_single_leg and not event.is_single_leg:
        return False, "non_single_leg"
    if policy.exclude_combo_trades and event.is_combo_trade:
        return False, "combo_trade"
    if policy.exclude_block_trades and event.is_block_trade:
        return False, "block_trade"
    return True, None


def dealer_position_delta(event: NormalizedTradeEvent) -> Decimal:
    if event.taker_side == "buy":
        return -event.amount
    if event.taker_side == "sell":
        return event.amount
    raise ValueError(f"Unsupported taker_side={event.taker_side!r}")
