from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("GEX_APP_NAME", "Deribit BTC GEX Terminal")
    snapshot_path: Path = Path(
        os.getenv("GEX_SNAPSHOT_PATH", "project/greeks/data/latest_gex_snapshot.json")
    )
    refresh_seconds: int = int(os.getenv("GEX_REFRESH_SECONDS", "5"))
    contract_version: str = os.getenv("GEX_CONTRACT_VERSION", "phase5.dashboard.v1")
    default_expiry: str = os.getenv("GEX_DEFAULT_EXPIRY", "ALL")
    default_view: str = os.getenv("GEX_DEFAULT_VIEW", "net")
    freshness_multiplier: int = int(os.getenv("GEX_FRESHNESS_MULTIPLIER", "3"))


settings = Settings()
