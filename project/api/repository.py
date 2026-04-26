from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
import json
import math

from .schemas import ExpiryListResponse, GexPoint, GexProfileResponse, HealthResponse

VIEW_TO_FIELD = {
    "net": "net_gex",
    "call": "call_gex",
    "put": "put_gex",
}


class SnapshotRepository:
    def __init__(self, snapshot_path: Path):
        self.snapshot_path = Path(snapshot_path)
        self._cache_mtime_ns: int | None = None
        self._cache_payload: dict | None = None

    def _load_payload(self) -> dict:
        if not self.snapshot_path.exists():
            raise FileNotFoundError(f"Snapshot file not found: {self.snapshot_path}")

        stat = self.snapshot_path.stat()
        if self._cache_payload is not None and self._cache_mtime_ns == stat.st_mtime_ns:
            return self._cache_payload

        with self.snapshot_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)

        self._validate_payload(payload)
        self._cache_mtime_ns = stat.st_mtime_ns
        self._cache_payload = payload
        return payload

    @staticmethod
    def _utc_now() -> datetime:
        return datetime.now(UTC)

    @staticmethod
    def _validate_payload(payload: dict) -> None:
        required_top_level = {"as_of", "underlying", "spot_price", "rows"}
        missing = required_top_level.difference(payload)
        if missing:
            raise ValueError(f"Snapshot missing keys: {sorted(missing)}")

        if payload["underlying"] != "BTC":
            raise ValueError("Phase 5 dashboard only supports BTC snapshots.")

        try:
            SnapshotRepository._parse_as_of(str(payload["as_of"]))
        except ValueError as exc:
            raise ValueError("Snapshot as_of must be ISO-8601.") from exc

        try:
            float(payload["spot_price"])
        except (TypeError, ValueError) as exc:
            raise ValueError("Snapshot spot_price must be numeric.") from exc

        rows = payload["rows"]
        if not isinstance(rows, list):
            raise ValueError("Snapshot rows must be a list.")

        required_row_keys = {"expiry", "strike", "net_gex", "call_gex", "put_gex"}
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"Snapshot row {index} must be an object.")

            missing_row = required_row_keys.difference(row)
            if missing_row:
                raise ValueError(f"Snapshot row missing keys: {sorted(missing_row)}")

            try:
                float(row["strike"])
                net_gex = float(row["net_gex"])
                call_gex = float(row["call_gex"])
                put_gex = float(row["put_gex"])
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Snapshot row {index} has non-numeric GEX fields.") from exc

            if not math.isclose(net_gex, call_gex + put_gex, rel_tol=1e-9, abs_tol=1e-9):
                raise ValueError(f"Snapshot row {index} violates net_gex = call_gex + put_gex.")

    @staticmethod
    def _parse_as_of(value: str) -> datetime:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)

    def health(self, freshness_threshold_seconds: int, contract_version: str) -> HealthResponse:
        payload = self._load_payload()
        as_of = self._parse_as_of(str(payload["as_of"]))
        age_seconds = max((self._utc_now() - as_of).total_seconds(), 0.0)
        return HealthResponse(
            status="ok",
            underlying="BTC",
            as_of=as_of,
            spot_price=float(payload["spot_price"]),
            row_count=len(payload["rows"]),
            snapshot_age_seconds=age_seconds,
            freshness_threshold_seconds=freshness_threshold_seconds,
            is_fresh=age_seconds <= freshness_threshold_seconds,
            contract_version=contract_version,
            snapshot_provenance=str(self.snapshot_path),
        )

    def list_expiries(self) -> ExpiryListResponse:
        payload = self._load_payload()
        expiries = sorted({str(row["expiry"]) for row in payload["rows"]})
        return ExpiryListResponse(
            as_of=self._parse_as_of(str(payload["as_of"])),
            underlying="BTC",
            spot_price=float(payload["spot_price"]),
            expiries=expiries,
        )

    def get_profile(self, expiry: str = "ALL", view: str = "net") -> GexProfileResponse:
        payload = self._load_payload()
        expiries = sorted({str(row["expiry"]) for row in payload["rows"]})

        selected_expiry = expiry or "ALL"
        if selected_expiry != "ALL" and selected_expiry not in expiries:
            raise KeyError(f"Unknown expiry: {selected_expiry}")

        if view not in VIEW_TO_FIELD:
            raise ValueError(f"Unknown view: {view}")

        filtered_rows = payload["rows"]
        if selected_expiry != "ALL":
            filtered_rows = [row for row in filtered_rows if str(row["expiry"]) == selected_expiry]

        by_strike: dict[float, dict[str, float]] = defaultdict(
            lambda: {"net_gex": 0.0, "call_gex": 0.0, "put_gex": 0.0}
        )

        for row in filtered_rows:
            strike = float(row["strike"])
            by_strike[strike]["net_gex"] += float(row["net_gex"])
            by_strike[strike]["call_gex"] += float(row["call_gex"])
            by_strike[strike]["put_gex"] += float(row["put_gex"])

        value_field = VIEW_TO_FIELD[view]
        points = [
            GexPoint(
                strike=strike,
                net_gex=values["net_gex"],
                call_gex=values["call_gex"],
                put_gex=values["put_gex"],
                value=values[value_field],
            )
            for strike, values in sorted(by_strike.items())
        ]

        return GexProfileResponse(
            as_of=self._parse_as_of(str(payload["as_of"])),
            underlying="BTC",
            spot_price=float(payload["spot_price"]),
            selected_expiry=selected_expiry,
            view=view,
            expiries=expiries,
            points=points,
        )
