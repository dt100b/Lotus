from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
import sys

# repository imports top-level packages under project/ (e.g. pipeline.*).
# Ensure that directory is on sys.path when launched via
# `uvicorn project.api.main:app` without a prior editable install / PYTHONPATH.
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .repository import SnapshotRepository
from pipeline.deribit_iv_chain import IvChainProviderError
from project.options_surface.market_data.futures import DeribitFuturesProvider
from .schemas import (
    DashboardConfigResponse,
    ExpiryListResponse,
    GexForwardSurfaceResponse,
    GexHeatmapSurfaceResponse,
    GexProfileResponse,
    HealthResponse,
    IvSignalScanResponse,
    OptionsSurfaceResponse,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
FRONTEND_DIST_DIR = BASE_DIR.parents[1] / "frontend" / "dist"

_repository = SnapshotRepository(
    settings.snapshot_path,
    settings.artifacts_dir,
    futures_provider=DeribitFuturesProvider(),
)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Own the ticker worker without opening sockets during module import."""

    app.state.repository = _repository
    try:
        _repository.start()
        app.state.iv_stream_start_error = None
    except Exception as exc:  # keep non-IV dashboard surfaces available
        app.state.iv_stream_start_error = f"{type(exc).__name__}: {exc}"
    try:
        yield
    finally:
        _repository.close()


app = FastAPI(title=settings.app_name, lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
    ],
    allow_methods=["GET"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
if (FRONTEND_DIST_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST_DIR / "assets"), name="frontend-assets")


def get_repository() -> SnapshotRepository:
    return _repository


@app.get("/", include_in_schema=False)
@app.get("/dashboard", include_in_schema=False)
def dashboard_pending() -> FileResponse:
    if (FRONTEND_DIST_DIR / "index.html").exists():
        return FileResponse(FRONTEND_DIST_DIR / "index.html")

    return FileResponse(STATIC_DIR / "frontend_pending.html")


@app.get("/favicon.svg", include_in_schema=False)
def frontend_favicon() -> FileResponse:
    favicon = FRONTEND_DIST_DIR / "favicon.svg"
    if favicon.exists():
        return FileResponse(favicon)
    raise HTTPException(status_code=404, detail="favicon not found")


@app.get("/icons.svg", include_in_schema=False)
def frontend_icons() -> FileResponse:
    icons = FRONTEND_DIST_DIR / "icons.svg"
    if icons.exists():
        return FileResponse(icons)
    raise HTTPException(status_code=404, detail="icons not found")


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
        supported_ledger_policies=["exclude_otc_prints", "include_otc_prints"],
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
    include_otc_prints: bool = Query(
        False,
        description=(
            "ARCHIVED: secondary include-OTC (blocks/combos) profile. "
            "Default false = production profile. Live desk does not use this; "
            "see project/docs/archived_include_otc_prints.md."
        ),
    ),
    repository: SnapshotRepository = Depends(get_repository),
) -> GexProfileResponse:
    try:
        return repository.get_profile(
            expiry=expiry,
            view=view,
            include_otc_prints=include_otc_prints,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/terminal-snapshot")
def terminal_snapshot(
    expiry: str = Query("ALL", description='Use "ALL" or a snapshot expiry.'),
    repository: SnapshotRepository = Depends(get_repository),
) -> dict:
    """Terminal-ready snapshot.

    Always returns production ``gamma_bars`` (blocks/combos excluded).
    Optional archived ``gamma_bars_include_otc`` may appear if dual materialize
    was re-enabled; the live desk ignores it.
    """
    try:
        return repository.get_terminal_snapshot(expiry=expiry)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/options-surface", response_model=OptionsSurfaceResponse)
def options_surface(
    expiry: str = Query(
        ...,
        description="One listed ISO expiry (YYYY-MM-DD); ALL is not supported.",
    ),
    repository: SnapshotRepository = Depends(get_repository),
) -> OptionsSurfaceResponse:
    """Market-implied options surface for one expiry. Not a directional forecast."""
    try:
        return repository.get_options_surface(
            expiry=expiry,
            freshness_threshold_seconds=(
                settings.refresh_seconds * settings.freshness_multiplier
            ),
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except IvChainProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/iv-signal-scan", response_model=IvSignalScanResponse)
def iv_signal_scan(
    expiry: str = Query(
        ...,
        description="One listed ISO expiry (YYYY-MM-DD); ALL is not supported.",
    ),
    tail_threshold: float = Query(
        0.02,
        gt=0.0,
        lt=0.5,
        description="Fractional distance from spot defining each far tail.",
    ),
    band_width: float = Query(
        0.03,
        gt=0.0,
        lt=0.5,
        description="Fractional half-width of the near-spot concentration band.",
    ),
    signal_delta: float = Query(
        0.03,
        gt=0.0,
        lt=0.5,
        description="Minimum probability-mass difference needed to activate a vote.",
    ),
    repository: SnapshotRepository = Depends(get_repository),
) -> IvSignalScanResponse:
    """Quick-view IV density scanner for one live snapshot expiry."""
    try:
        return repository.get_iv_signal_scan(
            expiry=expiry,
            tail_threshold=tail_threshold,
            band_width=band_width,
            signal_delta=signal_delta,
            freshness_threshold_seconds=(
                settings.refresh_seconds * settings.freshness_multiplier
            ),
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except IvChainProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/gex-forward-surface", response_model=GexForwardSurfaceResponse)
def gex_forward_surface(
    n_times: int = Query(64, ge=8, le=256, description="Time samples from now → settle."),
    n_prices: int = Query(128, ge=16, le=512, description="Price grid density."),
    price_window_pct: float = Query(
        8.0,
        ge=2.0,
        le=25.0,
        description="Half-window around spot expanded by active selected-expiry strikes.",
    ),
    metric: Literal["gamma", "delta", "delta_change", "charm", "vanna"] = Query(
        "gamma", description="Projected dealer Greek field."
    ),
    iv_shift: float = Query(
        0.0,
        ge=-10.0,
        le=10.0,
        description=(
            "Parallel IV shock in volatility points before projection. "
            "Scope caps: ±2 (0DTE), ±5 (EOW), ±10 (EOM)."
        ),
    ),
    expiry_scope: Literal["0dte", "eow", "eom"] = Query(
        "0dte",
        description=(
            "Single expiry cliff: nearest live (0dte), this Friday (eow), "
            "or the next last-Friday monthly (eom)."
        ),
    ),
    repository: SnapshotRepository = Depends(get_repository),
) -> GexForwardSurfaceResponse:
    """Single-expiry forward Greek surface (pure τ projection; not historical heatmap).

    Holds the front-expiry chain fixed and revalues net GEX ($/1%) on a dense
    future (time × price) grid. Empty grid when the selected book is unavailable.
    """
    try:
        return repository.get_forward_surface(
            n_times=n_times,
            n_prices=n_prices,
            price_window_pct=price_window_pct,
            metric=metric,
            iv_shift=iv_shift,
            expiry_scope=expiry_scope,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/gex-heatmap-surface", response_model=GexHeatmapSurfaceResponse)
def gex_heatmap_surface(
    from_ms: int | None = Query(None, description="Inclusive lower bound (epoch ms)."),
    to_ms: int | None = Query(None, description="Inclusive upper bound (epoch ms)."),
    max_samples: int | None = Query(
        None,
        ge=1,
        le=2000,
        description="Optional even downsample cap for client render budgets.",
    ),
    repository: SnapshotRepository = Depends(get_repository),
) -> GexHeatmapSurfaceResponse:
    """Net GEX time × strike surface from gex_window_history (true heatmap data).

    Returns an empty ``samples`` list when history has not warmed yet — never 503
    solely for a missing ring file.
    """
    try:
        return repository.get_heatmap_surface(
            from_ms=from_ms,
            to_ms=to_ms,
            max_samples=max_samples,
        )
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("project.api.main:app", host="0.0.0.0", port=8000, reload=True)
