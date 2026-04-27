from __future__ import annotations

import json
from pathlib import Path
from datetime import timedelta

from fastapi.testclient import TestClient

from project.api.config import settings
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
                "strike": 80000,
                "net_gex": -2.0,
                "call_gex": 0.5,
                "put_gex": -2.5,
            },
            {
                "expiry": "2026-05-01",
                "strike": 90000,
                "net_gex": 1.0,
                "call_gex": 3.0,
                "put_gex": -2.0,
            },
            {
                "expiry": "2026-06-26",
                "strike": 90000,
                "net_gex": 0.0,
                "call_gex": 1.0,
                "put_gex": -1.0,
            },
        ],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def build_client(snapshot_path: Path) -> TestClient:
    app.dependency_overrides[get_repository] = lambda: SnapshotRepository(snapshot_path)
    return TestClient(app)


def build_repository(snapshot_path: Path) -> SnapshotRepository:
    return SnapshotRepository(snapshot_path)


def test_expiries_and_all_profile_aggregate_by_strike(tmp_path: Path) -> None:
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))

    expiries = client.get("/api/v1/expiries")
    assert expiries.status_code == 200
    assert expiries.json()["expiries"] == ["2026-05-01", "2026-06-26"]

    profile = client.get("/api/v1/gex-profile", params={"expiry": "ALL", "view": "net"})
    assert profile.status_code == 200

    body = profile.json()
    assert [point["strike"] for point in body["points"]] == [80000.0, 90000.0]
    assert body["points"][0]["net_gex"] == -2.0
    assert body["points"][1]["net_gex"] == 1.0
    assert body["points"][1]["call_gex"] == 4.0
    assert body["points"][1]["put_gex"] == -3.0
    assert body["points"][1]["value"] == 1.0

    app.dependency_overrides.clear()


def test_single_expiry_and_split_view(tmp_path: Path) -> None:
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))

    profile = client.get("/api/v1/gex-profile", params={"expiry": "2026-05-01", "view": "put"})
    assert profile.status_code == 200

    body = profile.json()
    assert body["selected_expiry"] == "2026-05-01"
    assert body["view"] == "put"
    assert [point["strike"] for point in body["points"]] == [80000.0, 90000.0]
    assert [point["value"] for point in body["points"]] == [-2.5, -2.0]

    app.dependency_overrides.clear()


def test_invalid_expiry_returns_404(tmp_path: Path) -> None:
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))
    response = client.get(
        "/api/v1/gex-profile",
        params={"expiry": "2027-01-01", "view": "net"},
    )

    assert response.status_code == 404
    app.dependency_overrides.clear()


def test_health_returns_503_when_snapshot_missing(tmp_path: Path) -> None:
    missing_path = tmp_path / "missing.json"
    client = build_client(missing_path)

    response = client.get("/api/v1/health")

    assert response.status_code == 503
    assert "Snapshot file not found" in response.json()["detail"]
    app.dependency_overrides.clear()


def test_config_exposes_read_only_dashboard_metadata() -> None:
    client = TestClient(app)

    response = client.get("/api/v1/config")

    assert response.status_code == 200
    assert response.json() == {
        "app_name": settings.app_name,
        "refresh_seconds": settings.refresh_seconds,
        "contract_version": settings.contract_version,
        "default_expiry": settings.default_expiry,
        "default_view": settings.default_view,
        "supported_views": ["net", "call", "put"],
    }


def test_legacy_dashboard_is_archived_and_primary_dashboard_is_pending() -> None:
    client = TestClient(app)

    primary = client.get("/dashboard")
    legacy = client.get("/legacy-dashboard")

    assert primary.status_code == 200
    assert "mock-data first" in primary.text
    assert legacy.status_code == 200
    assert "Deribit BTC GEX Terminal" in legacy.text


def test_health_reports_snapshot_freshness_and_provenance(tmp_path: Path) -> None:
    snapshot_path = write_snapshot(tmp_path / "latest_gex_snapshot.json")
    repository = build_repository(snapshot_path)
    repository._utc_now = lambda: repository._parse_as_of("2026-04-25T21:45:10Z")
    app.dependency_overrides[get_repository] = lambda: repository
    client = TestClient(app)

    response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["contract_version"] == settings.contract_version
    assert body["snapshot_provenance"].endswith("latest_gex_snapshot.json")
    assert body["snapshot_age_seconds"] == 10.0
    assert body["freshness_threshold_seconds"] == settings.refresh_seconds * settings.freshness_multiplier
    assert body["is_fresh"] is True
    app.dependency_overrides.clear()


def test_health_marks_stale_snapshot_when_age_exceeds_threshold(tmp_path: Path) -> None:
    snapshot_path = write_snapshot(tmp_path / "latest_gex_snapshot.json")
    repository = build_repository(snapshot_path)
    threshold = settings.refresh_seconds * settings.freshness_multiplier
    base_time = repository._parse_as_of("2026-04-25T21:45:00Z")
    repository._utc_now = lambda: base_time + timedelta(seconds=threshold + 1)
    app.dependency_overrides[get_repository] = lambda: repository
    client = TestClient(app)

    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json()["is_fresh"] is False
    app.dependency_overrides.clear()


def test_non_btc_snapshot_returns_500(tmp_path: Path) -> None:
    snapshot_path = tmp_path / "latest_gex_snapshot.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "as_of": "2026-04-25T21:45:00Z",
                "underlying": "ETH",
                "spot_price": 3200.0,
                "rows": [],
            }
        ),
        encoding="utf-8",
    )
    client = build_client(snapshot_path)

    response = client.get("/api/v1/health")

    assert response.status_code == 500
    assert "BTC snapshots" in response.json()["detail"]
    app.dependency_overrides.clear()


def test_malformed_snapshot_returns_500(tmp_path: Path) -> None:
    snapshot_path = tmp_path / "latest_gex_snapshot.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "as_of": "2026-04-25T21:45:00Z",
                "underlying": "BTC",
                "spot_price": 94750.25,
                "rows": [
                    {
                        "expiry": "2026-05-01",
                        "strike": 90000,
                        "net_gex": 10.0,
                        "call_gex": 8.0,
                        "put_gex": -1.0,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    client = build_client(snapshot_path)

    response = client.get("/api/v1/gex-profile")

    assert response.status_code == 500
    assert "net_gex = call_gex + put_gex" in response.json()["detail"]
    app.dependency_overrides.clear()


def test_truncated_snapshot_json_returns_500(tmp_path: Path) -> None:
    snapshot_path = tmp_path / "latest_gex_snapshot.json"
    snapshot_path.write_text(
        '{"as_of":"2026-04-25T21:45:00Z","underlying":"BTC","spot_price":94750.25,"rows":[',
        encoding="utf-8",
    )
    client = build_client(snapshot_path)

    response = client.get("/api/v1/health")

    assert response.status_code == 500
    app.dependency_overrides.clear()
