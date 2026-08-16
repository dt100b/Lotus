"""API contract: every client result carries as-of, expiry, forward, status."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

import project.api.main as api_main
from project.api.main import app, get_repository
from project.api.repository import SnapshotRepository
from pipeline.deribit_iv_chain import IvChainProviderError, IvChainSnapshot
from project.tests.options_surface.support import (
    AS_OF,
    EXPIRY,
    FORWARD,
    INDEX,
    flat_vol_chain,
    listed_future,
)
from project.options_surface.types import NativeFutureQuote


class StubProvider:
    def __init__(self, snapshot: IvChainSnapshot) -> None:
        self.snapshot = snapshot

    def fetch(self, expiry: str | None = None) -> IvChainSnapshot:
        return self.snapshot


class FailingProvider:
    def fetch(self, expiry: str | None = None) -> IvChainSnapshot:
        raise IvChainProviderError("offline fixture failure")


class StubFutures:
    def __init__(self, quotes: tuple[NativeFutureQuote, ...]) -> None:
        self.quotes = quotes

    def fetch(self) -> tuple[NativeFutureQuote, ...]:
        return self.quotes


def _snapshot() -> IvChainSnapshot:
    rows = flat_vol_chain(forward=FORWARD)
    return IvChainSnapshot(
        as_of=AS_OF,
        spot=INDEX,
        rows=rows,
        source="deribit_ticker_ws_incremental",
        verified_live_quotes=True,
        feed={
            "source": "deribit_ticker_ws_incremental",
            "transport": "websocket",
            "channel_interval": "incremental",
            "status": "READY",
            "connected": True,
            "warmup_complete": True,
            "universe_is_current": True,
            "expected_expiry_instruments": len(rows),
            "subscribed_expiry_instruments": len(rows),
            "initialized_expiry_instruments": len(rows),
            "fresh_expiry_instruments": len(rows),
            "completeness_ratio": 1.0,
            "last_message_at": AS_OF,
            "reconnect_count": 0,
            "connection_generation": 1,
        },
    )


def test_options_surface_contract(tmp_path: Path, monkeypatch) -> None:
    repository = SnapshotRepository(
        tmp_path / "unused.json",
        artifacts_dir=tmp_path,
        iv_chain_provider=StubProvider(_snapshot()),
        futures_provider=StubFutures((listed_future(mid=FORWARD),)),
    )
    monkeypatch.setattr(
        SnapshotRepository,
        "_utc_now",
        staticmethod(lambda: AS_OF + timedelta(seconds=5)),
    )
    app.dependency_overrides[get_repository] = lambda: repository
    try:
        response = TestClient(app).get(
            "/api/v1/options-surface", params={"expiry": EXPIRY}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["as_of_utc"].startswith("2030-08-15T12:00:05")
        assert body["expiry_utc"].startswith("2030-08-16T08:00:00")
        assert body["expiry"] == EXPIRY
        assert body["forward"]["source"] == "matching_future"
        assert body["forward"]["source_quality"] == "high"
        assert body["forward"]["forward_usd"] == FORWARD
        assert body["model_status"] in {"accepted", "degraded", "rejected", "research"}
        assert body["validation"]["summary"]
        assert body["fitter_grade"] == "diagnostic"
        text = str(body).lower()
        for token in ("long", "short", "bullish", "bearish", "forecast", "verdict"):
            assert token not in text
        assert TestClient(app).get(
            "/api/v1/options-surface", params={"expiry": "2030-08-17"}
        ).status_code == 404
        assert TestClient(app).get(
            "/api/v1/options-surface", params={"expiry": "ALL"}
        ).status_code == 422
    finally:
        app.dependency_overrides.clear()


def test_options_surface_provider_error(tmp_path: Path) -> None:
    repository = SnapshotRepository(
        tmp_path / "unused.json",
        artifacts_dir=tmp_path,
        iv_chain_provider=FailingProvider(),
    )
    app.dependency_overrides[get_repository] = lambda: repository
    try:
        response = TestClient(app).get(
            "/api/v1/options-surface", params={"expiry": EXPIRY}
        )
        assert response.status_code == 503
    finally:
        app.dependency_overrides.clear()


def test_degraded_and_good_example_payloads(tmp_path: Path, monkeypatch) -> None:
    good = SnapshotRepository(
        tmp_path / "unused.json",
        artifacts_dir=tmp_path / "good",
        iv_chain_provider=StubProvider(_snapshot()),
        futures_provider=StubFutures((listed_future(mid=FORWARD),)),
    )
    thin_rows = flat_vol_chain(forward=FORWARD, strikes=[90_000.0, 100_000.0, 110_000.0])
    thin_snap = _snapshot()
    thin = SnapshotRepository(
        tmp_path / "unused.json",
        artifacts_dir=tmp_path / "thin",
        iv_chain_provider=StubProvider(
            IvChainSnapshot(
                as_of=thin_snap.as_of,
                spot=thin_snap.spot,
                rows=thin_rows,
                source=thin_snap.source,
                verified_live_quotes=True,
                feed=thin_snap.feed,
            )
        ),
        futures_provider=StubFutures((listed_future(mid=FORWARD),)),
    )
    monkeypatch.setattr(
        SnapshotRepository, "_utc_now", staticmethod(lambda: AS_OF + timedelta(seconds=2))
    )
    good_body = good.get_options_surface(expiry=EXPIRY)
    thin_body = thin.get_options_surface(expiry=EXPIRY)
    assert good_body.forward.source == "matching_future"
    assert good_body.model_status in {"accepted", "degraded"}
    assert thin_body.model_status == "rejected"
    assert thin_body.analytics.central_range_50 is None
