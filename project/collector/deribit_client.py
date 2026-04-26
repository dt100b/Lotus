from __future__ import annotations

import time
from typing import Any

import httpx


class DeribitClientError(RuntimeError):
    pass


class DeribitPublicClient:
    def __init__(
        self,
        base_url: str = "https://www.deribit.com/api/v2",
        timeout_s: float = 20.0,
        max_retries: int = 4,
        retry_backoff_s: float = 1.5,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.max_retries = max_retries
        self.retry_backoff_s = retry_backoff_s
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout_s,
            headers={"Accept": "application/json"},
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "DeribitPublicClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def _call(self, method: str, params: dict[str, Any]) -> Any:
        last_error: Exception | None = None

        for attempt in range(self.max_retries + 1):
            try:
                response = self._client.get(f"/{method.lstrip('/')}", params=params)
                response.raise_for_status()
                payload = response.json()

                if payload.get("error"):
                    raise RuntimeError(f"Deribit error for {method}: {payload['error']}")

                return payload["result"]

            except (httpx.HTTPError, RuntimeError, ValueError) as exc:
                last_error = exc
                if attempt >= self.max_retries:
                    break
                time.sleep(self.retry_backoff_s * (2 ** attempt))

        raise DeribitClientError(
            f"Failed Deribit call {method} after {self.max_retries + 1} attempts: {last_error}"
        ) from last_error

    def get_instruments(
        self,
        *,
        currency: str = "BTC",
        kind: str = "option",
        expired: bool = False,
    ) -> list[dict[str, Any]]:
        result = self._call(
            "public/get_instruments",
            {
                "currency": currency,
                "kind": kind,
                "expired": expired,
            },
        )
        if not isinstance(result, list):
            raise RuntimeError("Unexpected get_instruments result shape")
        return result

    def get_last_trades_by_currency_and_time(
        self,
        *,
        currency: str = "BTC",
        kind: str | None = None,
        start_timestamp: int,
        end_timestamp: int,
        count: int,
        sorting: str = "asc",
        continuation: str | None = None,
        include_old: bool = True,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "currency": currency,
            "start_timestamp": start_timestamp,
            "end_timestamp": end_timestamp,
            "count": count,
            "sorting": sorting,
            "include_old": include_old,
        }
        if kind is not None:
            params["kind"] = kind
        if continuation is not None:
            params["continuation"] = continuation

        result = self._call("public/get_last_trades_by_currency_and_time", params)
        if not isinstance(result, dict):
            raise RuntimeError("Unexpected get_last_trades_by_currency_and_time result shape")
        return result


DeribitClient = DeribitPublicClient
