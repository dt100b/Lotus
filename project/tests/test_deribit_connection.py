from __future__ import annotations

import json

import httpx

from collector.deribit_client import DeribitClient, DeribitClientError


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
