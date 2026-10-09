"""Repeatable collection runner. No cloud dependency."""

from __future__ import annotations

from datetime import UTC, datetime
import logging
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from dataclasses import replace

from project.options_surface.config import (
    SurfaceServingConfig,
    default_serving_config,
    max_curated_expiries,
    quote_policy_for_source,
)
from project.options_surface.corpus.capture import (
    assemble_capture_record,
    detect_code_version,
    failed_capture_record,
)
from project.options_surface.corpus.expiries import listed_expiry_dates, select_curated_expiries
from project.options_surface.corpus.lock import InstanceLock
from project.options_surface.corpus.store import CorpusSnapshotStore
from project.options_surface.market_data.ticker_adapter import quotes_from_scanner_rows
from project.options_surface.service import build_options_surface
from project.options_surface.timeutil import as_utc
from project.options_surface.types import NativeFutureQuote, NativeOptionQuote

LOGGER = logging.getLogger("lotus.options_surface.collector")


class CaptureProviders:
    """Injectable market-data ports. Tests never need the network."""

    def __init__(
        self,
        *,
        fetch_chain: Callable[..., Any],
        fetch_futures: Callable[..., Sequence[NativeFutureQuote]],
        fetch_instruments: Callable[..., Sequence[Mapping[str, Any]]] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.fetch_chain = fetch_chain
        self.fetch_futures = fetch_futures
        self.fetch_instruments = fetch_instruments
        self.clock = clock or (lambda: datetime.now(UTC))


def run_collection(
    *,
    store: CorpusSnapshotStore,
    providers: CaptureProviders,
    underlying: str = "BTC",
    expiries: Sequence[str] | None = None,
    curated: bool = False,
    dry_run: bool = False,
    serving_config: SurfaceServingConfig | None = None,
    max_expiries: int | None = None,
    pause_seconds: float = 1.0,
    max_retries: int = 2,
    retry_backoff_seconds: float = 1.5,
    lock: InstanceLock | None = None,
) -> dict[str, Any]:
    config = serving_config or default_serving_config()
    as_of = as_utc(providers.clock())
    selected = resolve_collection_expiries(
        providers,
        underlying=underlying,
        expiries=expiries,
        curated=curated,
        as_of_utc=as_of,
        max_expiries=max_expiries,
    )
    summary: dict[str, Any] = {
        "as_of_utc": as_of.isoformat(),
        "underlying": underlying,
        "dry_run": dry_run,
        "serving_mode": config.mode.value,
        "config_hash": config.config_hash,
        "requested": [item["expiry"] for item in selected],
        "captured": [],
        "failed": [],
        "skipped": [],
    }
    if dry_run:
        summary["skipped"] = [item["expiry"] for item in selected]
        LOGGER.info("dry-run expiries=%s", summary["requested"])
        return summary
    if lock is not None and not lock.acquire():
        raise RuntimeError("Collector is already running.")
    try:
        for index, item in enumerate(selected):
            expiry = item["expiry"]
            try:
                record = _capture_one(
                    providers,
                    expiry=expiry,
                    underlying=underlying,
                    serving_config=config,
                    max_retries=max_retries,
                    retry_backoff_seconds=retry_backoff_seconds,
                )
                store.persist(record)
                if record.get("capture_ok"):
                    summary["captured"].append(expiry)
                    LOGGER.info("captured %s snapshot_id=%s", expiry, record.get("snapshot_id"))
                else:
                    summary["failed"].append({"expiry": expiry, "error": record.get("capture_error")})
                    LOGGER.warning("capture recorded failure for %s: %s", expiry, record.get("capture_error"))
            except Exception as exc:  # isolation: continue the batch
                LOGGER.exception("expiry %s failed: %s", expiry, exc)
                failure = failed_capture_record(
                    expiry=expiry,
                    underlying=underlying,
                    as_of_utc=as_of,
                    serving_config=config,
                    error={"type": type(exc).__name__, "message": str(exc)},
                )
                try:
                    store.persist(failure)
                except Exception:
                    LOGGER.exception("could not persist failure record for %s", expiry)
                summary["failed"].append({"expiry": expiry, "error": str(exc)})
            if index + 1 < len(selected) and pause_seconds > 0:
                time.sleep(pause_seconds)
    finally:
        if lock is not None:
            lock.release()
    summary["ok"] = not summary["failed"]
    return summary


def resolve_collection_expiries(
    providers: CaptureProviders,
    *,
    underlying: str,
    expiries: Sequence[str] | None,
    curated: bool,
    as_of_utc: datetime,
    max_expiries: int | None,
) -> list[dict[str, Any]]:
    if expiries:
        return [{"role": "explicit", "expiry": str(item), "kind": "explicit"} for item in expiries]
    if not curated:
        raise ValueError("Provide --expiry, a list of expiries, or --curated-expiries.")
    listed = _listed_from_providers(providers, underlying=underlying)
    return select_curated_expiries(
        listed,
        as_of_utc=as_of_utc,
        max_count=max_expiries or max_curated_expiries(),
    )


def _listed_from_providers(providers: CaptureProviders, *, underlying: str) -> list[Any]:
    if providers.fetch_instruments is not None:
        try:
            instruments = providers.fetch_instruments(underlying)
            dates = listed_expiry_dates(instruments, underlying=underlying)
            if dates:
                return dates
        except Exception:
            LOGGER.warning("instrument listing failed; falling back to chain rows", exc_info=True)
    chain = providers.fetch_chain(None)
    rows = getattr(chain, "rows", None) or []
    return listed_expiry_dates(rows, underlying=underlying)


def _capture_one(
    providers: CaptureProviders,
    *,
    expiry: str,
    underlying: str,
    serving_config: SurfaceServingConfig,
    max_retries: int,
    retry_backoff_seconds: float,
) -> dict[str, Any]:
    last_error: Exception | None = None
    attempts = max(max_retries, 0) + 1
    for attempt in range(attempts):
        try:
            return _capture_attempt(
                providers,
                expiry=expiry,
                underlying=underlying,
                serving_config=serving_config,
            )
        except Exception as exc:
            last_error = exc
            LOGGER.warning("attempt %s/%s for %s failed: %s", attempt + 1, attempts, expiry, exc)
            if attempt + 1 < attempts:
                time.sleep(retry_backoff_seconds * (2 ** attempt))
    assert last_error is not None
    return failed_capture_record(
        expiry=expiry,
        underlying=underlying,
        as_of_utc=as_utc(providers.clock()),
        serving_config=serving_config,
        error={"type": type(last_error).__name__, "message": str(last_error)},
    )


def _capture_attempt(
    providers: CaptureProviders,
    *,
    expiry: str,
    underlying: str,
    serving_config: SurfaceServingConfig,
) -> dict[str, Any]:
    chain = providers.fetch_chain(expiry)
    as_of = as_utc(getattr(chain, "as_of", None) or providers.clock())
    index = float(getattr(chain, "spot", 0.0) or 0.0)
    rows = list(getattr(chain, "rows", ()) or ())
    quotes: tuple[NativeOptionQuote, ...] = quotes_from_scanner_rows(
        rows,
        as_of_utc=as_of,
        underlying=underlying,
        default_index_usd=index,
    )
    try:
        futures = tuple(providers.fetch_futures())
        future_error = None
    except Exception as exc:
        futures = ()
        future_error = {"type": type(exc).__name__, "message": str(exc)}
    instruments: Sequence[Mapping[str, Any]] = ()
    if providers.fetch_instruments is not None:
        try:
            instruments = list(providers.fetch_instruments(underlying))
        except Exception:
            instruments = ()
    feed = dict(getattr(chain, "feed", None) or {})
    if future_error is not None:
        feed["future_fetch_error"] = future_error
    source_name = str(getattr(chain, "source", "") or feed.get("source") or "")
    policy = quote_policy_for_source(source_name)
    config = replace(serving_config, **policy)
    result = build_options_surface(
        quotes,
        expiry=expiry,
        as_of_utc=as_of,
        index_usd=index,
        futures=futures,
        underlying=underlying,
        feed=feed,
        serving_config=config,
        require_iv_market=config.require_iv_market,
        require_open_state=config.require_open_state,
        require_sizes=config.require_sizes,
        max_quote_age_seconds=config.max_quote_age_seconds,
    )
    return assemble_capture_record(
        result,
        quotes=quotes,
        futures=futures,
        expiry=expiry,
        serving_config=config,
        option_instruments=instruments,
        source={
            "chain_source": getattr(chain, "source", None),
            "verified_live_quotes": getattr(chain, "verified_live_quotes", None),
        },
        code_version=detect_code_version(),
    )


def configure_logging(log_path: Path | None = None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_path is not None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_path, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)sZ %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        handlers=handlers,
        force=True,
    )
    logging.Formatter.converter = time.gmtime
