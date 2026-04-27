from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .repository import SnapshotRepository
from .schemas import DashboardConfigResponse, ExpiryListResponse, GexProfileResponse, HealthResponse

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title=settings.app_name)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_repository = SnapshotRepository(settings.snapshot_path)


def get_repository() -> SnapshotRepository:
    return _repository


@app.get("/", include_in_schema=False)
@app.get("/dashboard", include_in_schema=False)
def dashboard_pending() -> FileResponse:
    return FileResponse(STATIC_DIR / "frontend_pending.html")


@app.get("/legacy-dashboard", include_in_schema=False)
def legacy_dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "dashboard.html")


@app.get("/api/v1/config", response_model=DashboardConfigResponse)
def config() -> DashboardConfigResponse:
    return DashboardConfigResponse(
        app_name=settings.app_name,
        refresh_seconds=settings.refresh_seconds,
        contract_version=settings.contract_version,
        default_expiry=settings.default_expiry,
        default_view=settings.default_view,
        supported_views=["net", "call", "put"],
    )


@app.get("/api/v1/health", response_model=HealthResponse)
def health(repository: SnapshotRepository = Depends(get_repository)) -> HealthResponse:
    try:
        return repository.health(
            freshness_threshold_seconds=settings.refresh_seconds * settings.freshness_multiplier,
            contract_version=settings.contract_version,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/expiries", response_model=ExpiryListResponse)
def expiries(repository: SnapshotRepository = Depends(get_repository)) -> ExpiryListResponse:
    try:
        return repository.list_expiries()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/gex-profile", response_model=GexProfileResponse)
def gex_profile(
    expiry: str = Query("ALL", description='Use "ALL" or a snapshot expiry.'),
    view: Literal["net", "call", "put"] = Query("net"),
    repository: SnapshotRepository = Depends(get_repository),
) -> GexProfileResponse:
    try:
        return repository.get_profile(expiry=expiry, view=view)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("project.api.main:app", host="0.0.0.0", port=8000, reload=True)
