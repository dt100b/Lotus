from __future__ import annotations

import json
from pathlib import Path
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from project.api.config import settings
from project.api.main import app, get_repository
from project.api import repository as repository_module
from project.api.repository import SnapshotRepository


@pytest.fixture(autouse=True)
def disable_hyperliquid_mid(monkeypatch) -> None:
    # Live Price-panel feeds hit Deribit + Hyperliquid; keep unit tests offline.
    monkeypatch.setattr(repository_module, "_fetch_hyperliquid_btc_perp_mid", lambda: None)
    monkeypatch.setattr(repository_module, "_fetch_deribit_btc_usd_index", lambda: None)
    # Live vol_compare hits Deribit + Hyperliquid; keep unit tests offline.
    monkeypatch.setattr(
        repository_module,
        "_fetch_vol_compare",
        lambda **_kwargs: {
            "version": "vol_compare.v1",
            "dvol_series": [],
            "rv_series": [],
            "spread_series": [],
            "meta": {"units": "percent", "window": "365d"},
        },
    )


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


def test_term_curve_artifact_is_independent_of_snapshot_smile_status(tmp_path: Path):
    path=write_snapshot(tmp_path / 'latest_gex_snapshot.json')
    p=json.loads(path.read_text())
    p['flow_regime']={'vol_surface':{'version':'desk_vol_surface.v2','term_structure':[
        {'tenor':'30d','status':'unavailable','validation_reasons':['source_smile_rejected']}]}}
    path.write_text(json.dumps(p))
    curve={'version':'atm_term_curve.v1','as_of_ms':1791400000000,'term_structure':[
        {'tenor':'30d','status':'ok','atm_iv_percent':35}]}
    from vol_surface.snapshot import attach_atm_rv
    (tmp_path / 'atm_term_curve.json').write_text(json.dumps(curve))
    result=SnapshotRepository(path,tmp_path).get_terminal_snapshot()
    assert result['flow_regime']['atm_term_curve']=={**attach_atm_rv(curve, []), 'lookbacks': [], 'history': {'atm': {}}}
    assert result['flow_regime']['vol_surface']['term_structure'][0]['status']=='unavailable'
    # Cached inventory payload must not swallow a later independent curve update.
    curve['term_structure'][0]['atm_iv_percent']=36
    (tmp_path / 'atm_term_curve.json').write_text(json.dumps(curve))
    assert SnapshotRepository(path,tmp_path).get_terminal_snapshot()['flow_regime']['atm_term_curve']=={**attach_atm_rv(curve, []), 'lookbacks': [], 'history': {'atm': {}}}
    from vol_surface.atm_history import DAY, retain_snapshot
    historical = {**curve, 'as_of_ms': curve['as_of_ms'] - DAY,
                  'valid_until_ms': curve['as_of_ms'] - DAY + 300_000,
                  'term_structure': [
                      {'tenor': '7d', 'status': 'ok', 'atm_iv_percent': 32},
                      {'tenor': '30d', 'status': 'ok', 'atm_iv_percent': 34}]}
    retain_snapshot(tmp_path, historical)
    served = SnapshotRepository(path,tmp_path).get_terminal_snapshot()['flow_regime']['atm_term_curve']
    assert served['lookbacks'] == [{'days': 1, 'as_of_ms': historical['as_of_ms'],
                                   'target_offset_ms': 0,
                                   'term_structure': historical['term_structure']}]
    assert served['history']['atm']['30d'] == [{'ts_ms':historical['as_of_ms'],'value':34}]
    assert served['term_structure'] == curve['term_structure']
    dedicated = {**curve, 'as_of_ms': curve['as_of_ms']+60_000}
    (tmp_path / 'atm_term_curve_live.json').write_text(json.dumps(dedicated))
    repository = SnapshotRepository(path,tmp_path)
    expected = {**attach_atm_rv(dedicated, []), 'lookbacks': [{**served['lookbacks'][0], 'target_offset_ms':60_000}],
                'history':served['history']}
    assert repository.get_terminal_snapshot()['flow_regime']['atm_term_curve']==expected
    # An old worker writing its own file cannot replace the independent curve.
    (tmp_path / 'atm_term_curve.json').write_text(json.dumps({**curve, 'as_of_ms': curve['as_of_ms']+120_000}))
    assert repository.get_terminal_snapshot()['flow_regime']['atm_term_curve']==expected
    (tmp_path / 'atm_term_curve_live.json').write_text('{broken')
    assert repository.get_terminal_snapshot()['flow_regime']['atm_term_curve']['as_of_ms']==curve['as_of_ms']+120_000


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
    # Default remains production (blocks/combos excluded).
    assert body["ledger_policy"] == "exclude_otc_prints"
    assert body["include_otc_prints_available"] is False

    app.dependency_overrides.clear()


def test_terminal_snapshot_passes_flow_regime(tmp_path: Path) -> None:
    path = tmp_path / "latest_gex_snapshot.json"
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
        "flow_regime": {
            "version": "flow_regime.v1",
            "horizon": {
                "full_score": -0.2,
                "session_score": 0.3,
                "agreement": "Fighting",
                "session_available": True,
            },
        },
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)
    response = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"})
    assert response.status_code == 200
    body = response.json()
    assert body["flow_regime"]["horizon"]["agreement"] == "Fighting"
    # Live vol_compare is injected at serve time (mocked empty in this suite).
    assert "vol_compare" in body["flow_regime"]
    assert body["flow_regime"]["vol_compare"]["meta"]["units"] == "percent"
    # Core totals still from production rows only.
    assert body["total_net_gex_usd"] == 1.0
    app.dependency_overrides.clear()


def test_terminal_snapshot_joins_parkinson_rv_onto_vol_surface(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        repository_module,
        "_fetch_vol_compare",
        lambda **_kwargs: {
            "version": "vol_compare.v1",
            "dvol_series": [],
            "rv_series": [{"ts_ms": 1, "value": 40.0}],
            "spread_series": [],
            "meta": {"units": "percent", "window": "365d"},
        },
    )
    path = tmp_path / "latest_gex_snapshot.json"
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
        "flow_regime": {
            "version": "flow_regime.v1",
            "vol_surface": {
                "version": "desk_vol_surface.v1",
                "term_structure": [
                    {"tenor": "30d", "status": "ok", "atm_iv_percent": 55.0},
                ],
            },
        },
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)
    response = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"})
    assert response.status_code == 200
    compared = response.json()["flow_regime"]["vol_surface"]["atm_vs_rv"]
    assert compared["atm_iv_percent"] == 55.0
    assert compared["rv_percent"] == 40.0
    assert compared["spread_percent"] == 15.0
    assert compared["rv_estimator"] == "parkinson"
    assert compared["iv_definition"].startswith("30d constant-maturity")
    app.dependency_overrides.clear()


def test_include_otc_prints_profile_and_terminal_bars(tmp_path: Path) -> None:
    """Secondary include-OTC profile is additive; default path unchanged."""
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
            },
        ],
        "rows_include_otc": [
            {
                "expiry": "2026-05-01",
                "strike": 90000,
                "net_gex": 7.5,
                "call_gex": 9.0,
                "put_gex": -1.5,
            },
        ],
        "include_otc_prints_available": True,
    }
    path = tmp_path / "latest_gex_snapshot.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    default_profile = client.get("/api/v1/gex-profile", params={"expiry": "ALL", "view": "net"})
    assert default_profile.status_code == 200
    default_body = default_profile.json()
    assert default_body["points"][0]["net_gex"] == 1.0
    assert default_body["ledger_policy"] == "exclude_otc_prints"
    assert default_body["include_otc_prints_available"] is True

    otc_profile = client.get(
        "/api/v1/gex-profile",
        params={"expiry": "ALL", "view": "net", "include_otc_prints": True},
    )
    assert otc_profile.status_code == 200
    otc_body = otc_profile.json()
    assert otc_body["points"][0]["net_gex"] == 7.5
    assert otc_body["ledger_policy"] == "include_otc_prints"

    terminal = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"})
    assert terminal.status_code == 200
    tbody = terminal.json()
    assert tbody["gamma_bars"][0]["gamma_exposure_usd"] == 1.0
    assert tbody["gamma_bars_include_otc"][0]["gamma_exposure_usd"] == 7.5
    assert tbody["include_otc_prints_available"] is True
    assert tbody["ledger_policy_default"] == "exclude_otc_prints"

    app.dependency_overrides.clear()


def test_include_otc_prints_missing_returns_404(tmp_path: Path) -> None:
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))
    response = client.get(
        "/api/v1/gex-profile",
        params={"include_otc_prints": True},
    )
    assert response.status_code == 404
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
        "supported_ledger_policies": ["exclude_otc_prints", "include_otc_prints"],
    }


def test_legacy_dashboard_is_archived_and_primary_dashboard_is_pending() -> None:
    client = TestClient(app)

    primary = client.get("/dashboard")
    legacy = client.get("/legacy-dashboard")

    assert primary.status_code == 200
    assert "mock-data first" in primary.text or '<div id="root">' in primary.text
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


def test_terminal_snapshot_exposes_backend_authoritative_dashboard_fields(tmp_path: Path) -> None:
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))

    response = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"})

    assert response.status_code == 200
    body = response.json()
    assert body["symbol"] == "BTC"
    assert body["expiry"] == "ALL"
    assert body["expiries"] == ["2026-05-01", "2026-06-26"]
    assert [row["strike"] for row in body["gamma_bars"]] == [80000.0, 90000.0]
    assert body["levels"]["all_expiry"][0]["label"] == "Positive Gamma"
    assert {row["label"] for row in body["levels"]["all_expiry"]} == {
        "Positive Gamma",
        "Negative Gamma",
    }
    # Reference: HVL (session) + Book HVL (ALL secondary) + Max Pain + Expected Move.
    assert {metric["label"] for metric in body["levels"]["reference"]} == {
        "HVL",
        "Book HVL",
        "Max Pain",
        "Expected Move",
    }
    assert body.get("hvl_by_expiry") is not None
    assert "hvl_book" in body
    assert len(body["rankings"]["all_expiry"]) == 2
    assert body["expiry_events"][0]["expiry"] in {"2026-05-01", "2026-06-26"}
    app.dependency_overrides.clear()


def test_structure_levels_peak_extrema(tmp_path: Path) -> None:
    """Positive Gamma = argmax net; Negative Gamma = argmin net."""
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            # Most negative → Negative Gamma
            {"expiry": "2026-05-01", "strike": 64000, "net_gex": -10.0, "call_gex": -1.0, "put_gex": -9.0},
            # Secondary negative (less extreme)
            {"expiry": "2026-05-01", "strike": 62000, "net_gex": -4.0, "call_gex": 0.0, "put_gex": -4.0},
            # Highest positive → Positive Gamma (no spot-side filter)
            {"expiry": "2026-05-01", "strike": 70000, "net_gex": 6.0, "call_gex": 8.0, "put_gex": -2.0},
            # Secondary positive
            {"expiry": "2026-05-01", "strike": 72000, "net_gex": 3.0, "call_gex": 3.5, "put_gex": -0.5},
        ],
    }
    path = tmp_path / "walls.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    body = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"}).json()
    levels = {row["label"]: row for row in body["levels"]["all_expiry"]}
    assert levels["Negative Gamma"]["strike"] == 64000.0
    assert levels["Negative Gamma"]["net_gex"] == -10.0
    assert levels["Positive Gamma"]["strike"] == 70000.0
    assert levels["Positive Gamma"]["net_gex"] == 6.0
    assert "Anchor" not in levels

    reference = {metric["label"]: metric for metric in body["levels"]["reference"]}
    # Cumulative: -4 (62k) → -14 (64k) → -8 (70k) → -5 (72k) — never crosses zero.
    # Policy: no mass-valid cross → Flip unavailable (never flattest |net| fallback).
    assert reference["HVL"]["value"] == "—"
    assert reference["HVL"]["status"] == "no_cross"
    assert body["gamma_flip"] is None
    assert body["gamma_flip_status"] == "no_cross"
    assert body["zero_gamma"] is None
    # One-sided short book → locked empty copy with polarity suffix.
    assert body["gamma_flip_note"] == "No local HVL · GEX one-sided (short)"
    assert reference["HVL"]["note"] == "No local HVL · GEX one-sided (short)"
    app.dependency_overrides.clear()


def test_gamma_flip_cumulative_zero_cross_nearest_spot_with_mass(tmp_path: Path) -> None:
    """Cumulative flip nearest spot; ignore tiny wing mass and pure local zig-zags."""
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            # Far wing tiny noise — cumulative stays near zero then builds positive
            {"expiry": "2026-05-01", "strike": 40000, "net_gex": 0.01, "call_gex": 0.01, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 50000, "net_gex": -0.01, "call_gex": 0.0, "put_gex": -0.01},
            # Meaningful long mass below spot
            {"expiry": "2026-05-01", "strike": 60000, "net_gex": 10.0, "call_gex": 10.0, "put_gex": 0.0},
            # Local raw sign change at 65k (negative bar) is NOT preferred alone
            {"expiry": "2026-05-01", "strike": 65000, "net_gex": -2.0, "call_gex": 0.0, "put_gex": -2.0},
            # Cumulative still positive after 65k (0 + 0.01 - 0.01 + 10 - 2 = 8)
            # Crosses zero between 70k and 75k: 8 + (-12) = -4
            {"expiry": "2026-05-01", "strike": 70000, "net_gex": -12.0, "call_gex": 0.0, "put_gex": -12.0},
            {"expiry": "2026-05-01", "strike": 75000, "net_gex": -3.0, "call_gex": 0.0, "put_gex": -3.0},
        ],
    }
    path = tmp_path / "flip.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    body = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"}).json()
    reference = {metric["label"]: metric for metric in body["levels"]["reference"]}
    flip = float(reference["HVL"]["value"].replace("$", "").replace(",", ""))
    # Cumulative crosses between 65k (cum≈8) and 70k (cum≈-4) → interpolate in that band.
    assert 65000.0 <= flip <= 70000.0
    assert body["gamma_flip_status"] == "ok"
    assert reference["HVL"]["status"] == "ok"
    # gamma_flip / zero_gamma share the same definition; reference is USD-rounded for display.
    assert body["gamma_flip"] is not None
    assert abs(body["gamma_flip"] - flip) < 1.0
    assert abs(body["zero_gamma"] - flip) < 1.0
    assert body.get("gamma_flip_note") is None
    assert "note" not in reference["HVL"]
    app.dependency_overrides.clear()


def test_gamma_flip_ignores_tiny_noise_crossing(tmp_path: Path) -> None:
    """Crossings with mass below GAMMA_FLIP_MIN_MASS_FRACTION (1.5%) of Σ|net GEX| are discarded."""
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            # Tiny wing oscillation (noise) then large structure
            {"expiry": "2026-05-01", "strike": 30000, "net_gex": 0.05, "call_gex": 0.05, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 31000, "net_gex": -0.05, "call_gex": 0.0, "put_gex": -0.05},
            {"expiry": "2026-05-01", "strike": 60000, "net_gex": 20.0, "call_gex": 20.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 70000, "net_gex": -25.0, "call_gex": 0.0, "put_gex": -25.0},
        ],
    }
    path = tmp_path / "flip_noise.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    body = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"}).json()
    flip = float(
        {m["label"]: m for m in body["levels"]["reference"]}["HVL"]["value"]
        .replace("$", "")
        .replace(",", "")
    )
    # Meaningful cumulative cross is between 60k and 70k, not the 30k wing noise.
    assert 60000.0 <= flip <= 70000.0
    assert body["gamma_flip_status"] == "ok"
    app.dependency_overrides.clear()


def test_gamma_flip_no_cross_is_null_not_fallback_strike(tmp_path: Path) -> None:
    """One-sided book: no cumulative zero-cross → null Flip, never nearest flattest bar."""
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            # All positive cumulative — never crosses zero
            {"expiry": "2026-05-01", "strike": 60000, "net_gex": 5.0, "call_gex": 5.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 65000, "net_gex": 8.0, "call_gex": 8.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 70000, "net_gex": 3.0, "call_gex": 3.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 75000, "net_gex": 1.0, "call_gex": 1.0, "put_gex": 0.0},
        ],
    }
    path = tmp_path / "flip_one_sided.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    body = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"}).json()
    assert body["gamma_flip"] is None
    assert body["zero_gamma"] is None
    assert body["gamma_flip_status"] == "no_cross"
    ref = {m["label"]: m for m in body["levels"]["reference"]}["HVL"]
    assert ref["value"] == "—"
    assert ref["status"] == "no_cross"
    # Must not brand any strike (e.g. 75000 flattest) as Flip.
    assert "$" not in ref["value"]
    # All-positive local book → long empty-state copy.
    assert body["gamma_flip_note"] == "No local HVL · GEX one-sided (long)"
    assert ref["note"] == "No local HVL · GEX one-sided (long)"
    app.dependency_overrides.clear()


def test_gamma_flip_mass_discard_only_noise_yields_no_cross(tmp_path: Path) -> None:
    """Only a sub-threshold wing oscillation exists — discarded → no_cross, not fallback."""
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            # Tiny oscillation only: total |net| = 0.2; mass at cross = 0.1 < 1.5%*0.2... wait
            # total_abs = 0.1+0.1+10+10 = 20.2; noise mass ≈ 0.1 << 1.5% of 20.2 (0.303)
            # Actually if only noise: total_abs small and mass may pass. Use large same-sign book.
            {"expiry": "2026-05-01", "strike": 30000, "net_gex": 0.05, "call_gex": 0.05, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 31000, "net_gex": -0.05, "call_gex": 0.0, "put_gex": -0.05},
            # Large same-sign structure — cumulative after noise is ~0 then stays positive
            {"expiry": "2026-05-01", "strike": 60000, "net_gex": 20.0, "call_gex": 20.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 70000, "net_gex": 25.0, "call_gex": 25.0, "put_gex": 0.0},
        ],
    }
    path = tmp_path / "flip_mass_only_noise.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    body = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"}).json()
    # Wing noise discarded; no other cross → Flip unavailable.
    assert body["gamma_flip"] is None
    assert body["gamma_flip_status"] == "no_cross"
    assert body["zero_gamma"] is None
    assert {m["label"]: m for m in body["levels"]["reference"]}["HVL"]["value"] == "—"
    app.dependency_overrides.clear()


def test_gamma_flip_far_only_cross_outside_window_is_no_cross(tmp_path: Path) -> None:
    """Mass-valid cross only far from spot (e.g. ~42k with spot ~65k) → no_cross.

    |42000 − 65000| / 65000 ≈ 0.35 > GAMMA_FLIP_MAX_DISTANCE_FRAC (0.12).
    Must not publish the far zero, and must not fall back to flattest |net_gex|.
    """
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            # Far wing: cumulative crosses zero between 40k and 42k (deep put wing).
            {"expiry": "2026-05-01", "strike": 40000, "net_gex": 15.0, "call_gex": 15.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 42000, "net_gex": -20.0, "call_gex": 0.0, "put_gex": -20.0},
            # Near-spot book is one-sided negative — no additional zero-cross in ±12%.
            {"expiry": "2026-05-01", "strike": 60000, "net_gex": -5.0, "call_gex": 0.0, "put_gex": -5.0},
            {"expiry": "2026-05-01", "strike": 65000, "net_gex": -8.0, "call_gex": 0.0, "put_gex": -8.0},
            {"expiry": "2026-05-01", "strike": 70000, "net_gex": -3.0, "call_gex": 0.0, "put_gex": -3.0},
        ],
    }
    path = tmp_path / "flip_far_only.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    body = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"}).json()
    assert body["gamma_flip"] is None
    assert body["zero_gamma"] is None
    assert body["gamma_flip_status"] == "no_cross"
    ref = {m["label"]: m for m in body["levels"]["reference"]}["HVL"]
    assert ref["value"] == "—"
    assert ref["status"] == "no_cross"
    # Must not brand the far wing (~42k) or any flattest bar as Flip.
    assert "$" not in ref["value"]
    # Near-spot book is one-sided short → locked empty copy with (short).
    assert body["gamma_flip_note"] == "No local HVL · GEX one-sided (short)"
    assert ref["note"] == "No local HVL · GEX one-sided (short)"
    app.dependency_overrides.clear()


def test_gamma_flip_prefers_in_window_over_far_cross(tmp_path: Path) -> None:
    """When both a far and an in-window mass-valid cross exist, publish the near one."""
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            # Far mass-valid cross ~42k (outside ±12% of 65k).
            {"expiry": "2026-05-01", "strike": 40000, "net_gex": 12.0, "call_gex": 12.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 42000, "net_gex": -14.0, "call_gex": 0.0, "put_gex": -14.0},
            # Rebuild then in-window cross between 62k and 68k (within ±12%).
            # cum after 42k ≈ -2; +18 at 62k → +16; -20 at 68k → -4 → cross in [62k,68k].
            {"expiry": "2026-05-01", "strike": 62000, "net_gex": 18.0, "call_gex": 18.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 68000, "net_gex": -20.0, "call_gex": 0.0, "put_gex": -20.0},
        ],
    }
    path = tmp_path / "flip_near_and_far.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    body = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"}).json()
    assert body["gamma_flip_status"] == "ok"
    assert body["gamma_flip"] is not None
    # In-window cross only (far discarded for selection after eligibility filter).
    assert 62000.0 <= body["gamma_flip"] <= 68000.0
    assert abs(body["gamma_flip"] - 42000.0) > 5000.0
    app.dependency_overrides.clear()


def test_gamma_flip_in_window_mass_valid_is_ok(tmp_path: Path) -> None:
    """Cross inside spot ±12% with sufficient mass → ok, Flip returned (not null)."""
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            # Cross between 64000 and 66000: well inside ±12% of 65k (55.25k–74.75k).
            {"expiry": "2026-05-01", "strike": 64000, "net_gex": 10.0, "call_gex": 10.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 66000, "net_gex": -12.0, "call_gex": 0.0, "put_gex": -12.0},
        ],
    }
    path = tmp_path / "flip_in_window.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    body = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"}).json()
    assert body["gamma_flip_status"] == "ok"
    assert body["gamma_flip"] is not None
    assert 64000.0 <= body["gamma_flip"] <= 66000.0
    ref = {m["label"]: m for m in body["levels"]["reference"]}["HVL"]
    assert ref["status"] == "ok"
    assert ref["value"] != "—"
    app.dependency_overrides.clear()


def test_positive_gamma_not_restricted_to_above_spot(tmp_path: Path) -> None:
    """Positive Gamma is global argmax(net_gex), even when that strike is below spot."""
    payload = {
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 65000.0,
        "rows": [
            {"expiry": "2026-05-01", "strike": 60000, "net_gex": 12.0, "call_gex": 12.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 70000, "net_gex": 4.0, "call_gex": 4.0, "put_gex": 0.0},
            {"expiry": "2026-05-01", "strike": 64000, "net_gex": -3.0, "call_gex": 0.0, "put_gex": -3.0},
        ],
    }
    path = tmp_path / "peaks.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    client = build_client(path)

    body = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"}).json()
    levels = {row["label"]: row["strike"] for row in body["levels"]["all_expiry"]}
    assert levels["Positive Gamma"] == 60000.0
    assert levels["Negative Gamma"] == 64000.0
    assert "Anchor" not in levels
    app.dependency_overrides.clear()


def test_terminal_snapshot_includes_hyperliquid_perps_source_when_available(
    tmp_path: Path,
    monkeypatch,
) -> None:
    # Live Deribit btc_usd index (not GEX snapshot spot_price 94750.25).
    monkeypatch.setattr(repository_module, "_fetch_deribit_btc_usd_index", lambda: 94_800.0)
    monkeypatch.setattr(repository_module, "_fetch_hyperliquid_btc_perp_mid", lambda: 94_900.5)
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))

    response = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"})

    assert response.status_code == 200
    body = response.json()
    # GEX path still uses snapshot spot; Price/chart use live index.
    assert body["spot"] == 94_750.25
    assert body["live_index"] == 94_800.0
    sources = body["market_sources"]
    assert sources == [
        {
            "name": "Index (Deribit)",
            "value": 94_800.0,
            "note": "settlement index",
            "color": "#d35fe9",
        },
        {
            "name": "Perps (Hyperliquid)",
            "value": 94_900.5,
            "note": "basis +100.50",
            "color": "#27a7dc",
        },
    ]
    # Ranking DIST % vs live index (not snapshot spot).
    top = body["rankings"]["all_expiry"][0]
    expected_dist = ((top["strike"] - 94_800.0) / 94_800.0) * 100
    assert top["distance_from_spot_percent"] == pytest.approx(expected_dist)
    app.dependency_overrides.clear()


def test_terminal_snapshot_basis_omitted_when_deribit_index_unavailable(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Do not invent basis from snapshot spot when live Deribit index is down."""
    monkeypatch.setattr(repository_module, "_fetch_deribit_btc_usd_index", lambda: None)
    monkeypatch.setattr(repository_module, "_fetch_hyperliquid_btc_perp_mid", lambda: 94_900.5)
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))

    response = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"})

    assert response.status_code == 200
    body = response.json()
    assert body["spot"] == 94_750.25
    assert body["live_index"] is None
    assert body["market_sources"] == [
        {
            "name": "Perps (Hyperliquid)",
            "value": 94_900.5,
            "note": "live mid",
            "color": "#27a7dc",
        },
    ]
    # Fallback: DIST % uses snapshot spot when live index is down.
    top = body["rankings"]["all_expiry"][0]
    expected_dist = ((top["strike"] - 94_750.25) / 94_750.25) * 100
    assert top["distance_from_spot_percent"] == pytest.approx(expected_dist)
    app.dependency_overrides.clear()


def test_terminal_snapshot_single_expiry_filters_gamma_bars(tmp_path: Path) -> None:
    client = build_client(write_snapshot(tmp_path / "latest_gex_snapshot.json"))

    response = client.get("/api/v1/terminal-snapshot", params={"expiry": "2026-05-01"})

    assert response.status_code == 200
    body = response.json()
    assert body["expiry"] == "2026-05-01"
    assert [row["strike"] for row in body["gamma_bars"]] == [80000.0, 90000.0]
    assert body["gamma_bars"][1]["call_gamma_exposure_usd"] == 3.0
    app.dependency_overrides.clear()


def test_terminal_snapshot_includes_signed_delta_exposure_by_strike(tmp_path: Path) -> None:
    path = tmp_path / "latest_gex_snapshot.json"
    path.write_text(json.dumps({
        "as_of": "2026-04-25T21:45:00Z",
        "underlying": "BTC",
        "spot_price": 94_750.25,
        "rows": [{
            "expiry": "2026-05-01",
            "strike": 90_000,
            "net_gex": 0.0,
            "call_gex": 0.0,
            "put_gex": 0.0,
            "call_position_units": 10.0,
            "put_position_units": 10.0,
            "call_mark_iv": 50.0,
            "put_mark_iv": 50.0,
        }],
    }), encoding="utf-8")
    client = build_client(path)

    response = client.get("/api/v1/terminal-snapshot", params={"expiry": "ALL"})

    assert response.status_code == 200
    bar = response.json()["gamma_bars"][0]
    assert bar["call_delta_exposure_usd"] > 0
    assert bar["put_delta_exposure_usd"] < 0
    assert bar["net_delta_exposure_usd"] == pytest.approx(
        bar["call_delta_exposure_usd"] + bar["put_delta_exposure_usd"]
    )
    assert bar["delta_exposure_usd"] == bar["net_delta_exposure_usd"]
    app.dependency_overrides.clear()
