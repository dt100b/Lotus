from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from ledger.models import NormalizedTradeEvent

# Production inventory / default GEX path: listed single-leg only (blocks + combos out).
PRODUCTION_LEDGER_METHODOLOGY_VERSION = "phase3.ledger.v1"
# Secondary sensitivity path: include OTC block/combo prints in inventory + GEX.
INCLUDE_OTC_LEDGER_METHODOLOGY_VERSION = "phase3.ledger.v1.include_otc"


@dataclass(frozen=True, slots=True)
class LedgerPolicy:
    methodology_version: str = PRODUCTION_LEDGER_METHODOLOGY_VERSION
    snapshot_every: int = 10_000
    allowed_venue: str = "deribit"
    allowed_base_currency: str = "BTC"
    required_kind: str = "option"
    exclude_block_trades: bool = True
    exclude_combo_trades: bool = True
    require_single_leg: bool = True


def production_ledger_policy(
    *,
    methodology_version: str = PRODUCTION_LEDGER_METHODOLOGY_VERSION,
    snapshot_every: int = 10_000,
) -> LedgerPolicy:
    """Default Phase 3 policy: exclude block/combo trades, require single-leg."""
    return LedgerPolicy(
        methodology_version=methodology_version,
        snapshot_every=snapshot_every,
        exclude_block_trades=True,
        exclude_combo_trades=True,
        require_single_leg=True,
    )


def include_otc_ledger_policy(
    *,
    methodology_version: str = INCLUDE_OTC_LEDGER_METHODOLOGY_VERSION,
    snapshot_every: int = 10_000,
) -> LedgerPolicy:
    """ARCHIVED secondary policy: include block and combo (OTC) prints.

    Not used by the live desk (see docs/archived_include_otc_prints.md).
    Same venue/currency/kind filters as production; only the block/combo/single-leg
    gates are relaxed. GEX formula is unchanged — only the inventory input differs.
    """
    return LedgerPolicy(
        methodology_version=methodology_version,
        snapshot_every=snapshot_every,
        exclude_block_trades=False,
        exclude_combo_trades=False,
        require_single_leg=False,
    )


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
    if not event.amount.is_finite() or event.amount <= 0:
        return False, "invalid_amount"
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
