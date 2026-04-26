from __future__ import annotations

import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Iterable, Mapping, Protocol

import httpx

from greeks.types import GreekSnapshot


class GreeksProvider(Protocol):
    def fetch_current_option_greeks(self, currency: str = "BTC") -> dict[str, GreekSnapshot]:
        ...


class StaticGreeksProvider:
    def __init__(self, snapshots: Mapping[str, GreekSnapshot]) -> None:
        self._snapshots = dict(snapshots)

    def fetch_current_option_greeks(self, currency: str = "BTC") -> dict[str, GreekSnapshot]:
        _validate_currency(currency)
        return dict(self._snapshots)

    @classmethod
    def from_json(cls, path: str | Path) -> "StaticGreeksProvider":
        return cls(load_greeks_snapshot_json(path))


class DeribitPublicGreeksProvider:
    def __init__(
        self,
        base_url: str = "https://www.deribit.com/api/v2",
        timeout_seconds: float = 10.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout_seconds,
            headers={"Accept": "application/json"},
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "DeribitPublicGreeksProvider":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def fetch_current_option_greeks(self, currency: str = "BTC") -> dict[str, GreekSnapshot]:
        _validate_currency(currency)

        response = self._client.get(
            "/public/get_book_summary_by_currency",
            params={"currency": currency.upper(), "kind": "option"},
        )
        response.raise_for_status()
        payload = response.json()

        result = payload.get("result")
        if not isinstance(result, list):
            raise ValueError(f"Unexpected Deribit payload: {payload}")

        instrument_names = [
            str(row["instrument_name"])
            for row in result
            if row.get("instrument_name")
        ]
        return self.fetch_greeks_for_instruments(instrument_names)

    def fetch_greeks_for_instruments(
        self,
        instrument_names: Iterable[str],
    ) -> dict[str, GreekSnapshot]:
        snapshots: dict[str, GreekSnapshot] = {}
        fallback_snapshot_ts = int(time.time() * 1000)

        for instrument_name in sorted({str(name) for name in instrument_names if name}):
            response = self._client.get(
                "/public/ticker",
                params={"instrument_name": instrument_name},
            )
            response.raise_for_status()
            payload = response.json()
            result = payload.get("result")
            if not isinstance(result, dict):
                continue

            greeks = result.get("greeks") or {}
            gamma = greeks.get("gamma")
            spot_price = self._extract_spot_price(result)
            snapshot_ts = int(result.get("timestamp") or fallback_snapshot_ts)

            if gamma is None or spot_price is None:
                continue

            snapshots[instrument_name] = GreekSnapshot(
                instrument_name=instrument_name,
                gamma=float(gamma),
                spot_price=float(spot_price),
                snapshot_ts=snapshot_ts,
            )

        return snapshots

    @staticmethod
    def _extract_spot_price(row: dict[str, object]) -> float | None:
        for key in (
            "underlying_price",
            "index_price",
            "underlying_index_price",
            "estimated_delivery_price",
        ):
            value = row.get(key)
            if value is not None:
                return float(value)
        return None


def write_greeks_snapshot_json(
    snapshots: Mapping[str, GreekSnapshot],
    path: str | Path,
) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = [asdict(snapshot) for _, snapshot in sorted(snapshots.items(), key=lambda item: item[0])]
    target.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def load_greeks_snapshot_json(path: str | Path) -> dict[str, GreekSnapshot]:
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    snapshots: dict[str, GreekSnapshot] = {}

    for row in rows:
        snapshot = GreekSnapshot(
            instrument_name=str(row["instrument_name"]),
            gamma=float(row["gamma"]),
            spot_price=float(row["spot_price"]),
            snapshot_ts=int(row["snapshot_ts"]),
        )
        snapshots[snapshot.instrument_name] = snapshot

    return snapshots


def _validate_currency(currency: str) -> None:
    if currency.upper() != "BTC":
        raise ValueError("Phase 4 greeks provider is BTC-only.")
