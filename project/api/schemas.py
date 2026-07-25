from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ExpiryListResponse(BaseModel):
    as_of: datetime
    underlying: Literal["BTC"]
    spot_price: float
    expiries: list[str]


class GexPoint(BaseModel):
    strike: float
    net_gex: float
    call_gex: float
    put_gex: float
    value: float


class GexProfileResponse(BaseModel):
    as_of: datetime
    underlying: Literal["BTC"]
    spot_price: float
    selected_expiry: str
    view: Literal["net", "call", "put"]
    expiries: list[str]
    points: list[GexPoint]
    # Default remains exclude_otc_prints (production). include_otc_prints when requested.
    ledger_policy: Literal["exclude_otc_prints", "include_otc_prints"] = "exclude_otc_prints"
    include_otc_prints_available: bool = False


class DashboardConfigResponse(BaseModel):
    app_name: str
    refresh_seconds: int = Field(ge=1)
    contract_version: str
    default_expiry: str
    default_view: Literal["net", "call", "put"]
    supported_views: list[Literal["net", "call", "put"]]
    # Presentation hint: secondary include-OTC chart mode is supported when snapshot has it.
    supported_ledger_policies: list[Literal["exclude_otc_prints", "include_otc_prints"]] = Field(
        default_factory=lambda: ["exclude_otc_prints", "include_otc_prints"]
    )


class HealthResponse(BaseModel):
    status: Literal["ok"]
    underlying: Literal["BTC"]
    as_of: datetime
    spot_price: float
    row_count: int = Field(ge=0)
    snapshot_age_seconds: float = Field(ge=0)
    freshness_threshold_seconds: int = Field(ge=1)
    is_fresh: bool
    contract_version: str
    snapshot_provenance: str


class GexHeatmapCell(BaseModel):
    strike: float
    net_gex: float


class GexHeatmapSample(BaseModel):
    ts_ms: int
    spot: float
    net_gex: float
    cells: list[GexHeatmapCell]


class GexHeatmapSurfaceMeta(BaseModel):
    retention_ms: int
    methodology: str
    note: str
    version: str


class GexHeatmapSurfaceResponse(BaseModel):
    """Time × strike net-GEX surface for the gamma heatmap (from gex_window_history)."""

    as_of_ms: int
    version: str
    sample_count: int = Field(ge=0)
    samples: list[GexHeatmapSample]
    meta: GexHeatmapSurfaceMeta
