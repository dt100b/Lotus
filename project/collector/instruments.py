from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from collector.deribit_client import DeribitClient


@dataclass(frozen=True)
class InstrumentSyncResult:
    instruments: list[dict[str, Any]]
    count: int


def sync_btc_option_instruments(
    client: DeribitClient,
    *,
    include_expired: bool = False,
) -> InstrumentSyncResult:
    instruments = client.get_instruments(
        currency="BTC",
        kind="option",
        expired=include_expired,
    )
    return InstrumentSyncResult(instruments=instruments, count=len(instruments))
