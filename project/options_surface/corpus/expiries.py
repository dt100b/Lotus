"""Curated Deribit expiry selection. Does not scrape every listed expiry."""

from __future__ import annotations

from calendar import monthrange
from datetime import UTC, date, datetime, timedelta
from typing import Any, Iterable, Mapping, Sequence

from project.options_surface.market_data.instruments import parse_option_instrument
from project.options_surface.timeutil import as_utc, inferred_deribit_expiry_utc, parse_expiry_date

CURATED_ROLES = (
    "nearest_eow",
    "following_weekly",
    "nearest_eom",
    "following_monthly_or_quarterly",
)


def select_curated_expiries(
    listed: Sequence[str | date],
    *,
    as_of_utc: datetime,
    max_count: int = 4,
) -> list[dict[str, Any]]:
    """Pick a small, documented set of live listed expiries.

    Roles, when a listed contract exists:
    1. nearest eligible Friday (EOW / weekly)
    2. following Friday
    3. nearest last-Friday-of-month (EOM)
    4. following monthly or quarterly last-Friday
    """
    as_of = as_utc(as_of_utc)
    live = _live_dates(listed, as_of)
    if max_count < 1:
        return []
    fridays = [item for item in live if item.weekday() == 4]
    eoms = [item for item in live if _is_last_friday_of_month(item)]
    role_map: dict[date, list[str]] = {}

    def add(role: str, expiry: date | None) -> None:
        if expiry is None:
            return
        role_map.setdefault(expiry, [])
        if role not in role_map[expiry]:
            role_map[expiry].append(role)

    eow = fridays[0] if fridays else None
    add("nearest_eow", eow)
    following_weekly = next((item for item in fridays if eow is not None and item > eow), None)
    add("following_weekly", following_weekly)
    eom = eoms[0] if eoms else None
    add("nearest_eom", eom)
    following_term = next((item for item in eoms if eom is not None and item > eom), None)
    add("following_monthly_or_quarterly", following_term)
    chosen: list[dict[str, Any]] = []
    for expiry in live:
        if expiry not in role_map:
            continue
        if len(chosen) >= max_count:
            break
        roles = role_map[expiry]
        chosen.append(
            {
                "role": roles[0],
                "roles": roles,
                "expiry": expiry.isoformat(),
                "kind": _kind(expiry),
                "expiry_utc": inferred_deribit_expiry_utc(expiry).isoformat(),
            }
        )
    return chosen


def listed_expiry_dates(
    instruments: Iterable[Mapping[str, Any] | str],
    *,
    underlying: str = "BTC",
) -> list[date]:
    dates: set[date] = set()
    asset = underlying.upper()
    for item in instruments:
        if isinstance(item, str):
            parsed = parse_option_instrument(item)
            if parsed is None:
                try:
                    dates.add(parse_expiry_date(item))
                except ValueError:
                    continue
                continue
            currency, expiry, _strike, _side = parsed
            if currency == asset:
                dates.add(parse_expiry_date(expiry))
            continue
        name = str(item.get("instrument_name") or item.get("instrument") or "")
        parsed = parse_option_instrument(name)
        if parsed is not None:
            currency, expiry, _strike, _side = parsed
            if currency == asset:
                dates.add(parse_expiry_date(expiry))
            continue
        raw = item.get("expiry") or item.get("expiration_date")
        if raw:
            try:
                dates.add(parse_expiry_date(str(raw)[:10]))
            except ValueError:
                continue
    return sorted(dates)


def _live_dates(listed: Sequence[str | date], as_of: datetime) -> list[date]:
    out: list[date] = []
    for item in listed:
        try:
            day = item if isinstance(item, date) and not isinstance(item, datetime) else parse_expiry_date(str(item)[:10])
        except ValueError:
            continue
        if inferred_deribit_expiry_utc(day) > as_of:
            out.append(day)
    return sorted(set(out))


def _is_last_friday_of_month(day: date) -> bool:
    return day.weekday() == 4 and day == _last_friday(day.year, day.month)


def _last_friday(year: int, month: int) -> date:
    last = date(year, month, monthrange(year, month)[1])
    return last - timedelta(days=(last.weekday() - 4) % 7)


def _kind(day: date) -> str:
    if _is_last_friday_of_month(day) and day.month in {3, 6, 9, 12}:
        return "quarterly"
    if _is_last_friday_of_month(day):
        return "eom"
    if day.weekday() == 4:
        return "weekly"
    return "other"
