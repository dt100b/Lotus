"""API contract tests for GET /api/v1/gex-heatmap-surface."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from project.api.main import app, get_repository
from project.api.repository import SnapshotRepository


def write_snapshot(path: Path) -> Path:
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 94750.25,
        "rows": [
            {
                "expiry": "2026-05-01",
                "strike": 90000,
                "net_gex": 1.0,
                "call_gex": 3.0,
                "put_gex": -2.0,
            }
        ],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def write_history(path: Path, samples: list[dict]) -> Path:
    doc = {
        "version": "gex_window_history.v1",
        "methodology": "test methodology",
        "samples": samples,
    }
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def build_client(snapshot_path: Path, artifacts_dir: Path) -> TestClient:
    app.dependency_overrides[get_repository] = lambda: SnapshotRepository(
        snapshot_path,
        artifacts_dir,
    )
    return TestClient(app)


def test_heatmap_surface_empty_when_no_history(tmp_path: Path) -> None:
    snap = write_snapshot(tmp_path / "latest_gex_snapshot.json")
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    client = build_client(snap, artifacts)

    res = client.get("/api/v1/gex-heatmap-surface")
    assert res.status_code == 200
    body = res.json()
    assert body["sample_count"] == 0
    assert body["samples"] == []
    assert body["as_of_ms"] == 0
    assert body["meta"]["retention_ms"] > 0

    app.dependency_overrides.clear()


def test_heatmap_surface_happy_path_and_filters(tmp_path: Path) -> None:
    snap = write_snapshot(tmp_path / "latest_gex_snapshot.json")
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    write_history(
        artifacts / "gex_window_history.json",
        [
            {
                "ts_ms": 1_700_000_000_000,
                "spot": 94000.0,
                "net_gex": -1_000_000.0,
                "by_strike": {"90000": -800000.0, "95000": -200000.0},
            },
            {
                "ts_ms": 1_700_000_900_000,
                "spot": 94500.0,
                "net_gex": -500_000.0,
                "by_strike": {"90000": -100000.0, "92000": 0.0, "95000": -400000.0},
            },
            {
                "ts_ms": 1_700_001_800_000,
                "spot": 95000.0,
                "net_gex": 200_000.0,
                "by_strike": {"95000": 200000.0},
            },
        ],
    )
    client = build_client(snap, artifacts)

    res = client.get("/api/v1/gex-heatmap-surface")
    assert res.status_code == 200
    body = res.json()
    assert body["sample_count"] == 3
    assert body["as_of_ms"] == 1_700_001_800_000
    assert body["samples"][0]["ts_ms"] == 1_700_000_000_000
    # Zero-net strike dropped
    assert [c["strike"] for c in body["samples"][1]["cells"]] == [90000.0, 95000.0]
    assert body["meta"]["methodology"] == "test methodology"

    # Time window filter
    windowed = client.get(
        "/api/v1/gex-heatmap-surface",
        params={"from_ms": 1_700_000_900_000, "to_ms": 1_700_001_800_000},
    )
    assert windowed.status_code == 200
    assert windowed.json()["sample_count"] == 2

    # Downsample keeps endpoints
    capped = client.get("/api/v1/gex-heatmap-surface", params={"max_samples": 2})
    assert capped.status_code == 200
    capped_body = capped.json()
    assert capped_body["sample_count"] == 2
    assert capped_body["samples"][0]["ts_ms"] == 1_700_000_000_000
    assert capped_body["samples"][-1]["ts_ms"] == 1_700_001_800_000

    app.dependency_overrides.clear()


def test_heatmap_surface_sorted_cells(tmp_path: Path) -> None:
    snap = write_snapshot(tmp_path / "latest_gex_snapshot.json")
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    write_history(
        artifacts / "gex_window_history.json",
        [
            {
                "ts_ms": 1_700_000_000_000,
                "spot": 1.0,
                "net_gex": 3.0,
                "by_strike": {"100": 1.0, "50": 2.0},
            }
        ],
    )
    client = build_client(snap, artifacts)
    body = client.get("/api/v1/gex-heatmap-surface").json()
    strikes = [c["strike"] for c in body["samples"][0]["cells"]]
    assert strikes == [50.0, 100.0]
    app.dependency_overrides.clear()
