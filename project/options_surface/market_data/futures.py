"""Listed Deribit future book snapshots."""

from __future__ import annotations

from datetime import UTC, datetime
from threading import Lock
from typing import Any, Callable, Mapping, Sequence

import httpx

from project.options_surface.market_data.instruments import (
    optional_float,
    optional_positive,
    parse_future_instrument,
)
from project.options_surface.timeutil import as_utc, parse_quote_as_of
from project.options_surface.types import NativeFutureQuote

DERIBIT_BOOK_SUMMARY_URL = (
    "https://www.deribit.com/api/v2/public/get_book_summary_by_currency"
)


class FutureBookError(RuntimeError):
    """Raised when a listed-future snapshot cannot be produced."""


class DeribitFuturesProvider:
    """REST book-summary for listed futures. Injectable for offline tests."""

    def __init__(
        self,
        *,
        cache_seconds: float = 5.0,
        timeout_seconds: float = 15.0,
        http_get: Callable[..., Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        currency: str = "BTC",
    ) -> None:
        self.cache_seconds = float(cache_seconds)
        self.timeout_seconds = float(timeout_seconds)
        self.currency = str(currency).upper()
        self._http_get = http_get or httpx.get
        self._clock = clock or (lambda: datetime.now(UTC))
        self._lock = Lock()
        self._cached_at: datetime | None = None
        self._cached: tuple[NativeFutureQuote, ...] | None = None

    def fetch(self) -> tuple[NativeFutureQuote, ...]:
        now = as_utc(self._clock())
        with self._lock:
            if (
                self._cached_at is not None
                and self._cached is not None
                and (now - self._cached_at).total_seconds() <= self.cache_seconds
            ):
                return self._cached
            snapshot = self._fetch_uncached(now)
            self._cached_at = now
            self._cached = snapshot
            return snapshot

    def _fetch_uncached(self, as_of: datetime) -> tuple[NativeFutureQuote, ...]:
        try:
            response = self._http_get(
                DERIBIT_BOOK_SUMMARY_URL,
                params={"currency": self.currency, "kind": "future"},
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:  # pragma: no cover - transport type varies
            raise FutureBookError(f"Deribit future book-summary failed: {exc}") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("result"), list):
            raise FutureBookError("Deribit future book-summary has no result list.")
        quotes: list[NativeFutureQuote] = []
        for raw in payload["result"]:
            if not isinstance(raw, Mapping):
                continue
            parsed = parse_future_instrument(raw.get("instrument_name"))
            if parsed is None:
                continue
            currency, expiry_date, is_perpetual = parsed
            if currency != self.currency:
                continue
            bid = optional_positive(raw.get("bid_price"))
            ask = optional_positive(raw.get("ask_price"))
            mark = optional_positive(raw.get("mark_price"))
            mid = None
            if bid is not None and ask is not None and ask >= bid:
                mid = 0.5 * (bid + ask)
            elif mark is not None:
                mid = mark
            quotes.append(
                NativeFutureQuote(
                    instrument_name=str(raw.get("instrument_name")),
                    underlying=currency,
                    expiry_date=expiry_date,
                    expiry_utc=None,
                    as_of_utc=as_of,
                    quote_as_of_utc=parse_quote_as_of(raw.get("creation_timestamp")),
                    is_perpetual=is_perpetual,
                    bid_usd=bid,
                    ask_usd=ask,
                    mark_usd=mark,
                    mid_usd=mid,
                    index_usd=optional_positive(raw.get("index_price")),
                    open_interest=optional_float(raw.get("open_interest")),
                )
            )
        return tuple(quotes)


def matching_futures(
    quotes: Sequence[NativeFutureQuote],
    *,
    expiry_date: str,
    underlying: str,
) -> tuple[NativeFutureQuote, ...]:
    wanted = str(expiry_date)
    asset = str(underlying).upper()
    return tuple(
        quote
        for quote in quotes
        if not quote.is_perpetual
        and quote.underlying == asset
        and quote.expiry_date == wanted
    )
