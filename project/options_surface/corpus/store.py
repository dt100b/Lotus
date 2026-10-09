"""Append-only, atomic JSONL store for capture records."""

from __future__ import annotations

from datetime import UTC, date, datetime
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Iterator, Mapping

from project.options_surface.corpus.schema import (
    CAPTURE_SCHEMA_VERSION,
    IDENTIFIED_INCOMPATIBLE_SCHEMAS,
    REQUIRED_CAPTURE_FIELDS,
    SUPPORTED_CAPTURE_SCHEMAS,
)
from project.options_surface.timeutil import as_utc

SECRET_KEYS = frozenset(
    {
        "authorization",
        "api_key",
        "apikey",
        "secret",
        "password",
        "token",
        "access_token",
        "refresh_token",
        "credential",
        "private_key",
    }
)


class SchemaCompatibilityError(ValueError):
    """Raised when a record cannot be mixed into the current corpus schema."""


class CorpusSnapshotStore:
    """Versioned JSONL corpus plus atomic sidecar records."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / "records").mkdir(parents=True, exist_ok=True)
        (self.directory / "locks").mkdir(parents=True, exist_ok=True)
        self._ensure_manifest()

    def persist(self, record: Mapping[str, Any]) -> Path:
        payload = _json_safe(redact_secrets(dict(record)))
        payload.setdefault("schema_version", CAPTURE_SCHEMA_VERSION)
        snapshot_id = str(payload.get("snapshot_id") or "")
        if not snapshot_id:
            raise ValueError("Capture record requires snapshot_id.")
        _validate_complete(payload)
        line = serialize_record(payload)
        sidecar = self.directory / "records" / f"{snapshot_id}.json"
        _atomic_write_text(sidecar, json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n")
        jsonl_path = self._jsonl_path(payload)
        _append_jsonl_line(jsonl_path, line)
        return sidecar

    def load(self, snapshot_id: str) -> dict[str, Any]:
        sidecar = self.directory / "records" / f"{snapshot_id}.json"
        if not sidecar.exists():
            raise FileNotFoundError(f"Unknown snapshot_id: {snapshot_id}")
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
        status = classify_schema(payload)
        if status != "supported":
            raise SchemaCompatibilityError(
                f"Snapshot {snapshot_id} has schema {payload.get('schema_version')!r} ({status})."
            )
        return payload

    def iter_records(
        self,
        *,
        include_incompatible: bool = False,
    ) -> Iterator[dict[str, Any]]:
        for path in self.jsonl_paths():
            yield from iter_jsonl_file(path, include_incompatible=include_incompatible)

    def jsonl_paths(self) -> list[Path]:
        paths = sorted(self.directory.glob("????/??/captures-????-??-??.jsonl"))
        legacy = self.directory / "captures.jsonl"
        if legacy.exists():
            paths.append(legacy)
        return paths

    def _jsonl_path(self, payload: Mapping[str, Any]) -> Path:
        stamp = _asof_date(payload)
        year, month, _day = stamp.split("-")
        folder = self.directory / year / month
        folder.mkdir(parents=True, exist_ok=True)
        return folder / f"captures-{stamp}.jsonl"

    def _ensure_manifest(self) -> None:
        path = self.directory / "manifest.json"
        if path.exists():
            return
        payload = {
            "schema_version": CAPTURE_SCHEMA_VERSION,
            "created_utc": datetime.now(UTC).isoformat(),
            "format": "jsonl+sidecar",
            "append_only": True,
        }
        _atomic_write_text(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def serialize_record(record: Mapping[str, Any]) -> str:
    sanitized = _json_safe(redact_secrets(dict(record)))
    return json.dumps(sanitized, separators=(",", ":"), sort_keys=True, allow_nan=False)


def redact_secrets(payload: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in payload.items():
        if str(key).lower() in SECRET_KEYS:
            continue
        if isinstance(value, Mapping):
            out[key] = redact_secrets(value)
        elif isinstance(value, list):
            out[key] = [
                redact_secrets(item) if isinstance(item, Mapping) else item for item in value
            ]
        else:
            out[key] = value
    return out


def classify_schema(record: Mapping[str, Any]) -> str:
    version = str(record.get("schema_version") or "")
    if version in SUPPORTED_CAPTURE_SCHEMAS:
        return "supported"
    if version in IDENTIFIED_INCOMPATIBLE_SCHEMAS:
        return "incompatible_identified"
    if not version:
        return "missing_schema"
    return "unknown"


def iter_jsonl_file(
    path: Path,
    *,
    include_incompatible: bool = False,
) -> Iterator[dict[str, Any]]:
    if not path.exists():
        return
    for parsed in iter_jsonl_lines(path.read_text(encoding="utf-8")):
        if parsed.get("_corrupt"):
            yield parsed
            continue
        status = classify_schema(parsed)
        parsed["_schema_status"] = status
        if status == "supported":
            yield parsed
        elif include_incompatible:
            yield parsed
        else:
            yield {**parsed, "_skipped_incompatible": True}


def iter_jsonl_lines(text: str) -> Iterator[dict[str, Any]]:
    for index, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            yield {
                "_corrupt": True,
                "_corrupt_line": index,
                "_schema_status": "corrupt",
            }
            continue
        if not isinstance(payload, dict):
            yield {
                "_corrupt": True,
                "_corrupt_line": index,
                "_schema_status": "corrupt",
            }
            continue
        yield payload


def _validate_complete(payload: Mapping[str, Any]) -> None:
    missing = [key for key in REQUIRED_CAPTURE_FIELDS if key not in payload]
    if missing:
        raise ValueError(f"Incomplete capture record, missing {missing}.")
    if classify_schema(payload) != "supported":
        raise SchemaCompatibilityError(
            f"Cannot persist schema {payload.get('schema_version')!r}."
        )


def _asof_date(payload: Mapping[str, Any]) -> str:
    raw = payload.get("as_of_utc") or payload.get("capture_utc")
    if isinstance(raw, datetime):
        return as_utc(raw).date().isoformat()
    text = str(raw or "")
    return text[:10] if len(text) >= 10 else datetime.now(UTC).date().isoformat()


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _append_jsonl_line(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(line)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())


def _json_safe(value: Any) -> Any:
    if isinstance(value, datetime):
        return as_utc(value).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, float):
        if value != value or value in {float("inf"), float("-inf")}:
            return None
    return value


def _reject_nonfinite(value: Any) -> Any:
    return _json_safe(value)
