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
    # Flow-regime / gex_window_history artifacts (heatmap surface source).
    artifacts_dir: Path = Path(
        os.getenv("GEX_ARTIFACTS_DIR", "project/runtime/dashboard_build")
    )
    # Presentation poll hint; frontend live mode currently polls every 30s.
    refresh_seconds: int = int(os.getenv("GEX_REFRESH_SECONDS", "30"))
    contract_version: str = os.getenv("GEX_CONTRACT_VERSION", "phase5.dashboard.v2")
    default_expiry: str = os.getenv("GEX_DEFAULT_EXPIRY", "ALL")
    default_view: str = os.getenv("GEX_DEFAULT_VIEW", "net")
    # Phase 6 materialize cycles often take 45–120s; keep is_fresh tolerant.
    freshness_multiplier: int = int(os.getenv("GEX_FRESHNESS_MULTIPLIER", "6"))


settings = Settings()
