from __future__ import annotations

from collector.instruments import sync_btc_option_instruments


class StubClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def get_instruments(self, currency: str = "BTC", kind: str = "option", expired: bool = False):
        self.calls.append({"currency": currency, "kind": kind, "expired": expired})
        return [
            {
                "instrument_name": "BTC-30JUN26-100000-C",
                "expiration_timestamp": 1_719_737_600_000,
                "strike": 100000.0,
                "option_type": "call",
            },
            {
                "instrument_name": "BTC-30JUN26-100000-P",
                "expiration_timestamp": 1_719_737_600_000,
                "strike": 100000.0,
                "option_type": "put",
            },
        ]


def test_sync_btc_option_instruments() -> None:
    client = StubClient()
    result = sync_btc_option_instruments(client, include_expired=False)
    assert result.count == 2
    assert len(result.instruments) == 2
    assert client.calls == [{"currency": "BTC", "kind": "option", "expired": False}]
