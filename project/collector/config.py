from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value is not None else default


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value is not None else default


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_csv_ints(name: str, default: tuple[int, ...]) -> tuple[int, ...]:
    value = os.getenv(name)
    if not value:
        return default
    return tuple(int(part.strip()) for part in value.split(",") if part.strip())


@dataclass(frozen=True)
class Settings:
    deribit_base_url: str = os.getenv("DERIBIT_BASE_URL", "https://www.deribit.com/api/v2")
    db_path: Path = Path(os.getenv("PHASE1_DB_PATH", "project/data/phase1.sqlite3"))
    request_timeout_s: float = _env_float("DERIBIT_TIMEOUT_S", 20.0)

    page_size: int = _env_int("DERIBIT_PAGE_SIZE", 1000)
    max_retries: int = _env_int("PHASE1_MAX_RETRIES", 4)
    retry_backoff_s: float = _env_float("PHASE1_RETRY_BACKOFF_S", 1.5)

    chunk_size_ms: int = _env_int("PHASE1_CHUNK_SIZE_MS", 3_600_000)
    resume_enabled: bool = _env_bool("PHASE1_RESUME_ENABLED", True)

    validation_window_sizes_ms: tuple[int, ...] = _env_csv_ints(
        "PHASE1_VALIDATION_WINDOWS_MS",
        (300_000, 3_600_000),
    )

    @classmethod
    def from_env(cls) -> "Settings":
        return cls()

    def with_overrides(self, **kwargs) -> "Settings":
        return replace(self, **kwargs)
