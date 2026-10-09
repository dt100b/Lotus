"""API contract tests for GET /api/v1/gex-forward-surface."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from project.api.main import app, get_repository
from project.api.repository import SnapshotRepository


def write_snapshot(path: Path, *, as_of: str = "2026-07-30T12:00:00Z") -> Path:
    payload = {
        "as_of": as_of,
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            {
                "expiry": "2026-07-31",
                "strike": 64000,
                "net_gex": -1_500_000.0,
                "call_gex": -500_000.0,
                "put_gex": -1_000_000.0,
                "call_mark_iv": 48.0,
                "put_mark_iv": 52.0,
                "mark_iv": 50.0,
            },
            {
                "expiry": "2026-07-31",
                "strike": 66000,
                "net_gex": 2_000_000.0,
                "call_gex": 2_500_000.0,
                "put_gex": -500_000.0,
                "call_mark_iv": 42.0,
                "put_mark_iv": 44.0,
                "mark_iv": 43.0,
            },
            {
                "expiry": "2026-08-02",
                "strike": 65000,
                "net_gex": -2_000_000.0,
                "call_gex": -1_000_000.0,
                "put_gex": -1_000_000.0,
                "mark_iv": 49.0,
            },
            {
                "expiry": "2026-08-07",
                "strike": 65000,
                "net_gex": 3_000_000.0,
                "call_gex": 4_000_000.0,
                "put_gex": -1_000_000.0,
                "mark_iv": 51.0,
            },
            {
                "expiry": "2026-08-28",
                "strike": 65000,
                "net_gex": 9_000_000.0,
                "call_gex": 10_000_000.0,
                "put_gex": -1_000_000.0,
                "mark_iv": 55.0,
            },
        ],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def build_client(snapshot_path: Path) -> TestClient:
    app.dependency_overrides[get_repository] = lambda: SnapshotRepository(snapshot_path)
    return TestClient(app)


def test_forward_surface_happy_path(tmp_path: Path) -> None:
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))
    res = client.get("/api/v1/gex-forward-surface?n_times=12&n_prices=24")
    assert res.status_code == 200
    body = res.json()
    assert body["expiry"] == "2026-07-31"
    assert body["spot"] == 65000.0
    assert len(body["times"]) == 12
    assert len(body["prices"]) == 24
    assert len(body["values"]) == 12
    assert all(len(col) == 24 for col in body["values"])
    assert body["meta"]["leg_count"] == 4
    assert body["meta"]["version"].startswith("gex_forward")
    assert body["meta"]["position_recovery"] == "gex_inversion"
    assert body["meta"]["reference_gex_coverage"] == 1.0
    assert body["times"][0] < body["times"][-1]
    app.dependency_overrides.clear()


def test_forward_surface_empty_when_no_iv(tmp_path: Path) -> None:
    path = tmp_path / "latest_gex_snapshot.json"
    payload = {
        "as_of": "2026-07-30T12:00:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            {
                "expiry": "2026-07-31",
                "strike": 65000,
                "net_gex": 1.0,
                "call_gex": 1.0,
                "put_gex": 0.0,
                # no mark_iv
            }
        ],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)
    res = client.get("/api/v1/gex-forward-surface")
    assert res.status_code == 200
    body = res.json()
    assert body["times"] == []
    assert body["values"] == []
    app.dependency_overrides.clear()


def test_forward_surface_metric_and_iv_shift_query(tmp_path: Path) -> None:
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))
    res = client.get(
        "/api/v1/gex-forward-surface?metric=delta_change&iv_shift=1&n_times=8&n_prices=16"
    )
    assert res.status_code == 200
    body = res.json()
    assert body["meta"]["metric"] == "delta_change"
    assert body["meta"]["iv_shift"] == 1.0
    assert body["meta"]["positioning_source"] == "flow"
    assert body["meta"]["unit"] == "USD hedge change"
    app.dependency_overrides.clear()


def test_forward_surface_expiry_scopes_select_exact_chain(tmp_path: Path) -> None:
    client = build_client(write_snapshot(
        tmp_path / "latest_gex_snapshot.json",
        as_of="2026-08-01T12:00:00Z",
    ))

    eow = client.get("/api/v1/gex-forward-surface?expiry_scope=eow")
    assert eow.status_code == 200
    assert eow.json()["expiry"] == "2026-08-07"
    assert eow.json()["meta"]["expiry_scope"] == "eow"

    eow_shock = client.get(
        "/api/v1/gex-forward-surface?expiry_scope=eow&iv_shift=5"
    )
    assert eow_shock.status_code == 200
    assert eow_shock.json()["meta"]["iv_shift"] == 5.0

    eom = client.get("/api/v1/gex-forward-surface?expiry_scope=eom")
    assert eom.status_code == 200
    assert eom.json()["expiry"] == "2026-08-28"
    assert eom.json()["meta"]["expiry_scope"] == "eom"

    eom_shock = client.get(
        "/api/v1/gex-forward-surface?expiry_scope=eom&iv_shift=10"
    )
    assert eom_shock.status_code == 200
    assert eom_shock.json()["meta"]["iv_shift"] == 10.0
    app.dependency_overrides.clear()
