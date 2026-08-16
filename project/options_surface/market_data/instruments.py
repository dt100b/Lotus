"""Parse Deribit option and future instrument names."""

from __future__ import annotations

from datetime import datetime
import math
import re
from typing import Any

from project.options_surface.timeutil import parse_expiry_timestamp

_OPTION_RE = re.compile(
    r"^(?P<currency>[A-Z0-9]+)-(?P<expiry>\d{1,2}[A-Z]{3}\d{2})-"
    r"(?P<strike>\d+(?:\.\d+)?)-(?P<side>[CP])$",
    re.IGNORECASE,
)
_FUTURE_RE = re.compile(
    r"^(?P<currency>[A-Z0-9]+)-(?P<expiry>\d{1,2}[A-Z]{3}\d{2})$",
    re.IGNORECASE,
)
_PERP_RE = re.compile(r"^(?P<currency>[A-Z0-9]+)-PERPETUAL$", re.IGNORECASE)


def parse_option_instrument(value: Any) -> tuple[str, str, float, str] | None:
    match = _OPTION_RE.fullmatch(str(value or "").strip())
    if match is None:
        return None
    try:
        expiry = datetime.strptime(match.group("expiry").upper(), "%d%b%y").date().isoformat()
        strike = float(match.group("strike"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(strike) or strike <= 0:
        return None
    side = "call" if match.group("side").upper() == "C" else "put"
    return match.group("currency").upper(), expiry, strike, side


def parse_future_instrument(value: Any) -> tuple[str, str | None, bool] | None:
    text = str(value or "").strip()
    perp = _PERP_RE.fullmatch(text)
    if perp is not None:
        return perp.group("currency").upper(), None, True
    match = _FUTURE_RE.fullmatch(text)
    if match is None:
        return None
    try:
        expiry = datetime.strptime(match.group("expiry").upper(), "%d%b%y").date().isoformat()
    except (TypeError, ValueError):
        return None
    return match.group("currency").upper(), expiry, False


def optional_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def optional_positive(value: Any) -> float | None:
    parsed = optional_float(value)
    if parsed is None or parsed <= 0.0:
        return None
    return parsed


def optional_non_negative(value: Any) -> float | None:
    parsed = optional_float(value)
    if parsed is None or parsed < 0.0:
        return None
    return parsed


def instrument_expiry_utc(row: Any) -> datetime | None:
    if not isinstance(row, dict):
        return None
    return parse_expiry_timestamp(
        row.get("expiration_timestamp") or row.get("expiry_utc")
    )
