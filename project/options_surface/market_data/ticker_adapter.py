"""Adapt existing ticker / book-summary rows to native option quotes."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping, Sequence

from project.options_surface.market_data.instruments import (
    instrument_expiry_utc,
    optional_float,
    optional_non_negative,
    optional_positive,
    parse_option_instrument,
)
from project.options_surface.timeutil import as_utc, parse_quote_as_of, resolve_expiry_utc
from project.options_surface.types import NativeOptionQuote


def quotes_from_scanner_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    as_of_utc: datetime,
    underlying: str = "BTC",
    default_index_usd: float | None = None,
) -> tuple[NativeOptionQuote, ...]:
    """Preserve native BTC premiums. Never convert inverse prices to USD."""
    as_of = as_utc(as_of_utc)
    quotes: list[NativeOptionQuote] = []
    for row in rows:
        instrument = str(row.get("instrument_name") or "").strip()
        parsed = parse_option_instrument(instrument) if instrument else None
        if parsed is None:
            expiry = str(row.get("expiry") or "").strip()
            strike = optional_positive(row.get("strike"))
            side = _option_side(row.get("option_type", row.get("option_side")))
            currency = str(row.get("underlying") or underlying).upper()
            if not expiry or strike is None or side is None:
                continue
        else:
            currency, expiry, strike, side = parsed
        expiry_utc, inferred = resolve_expiry_utc(expiry, instrument_expiry_utc(row))
        quotes.append(
            NativeOptionQuote(
                instrument_name=instrument or f"{currency}-{expiry}-{strike:.0f}-{side[0].upper()}",
                underlying=currency,
                expiry_date=expiry,
                expiry_utc=expiry_utc,
                strike_usd=float(strike),
                option_side=side,
                as_of_utc=as_of,
                quote_as_of_utc=parse_quote_as_of(row.get("quote_as_of")),
                state=str(row.get("state") or "open").strip().lower(),
                bid_price_btc=optional_float(row.get("bid_price")),
                ask_price_btc=optional_float(row.get("ask_price")),
                bid_size=optional_positive(row.get("bid_size") or row.get("bid_amount")),
                ask_size=optional_positive(row.get("ask_size") or row.get("ask_amount")),
                bid_iv=_iv_to_abs(row.get("bid_iv")),
                ask_iv=_iv_to_abs(row.get("ask_iv")),
                mark_iv=_iv_to_abs(row.get("mark_iv")),
                mark_price_btc=optional_float(row.get("mark_price")),
                index_usd=optional_positive(row.get("index_price")) or default_index_usd,
                underlying_price_usd=optional_positive(row.get("underlying_price")),
                estimated_delivery_usd=optional_positive(row.get("estimated_delivery_price")),
                open_interest=optional_non_negative(row.get("open_interest")),
                volume=optional_non_negative(row.get("volume") or row.get("stats_volume")),
                venue_delta=optional_float(row.get("delta")),
                expiry_timestamp_inferred=inferred,
            )
        )
    return tuple(quotes)


def _option_side(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if text in {"c", "call"}:
        return "call"
    if text in {"p", "put"}:
        return "put"
    return None


def _iv_to_abs(value: Any) -> float | None:
    """Deribit publishes IV in percentage points. Store absolute vol."""
    parsed = optional_positive(value)
    if parsed is None:
        return None
    return parsed / 100.0 if parsed > 2.0 else parsed
