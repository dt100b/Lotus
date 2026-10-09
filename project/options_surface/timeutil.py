"""Time conventions for the options surface."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any

SECONDS_PER_YEAR = 365.0 * 24.0 * 60.0 * 60.0
DERIBIT_SETTLEMENT_HOUR_UTC = 8


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def parse_expiry_date(expiry: str) -> date:
    text = str(expiry).strip()
    if text.upper() == "ALL":
        raise ValueError('Options surface requires one ISO expiry; "ALL" is not supported.')
    try:
        parsed = date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(
            f"Invalid expiry '{expiry}'; expected an ISO date (YYYY-MM-DD)."
        ) from exc
    if parsed.isoformat() != text:
        raise ValueError(
            f"Invalid expiry '{expiry}'; expected an ISO date (YYYY-MM-DD)."
        )
    return parsed


def inferred_deribit_expiry_utc(expiry: str | date) -> datetime:
    """08:00 UTC on the listed expiry date. Used only when venue timestamp is missing."""
    day = parse_expiry_date(expiry) if isinstance(expiry, str) else expiry
    return datetime.combine(day, time(hour=DERIBIT_SETTLEMENT_HOUR_UTC), tzinfo=UTC)


def parse_expiry_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return as_utc(value)
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not (numeric > 0) or numeric != numeric:
        return None
    if numeric > 1e14:
        numeric /= 1_000_000.0
    elif numeric > 1e11:
        numeric /= 1_000.0
    try:
        return datetime.fromtimestamp(numeric, tz=UTC)
    except (OSError, OverflowError, ValueError):
        return None


def resolve_expiry_utc(
    expiry: str,
    instrument_expiration: Any = None,
) -> tuple[datetime, bool]:
    parsed = parse_expiry_timestamp(instrument_expiration)
    if parsed is not None:
        return parsed, False
    return inferred_deribit_expiry_utc(expiry), True


def year_fraction(as_of_utc: datetime, expiry_utc: datetime) -> float:
    seconds = (as_utc(expiry_utc) - as_utc(as_of_utc)).total_seconds()
    return seconds / SECONDS_PER_YEAR


def require_positive_year_fraction(as_of_utc: datetime, expiry_utc: datetime) -> float:
    tau = year_fraction(as_of_utc, expiry_utc)
    if tau <= 0.0:
        raise ValueError(
            f"Expiry {as_utc(expiry_utc).isoformat()} is not after "
            f"as_of {as_utc(as_of_utc).isoformat()}."
        )
    return tau


def tenor_bucket(time_to_expiry_years: float | None) -> str:
    days = (
        float(time_to_expiry_years) * 365.0
        if time_to_expiry_years is not None and time_to_expiry_years > 0
        else 0.0
    )
    if days <= 2.0:
        return "0_2_dte"
    if days <= 14.0:
        return "3_14_dte"
    return "15_plus_dte"


ANALYSIS_TENOR_BUCKETS = (
    "0_2_dte",
    "3_7_dte",
    "8_14_dte",
    "15_30_dte",
    "31_90_dte",
    "gt_90_dte",
)


def analysis_tenor_bucket(time_to_expiry_years: float | None) -> str:
    """Descriptive corpus buckets. Does not change serving coverage floors."""
    days = (
        float(time_to_expiry_years) * 365.0
        if time_to_expiry_years is not None and time_to_expiry_years > 0
        else 0.0
    )
    if days <= 2.0:
        return "0_2_dte"
    if days <= 7.0:
        return "3_7_dte"
    if days <= 14.0:
        return "8_14_dte"
    if days <= 30.0:
        return "15_30_dte"
    if days <= 90.0:
        return "31_90_dte"
    return "gt_90_dte"


def days_to_expiry(as_of_utc: datetime, expiry_utc: datetime) -> float:
    return max((as_utc(expiry_utc) - as_utc(as_of_utc)) / timedelta(days=1), 0.0)


def seconds_to_expiry(as_of_utc: datetime, expiry_utc: datetime) -> float:
    return max((as_utc(expiry_utc) - as_utc(as_of_utc)).total_seconds(), 0.0)


def tenor_coverage_floors(time_to_expiry_years: float | None) -> tuple[int, int, float]:
    """Return (min_strikes, min_side_strikes, max_center_log_gap)."""
    label = tenor_bucket(time_to_expiry_years)
    if label == "0_2_dte":
        return 8, 3, 0.06
    if label == "3_14_dte":
        return 12, 4, 0.04
    return 16, 5, 0.05


def parse_quote_as_of(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return as_utc(value)
    if isinstance(value, (int, float)):
        return parse_expiry_timestamp(value)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return as_utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def hours_to_expiry(as_of_utc: datetime, expiry_utc: datetime) -> float:
    return max((as_utc(expiry_utc) - as_utc(as_of_utc)) / timedelta(hours=1), 0.0)
