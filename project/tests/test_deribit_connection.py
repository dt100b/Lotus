from __future__ import annotations

import json

import httpx

from collector.config import Settings
from collector.deribit_client import (
    DeribitClient,
    DeribitClientError,
    build_clients,
    build_history_client,
)


def test_deribit_client_can_fetch_instruments_with_mock_transport() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/public/get_instruments")
        payload = {
            "jsonrpc": "2.0",
            "result": [
                {
                    "instrument_name": "BTC-30JUN26-100000-C",
                    "instrument_id": 123,
                    "expiration_timestamp": 1_719_737_600_000,
                    "strike": 100000.0,
                    "option_type": "call",
                    "tick_size": 0.0005,
                    "contract_size": 1.0,
                    "is_active": True,
                    "state": "open",
                    "base_currency": "BTC",
                    "quote_currency": "BTC",
                    "settlement_currency": "BTC",
                }
            ],
            "usIn": 1,
            "usOut": 2,
            "usDiff": 1,
            "testnet": False,
        }
        return httpx.Response(200, content=json.dumps(payload))

    transport = httpx.MockTransport(handler)
    with DeribitClient(transport=transport) as client:
        rows = client.get_instruments()

    assert rows
    assert rows[0]["instrument_name"].startswith("BTC-")


def test_deribit_client_retries_then_raises_after_max_retries() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timeout")

    transport = httpx.MockTransport(handler)
    with DeribitClient(transport=transport, max_retries=1, retry_backoff_s=0.0) as client:
        try:
            client.get_instruments()
        except DeribitClientError as exc:
            assert "after 2 attempts" in str(exc)
        else:
            raise AssertionError("Expected DeribitClientError")


def test_build_clients_uses_live_and_history_base_urls() -> None:
    settings = Settings().with_overrides(
        deribit_base_url="https://www.deribit.com/api/v2",
        deribit_history_base_url="https://history.deribit.com/api/v2",
        use_history_for_backfill=True,
    )
    live, history = build_clients(settings)
    try:
        assert live.base_url == "https://www.deribit.com/api/v2"
        assert history is not None
        assert history.base_url == "https://history.deribit.com/api/v2"
    finally:
        live.close()
        if history is not None:
            history.close()


def test_build_clients_skips_history_when_disabled() -> None:
    settings = Settings().with_overrides(use_history_for_backfill=False)
    live, history = build_clients(settings)
    try:
        assert history is None
        assert live.base_url.endswith("/api/v2")
    finally:
        live.close()


def test_history_client_requests_history_host_path() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        payload = {
            "jsonrpc": "2.0",
            "result": {"trades": [], "has_more": False},
            "usIn": 1,
            "usOut": 2,
            "usDiff": 1,
            "testnet": False,
        }
        return httpx.Response(200, content=json.dumps(payload))

    settings = Settings().with_overrides(
        deribit_history_base_url="https://history.deribit.com/api/v2",
    )
    transport = httpx.MockTransport(handler)
    with build_history_client(settings, transport=transport) as client:
        client.get_last_trades_by_currency_and_time(
            start_timestamp=1,
            end_timestamp=2,
            count=10,
        )

    assert seen
    assert "history.deribit.com" in seen[0]
    assert "get_last_trades_by_currency_and_time" in seen[0]
