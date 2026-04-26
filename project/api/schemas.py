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


class DashboardConfigResponse(BaseModel):
    app_name: str
    refresh_seconds: int = Field(ge=1)
    contract_version: str
    default_expiry: str
    default_view: Literal["net", "call", "put"]
    supported_views: list[Literal["net", "call", "put"]]


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
