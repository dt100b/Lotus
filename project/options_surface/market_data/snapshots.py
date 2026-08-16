"""Append-only persistence for options-surface snapshots."""

from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
from typing import Any, Mapping

from project.options_surface.timeutil import as_utc
from project.options_surface.types import OptionsSurfaceResult, to_public_dict

SCHEMA_VERSION = "options_surface.v1"


class OptionsSurfaceSnapshotStore:
    """Immutable JSONL archive plus a latest-per-expiry pointer."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.jsonl_path = self.directory / "snapshots.jsonl"

    def persist(self, result: OptionsSurfaceResult | Mapping[str, Any]) -> Path:
        payload = to_public_dict(result) if isinstance(result, OptionsSurfaceResult) else dict(result)
        payload.setdefault("schema_version", SCHEMA_VERSION)
        line = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        with self.jsonl_path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        latest = self._latest_path(
            str(payload.get("underlying") or "BTC"),
            str(payload.get("expiry_utc") or payload.get("expiry") or "unknown"),
        )
        latest.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return latest

    def load_latest(self, underlying: str, expiry_utc: datetime | str) -> dict[str, Any] | None:
        path = self._latest_path(underlying, expiry_utc)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def iter_jsonl(self) -> list[dict[str, Any]]:
        if not self.jsonl_path.exists():
            return []
        records: list[dict[str, Any]] = []
        for line in self.jsonl_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                records.append(json.loads(line))
        return records

    def _latest_path(self, underlying: str, expiry_utc: datetime | str) -> Path:
        if isinstance(expiry_utc, datetime):
            stamp = as_utc(expiry_utc).date().isoformat()
        else:
            text = str(expiry_utc)
            stamp = text[:10] if len(text) >= 10 else text.replace(":", "")
        safe_asset = "".join(ch for ch in underlying.upper() if ch.isalnum()) or "BTC"
        return self.directory / f"latest_{safe_asset}_{stamp}.json"
