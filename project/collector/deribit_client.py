from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from collector.config import Settings


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
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self.retry_backoff_s = retry_backoff_s
        self._client = httpx.Client(
            base_url=self.base_url,
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

    def get_last_trades_by_currency(
        self,
        *,
        currency: str = "BTC",
        kind: str | None = None,
        start_timestamp: int | None = None,
        end_timestamp: int | None = None,
        start_id: str | None = None,
        count: int = 1000,
        sorting: str = "asc",
        historical: bool | None = None,
        include_old: bool | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "currency": currency,
            "count": count,
            "sorting": sorting,
        }
        if kind is not None:
            params["kind"] = kind
        if start_timestamp is not None:
            params["start_timestamp"] = start_timestamp
        if end_timestamp is not None:
            params["end_timestamp"] = end_timestamp
        if start_id is not None:
            params["start_id"] = start_id
        if historical is not None:
            params["historical"] = historical
        if include_old is not None:
            params["include_old"] = include_old

        result = self._call("public/get_last_trades_by_currency", params)
        if not isinstance(result, dict):
            raise RuntimeError("Unexpected get_last_trades_by_currency result shape")
        return result


def build_live_client(
    settings: "Settings",
    *,
    transport: httpx.BaseTransport | None = None,
) -> DeribitPublicClient:
    """Client for the main Deribit host (instruments, live/hot trades)."""
    return DeribitPublicClient(
        base_url=settings.deribit_base_url,
        timeout_s=settings.request_timeout_s,
        max_retries=settings.max_retries,
        retry_backoff_s=settings.retry_backoff_s,
        transport=transport,
    )


def build_history_client(
    settings: "Settings",
    *,
    transport: httpx.BaseTransport | None = None,
) -> DeribitPublicClient:
    """Client for history.deribit.com (deep public trade history)."""
    return DeribitPublicClient(
        base_url=settings.deribit_history_base_url,
        timeout_s=settings.request_timeout_s,
        max_retries=settings.max_retries,
        retry_backoff_s=settings.retry_backoff_s,
        transport=transport,
    )


def build_clients(
    settings: "Settings",
    *,
    live_transport: httpx.BaseTransport | None = None,
    history_transport: httpx.BaseTransport | None = None,
) -> tuple[DeribitPublicClient, DeribitPublicClient | None]:
    """
    Return (live_client, history_client).

    history_client is None when DERIBIT_USE_HISTORY_FOR_BACKFILL is false.
    """
    live = build_live_client(settings, transport=live_transport)
    history = (
        build_history_client(settings, transport=history_transport)
        if settings.use_history_for_backfill
        else None
    )
    return live, history


DeribitClient = DeribitPublicClient
