from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def deribit_expiry_code(iso_date: str) -> str:
    return datetime.strptime(iso_date, "%Y-%m-%d").strftime("%d%b%y").upper()

from project.options_surface.types import NativeFutureQuote

EXPIRY = "2030-08-16"
AS_OF = datetime(2030, 8, 15, 12, tzinfo=UTC)
FORWARD = 100_000.0
INDEX = 99_800.0
SIGMA = 0.50


def option_row(
    strike: float,
    side: str,
    mark_iv_pct: float,
    *,
    expiry: str = EXPIRY,
    bid: float = 0.048,
    ask: float = 0.052,
    bid_iv_pct: float | None = None,
    ask_iv_pct: float | None = None,
    quote_as_of: datetime = AS_OF,
    state: str = "open",
    bid_size: float | None = 1.0,
    ask_size: float | None = 1.0,
    open_interest: float | None = 20.0,
    underlying_price: float | None = FORWARD,
    index_price: float | None = INDEX,
    instrument: str | None = None,
    delta: float | None = None,
) -> dict[str, Any]:
    side_code = "C" if side in {"c", "call"} else "P"
    name = instrument or f"BTC-{deribit_expiry_code(expiry)}-{int(strike)}-{side_code}"
    bid_iv = mark_iv_pct - 1.0 if bid_iv_pct is None else bid_iv_pct
    ask_iv = mark_iv_pct + 1.0 if ask_iv_pct is None else ask_iv_pct
    return {
        "expiry": expiry,
        "strike": strike,
        "option_type": "call" if side_code == "C" else "put",
        "instrument_name": name,
        "mark_iv": mark_iv_pct,
        "bid_iv": bid_iv,
        "ask_iv": ask_iv,
        "bid_price": bid,
        "ask_price": ask,
        "bid_size": bid_size,
        "ask_size": ask_size,
        "quote_as_of": quote_as_of,
        "state": state,
        "open_interest": open_interest,
        "underlying_price": underlying_price,
        "index_price": index_price,
        "delta": delta,
    }


def inverse_mids_for_forward(strike: float, forward: float, call_mid: float = 0.05) -> tuple[float, float]:
    put_mid = call_mid - (1.0 - strike / forward)
    return call_mid, put_mid


def listed_future(
    *,
    expiry: str = EXPIRY,
    mid: float = FORWARD,
    bid: float | None = None,
    ask: float | None = None,
    mark: float | None = None,
    name: str | None = None,
) -> NativeFutureQuote:
    if bid is None:
        bid = mid - 5.0
    if ask is None:
        ask = mid + 5.0
    if mark is None:
        mark = mid
    return NativeFutureQuote(
        instrument_name=name or "BTC-16AUG30",
        underlying="BTC",
        expiry_date=expiry,
        expiry_utc=None,
        as_of_utc=AS_OF,
        quote_as_of_utc=AS_OF,
        is_perpetual=False,
        bid_usd=bid,
        ask_usd=ask,
        mark_usd=mark,
        mid_usd=0.5 * (bid + ask) if bid and ask else mark,
        index_usd=INDEX,
        open_interest=1000.0,
    )


def flat_vol_chain(
    *,
    forward: float = FORWARD,
    sigma_pct: float = 50.0,
    strikes: list[float] | None = None,
    as_of: datetime = AS_OF,
    expiry: str = EXPIRY,
) -> list[dict[str, Any]]:
    grid = strikes or [
        forward * ratio
        for ratio in (0.70, 0.80, 0.90, 0.95, 1.00, 1.05, 1.10, 1.20, 1.30, 1.40)
    ]
    rows: list[dict[str, Any]] = []
    for strike in grid:
        call_mid, put_mid = inverse_mids_for_forward(strike, forward)
        for side, mid in (("call", call_mid), ("put", put_mid)):
            mid = mid if mid > 0 else 0.01
            rows.append(
                option_row(
                    strike,
                    side,
                    sigma_pct,
                    expiry=expiry,
                    bid=max(mid - 0.002, 0.001),
                    ask=mid + 0.002,
                    quote_as_of=as_of,
                    underlying_price=forward,
                )
            )
    return rows
