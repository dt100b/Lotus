from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Mapping
import json
import math

import httpx

from .schemas import (
    ExpiryListResponse,
    GexForwardSurfaceMeta,
    GexForwardSurfaceResponse,
    GexHeatmapCell,
    GexHeatmapSample,
    GexHeatmapSurfaceMeta,
    GexHeatmapSurfaceResponse,
    GexPoint,
    GexProfileResponse,
    HealthResponse,
    IvSignalEligibility,
    IvSignalEligibilityRequirements,
    IvSignalFreshness,
    IvSignalFeedHealth,
    IvSignalOutlookState,
    IvSignalParameters,
    IvSignalScanResponse,
    OptionsSurfaceResponse,
)
from pipeline.forward_gamma_surface import (
    FORWARD_SURFACE_VERSION,
    ForwardExpiryScope,
    ForwardMetric,
    MIN_REF_GAMMA,
    MIN_TAU_YEARS,
    MS_PER_YEAR,
    bs_delta,
    bs_gamma,
    build_forward_gamma_surface,
    empty_forward_surface,
    normalize_mark_iv,
    select_forward_expiry,
    settle_ms_from_expiry,
)
from pipeline.flow_regime import (
    HISTORY_RETENTION_MS,
    HISTORY_VERSION,
    load_history_doc,
)
from pipeline.deribit_iv_chain import (
    DeribitTickerIvChainProvider,
    IvChainProvider,
    IvChainProviderError,
)
from pipeline.iv_signal_scanner import (
    MIN_SIGNAL_IV_COVERAGE_RATIO,
    confirm_published_verdict,
    scan_expiry_rows,
    tenor_coverage_spec,
)
from project.options_surface.api_adapter import (
    to_legacy_scan_response,
    to_options_surface_response,
)
from project.options_surface.market_data.futures import DeribitFuturesProvider, FutureBookError
from project.options_surface.market_data.snapshots import OptionsSurfaceSnapshotStore
from project.options_surface.service import build_options_surface
from pipeline.vol_compare import (
    DEFAULT_WINDOW as VOL_COMPARE_DEFAULT_WINDOW,
    RV30_LOOKBACK_RETURNS,
    WINDOW_MS as VOL_COMPARE_WINDOW_MS,
    assemble_vol_compare,
    empty_vol_compare_payload,
)

VIEW_TO_FIELD = {
    "net": "net_gex",
    "call": "call_gex",
    "put": "put_gex",
}

HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info"
HYPERLIQUID_MID_CACHE_SECONDS = 10
_hyperliquid_btc_mid_cache: tuple[datetime, float] | None = None

DERIBIT_API_BASE = "https://www.deribit.com/api/v2"
DERIBIT_DVOL_CACHE_SECONDS = 30
# BTC DVOL index on Deribit (volatility index, percent units).
DERIBIT_DVOL_INDEX = "btcdvol_usdc"
_deribit_dvol_cache: tuple[datetime, float] | None = None

IV_SIGNAL_STANDARD_REFRESH_SECONDS = 600
IV_SIGNAL_ZERO_DTE_REFRESH_SECONDS = 120
IV_SIGNAL_ZERO_DTE_MIN_HOURS = 4.0
IV_SIGNAL_ZERO_DTE_MAX_QUOTE_AGE_SECONDS = 10.0
IV_SIGNAL_ZERO_DTE_NEAR_SPOT_WINDOW_PERCENT = 3.0
IV_SIGNAL_ZERO_DTE_MAX_NEAREST_GAP_PERCENT = 1.5
IV_SIGNAL_ZERO_DTE_MIN_CANONICAL_STRIKES_PER_SIDE = 3
IV_SIGNAL_ZERO_DTE_MIN_ALIGNED_SIGNALS = 2

# Live BTC settlement index for Price panel Index/basis (not GEX snapshot spot).
DERIBIT_BTC_USD_INDEX = "btc_usd"
DERIBIT_BTC_USD_INDEX_CACHE_SECONDS = 10
_deribit_btc_usd_index_cache: tuple[datetime, float] | None = None

# Realized-vol trend (short vs longer window) for Regime confirmation.
RV_TREND_CACHE_SECONDS = 60
_rv_trend_cache: tuple[datetime, dict[str, Any]] | None = None

# DVOL vs RV time series for Regime vol-compare mini chart (not every UI poll).
VOL_COMPARE_CACHE_SECONDS = 300
# Cache key includes window so a 7d payload cannot be served after a 30d default flip.
_vol_compare_cache: tuple[datetime, str, dict[str, Any]] | None = None
# Mass filter for HVL (cumulative net-GEX zero-cross).
# HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12%
# (mass filter 1.5%). Not classic OI gamma flip.
# Crossing kept only when |prev_cum| + |next_cum| ≥ this fraction × Σ|net_gex|
# measured on the *eligibility window* (falls back to full book if empty).
# Window-local mass avoids far-wing inventory burying near-spot crosses on
# taker-flow books. Crosses that fail are discarded permanently — never
# resurrected via flattest-bar fallback.
GAMMA_FLIP_MIN_MASS_FRACTION = 0.015  # 1.5%
# Near-spot eligibility for HVL. Tightened 15% → 12% so published
# levels stay local enough to trade against while covering typical BTC
# strike spacing. Far wing zeros on a one-sided near-spot book → no_cross.
# Separate from the Regime profile corridor (display-only, spot ± 8%).
GAMMA_FLIP_MAX_DISTANCE_FRAC = 0.12  # ±12% of spot
# Clean polarity for empty-state copy when HVL is unavailable.
# |net| / Σ|net| of strikes inside the eligibility window (fallback: full book)
# must meet this fraction before suffixing (short)/(long); otherwise neutral.
GAMMA_FLIP_ONE_SIDED_MIN_FRAC = 0.05
# Locked empty-state copy (Levels rail + optional API note). HVL naming.
GAMMA_FLIP_EMPTY_NEUTRAL = "No local HVL · GEX one-sided"
GAMMA_FLIP_EMPTY_SHORT = "No local HVL · GEX one-sided (short)"
GAMMA_FLIP_EMPTY_LONG = "No local HVL · GEX one-sided (long)"
# Book HVL tooltip (multi-expiry sum — secondary only).
HVL_BOOK_NOTE = (
    "Book HVL: multi-expiry cumulative zero-cross on the ALL surface "
    "(summed inventory). Prefer session HVL on the active/front expiry."
)


class SnapshotRepository:
    def __init__(
        self,
        snapshot_path: Path,
        artifacts_dir: Path | None = None,
        *,
        iv_chain_provider: IvChainProvider | None = None,
        futures_provider: DeribitFuturesProvider | None = None,
        options_surface_store: OptionsSurfaceSnapshotStore | None = None,
    ):
        self.snapshot_path = Path(snapshot_path)
        # Heatmap surface history lives under the materialize artifacts dir.
        if artifacts_dir is not None:
            self.artifacts_dir = Path(artifacts_dir)
        else:
            # Prefer sibling of snapshot when layout is artifacts/latest_gex_snapshot.json;
            # fall back to configured default via property when unset.
            self.artifacts_dir = Path(snapshot_path).resolve().parent
        self._cache_mtime_ns: int | None = None
        self._cache_payload: dict | None = None
        self.iv_chain_provider = (
            iv_chain_provider
            if iv_chain_provider is not None
            else DeribitTickerIvChainProvider()
        )
        self._iv_signal_state: dict[str, dict[str, Any]] = {}
        self.futures_provider = futures_provider
        self.options_surface_store = options_surface_store or OptionsSurfaceSnapshotStore(
            Path(self.artifacts_dir) / "options_surface"
        )

    def start(self) -> bool:
        """Start optional live services without performing network I/O inline."""

        start = getattr(self.iv_chain_provider, "start", None)
        return bool(start()) if callable(start) else False

    def close(self) -> bool:
        """Stop optional live services during application shutdown."""

        close = getattr(self.iv_chain_provider, "close", None)
        return bool(close()) if callable(close) else True

    def _load_payload(self) -> dict:
        if not self.snapshot_path.exists():
            raise FileNotFoundError(f"Snapshot file not found: {self.snapshot_path}")

        stat = self.snapshot_path.stat()
        if self._cache_payload is not None and self._cache_mtime_ns == stat.st_mtime_ns:
            return self._cache_payload

        with self.snapshot_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)

        self._validate_payload(payload)
        self._cache_mtime_ns = stat.st_mtime_ns
        self._cache_payload = payload
        return payload

    @staticmethod
    def _utc_now() -> datetime:
        return datetime.now(UTC)

    @staticmethod
    def _validate_payload(payload: dict) -> None:
        required_top_level = {"as_of", "underlying", "spot_price", "rows"}
        missing = required_top_level.difference(payload)
        if missing:
            raise ValueError(f"Snapshot missing keys: {sorted(missing)}")

        if payload["underlying"] != "BTC":
            raise ValueError("Phase 5 dashboard only supports BTC snapshots.")

        try:
            SnapshotRepository._parse_as_of(str(payload["as_of"]))
        except ValueError as exc:
            raise ValueError("Snapshot as_of must be ISO-8601.") from exc

        try:
            float(payload["spot_price"])
        except (TypeError, ValueError) as exc:
            raise ValueError("Snapshot spot_price must be numeric.") from exc

        rows = payload["rows"]
        if not isinstance(rows, list):
            raise ValueError("Snapshot rows must be a list.")

        SnapshotRepository._validate_gex_rows(rows, label="rows")

        # Optional secondary profile (include block/combo OTC prints). Same shape
        # as rows when present; absence is valid for older snapshots.
        rows_include_otc = payload.get("rows_include_otc")
        if rows_include_otc is not None:
            if not isinstance(rows_include_otc, list):
                raise ValueError("Snapshot rows_include_otc must be a list when present.")
            SnapshotRepository._validate_gex_rows(rows_include_otc, label="rows_include_otc")

    @staticmethod
    def _validate_gex_rows(rows: list, *, label: str) -> None:
        required_row_keys = {"expiry", "strike", "net_gex", "call_gex", "put_gex"}
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"Snapshot {label}[{index}] must be an object.")

            missing_row = required_row_keys.difference(row)
            if missing_row:
                raise ValueError(f"Snapshot {label} row missing keys: {sorted(missing_row)}")

            try:
                float(row["strike"])
                net_gex = float(row["net_gex"])
                call_gex = float(row["call_gex"])
                put_gex = float(row["put_gex"])
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    f"Snapshot {label}[{index}] has non-numeric GEX fields."
                ) from exc

            if not math.isclose(net_gex, call_gex + put_gex, rel_tol=1e-9, abs_tol=1e-9):
                raise ValueError(
                    f"Snapshot {label}[{index}] violates net_gex = call_gex + put_gex."
                )
    @staticmethod
    def _parse_as_of(value: str) -> datetime:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)

    @staticmethod
    def _iv_feed_health(
        raw_feed: Mapping[str, Any] | None,
        *,
        source: str,
        chain_as_of: datetime,
        now: datetime,
        expiry_row_count: int,
    ) -> IvSignalFeedHealth:
        raw = dict(raw_feed or {})
        last_message = raw.get("last_message_at")
        if isinstance(last_message, datetime):
            last_message_at = (
                last_message
                if last_message.tzinfo
                else last_message.replace(tzinfo=UTC)
            ).astimezone(UTC)
        elif last_message:
            try:
                last_message_at = SnapshotRepository._parse_as_of(str(last_message))
            except ValueError:
                last_message_at = None
        else:
            last_message_at = chain_as_of
        last_message_age = (
            max((now - last_message_at).total_seconds(), 0.0)
            if last_message_at is not None
            else None
        )
        expected = max(int(raw.get("expected_expiry_instruments") or expiry_row_count), 0)
        initialized = max(int(raw.get("initialized_expiry_instruments") or 0), 0)
        completeness = (
            min(max(initialized / expected, 0.0), 1.0)
            if expected
            else 0.0
        )
        transport = str(raw.get("transport") or "snapshot")
        if transport not in {"websocket", "snapshot"}:
            transport = "snapshot"
        interval = raw.get("channel_interval")
        if interval not in {"incremental", "100ms", "agg2"}:
            interval = None
        status = str(raw.get("status") or "DISCONNECTED").upper()
        if status not in {"READY", "WARMING", "DEGRADED", "DISCONNECTED"}:
            status = "DISCONNECTED"
        return IvSignalFeedHealth(
            source=str(raw.get("source") or source),
            transport=transport,
            channel_interval=interval,
            status=status,
            connected=bool(raw.get("connected")),
            warmup_complete=bool(raw.get("warmup_complete")),
            universe_is_current=bool(raw.get("universe_is_current")),
            expected_expiry_instruments=expected,
            subscribed_expiry_instruments=max(
                int(raw.get("subscribed_expiry_instruments") or 0), 0
            ),
            initialized_expiry_instruments=initialized,
            fresh_expiry_instruments=max(
                int(raw.get("fresh_expiry_instruments") or 0), 0
            ),
            completeness_ratio=float(
                raw.get("completeness_ratio")
                if raw.get("completeness_ratio") is not None
                else completeness
            ),
            last_message_at=last_message_at,
            last_message_age_seconds=last_message_age,
            reconnect_count=max(int(raw.get("reconnect_count") or 0), 0),
            connection_generation=max(
                int(raw.get("connection_generation") or 0), 0
            ),
            last_error=(str(raw.get("last_error"))[:240] if raw.get("last_error") else None),
        )

    def health(self, freshness_threshold_seconds: int, contract_version: str) -> HealthResponse:
        payload = self._load_payload()
        as_of = self._parse_as_of(str(payload["as_of"]))
        age_seconds = max((self._utc_now() - as_of).total_seconds(), 0.0)
        return HealthResponse(
            status="ok",
            underlying="BTC",
            as_of=as_of,
            spot_price=float(payload["spot_price"]),
            row_count=len(payload["rows"]),
            snapshot_age_seconds=age_seconds,
            freshness_threshold_seconds=freshness_threshold_seconds,
            is_fresh=age_seconds <= freshness_threshold_seconds,
            contract_version=contract_version,
            snapshot_provenance=str(self.snapshot_path),
        )

    def list_expiries(self) -> ExpiryListResponse:
        payload = self._load_payload()
        expiries = sorted({str(row["expiry"]) for row in payload["rows"]})
        return ExpiryListResponse(
            as_of=self._parse_as_of(str(payload["as_of"])),
            underlying="BTC",
            spot_price=float(payload["spot_price"]),
            expiries=expiries,
        )

    def get_profile(
        self,
        expiry: str = "ALL",
        view: str = "net",
        *,
        include_otc_prints: bool = False,
    ) -> GexProfileResponse:
        payload = self._load_payload()
        expiries = sorted({str(row["expiry"]) for row in payload["rows"]})

        selected_expiry = expiry or "ALL"
        if selected_expiry != "ALL" and selected_expiry not in expiries:
            raise KeyError(f"Unknown expiry: {selected_expiry}")

        if view not in VIEW_TO_FIELD:
            raise ValueError(f"Unknown view: {view}")

        otc_rows = payload.get("rows_include_otc")
        otc_available = isinstance(otc_rows, list) and len(otc_rows) > 0
        if include_otc_prints:
            if not otc_available:
                raise KeyError(
                    "include_otc_prints requested but secondary profile is not available "
                    "on this snapshot (run a full materialize to seed it)."
                )
            source_rows = otc_rows
            ledger_policy = "include_otc_prints"
        else:
            source_rows = payload["rows"]
            ledger_policy = "exclude_otc_prints"

        filtered_rows = source_rows
        if selected_expiry != "ALL":
            filtered_rows = [row for row in filtered_rows if str(row["expiry"]) == selected_expiry]

        by_strike: dict[float, dict[str, float]] = defaultdict(
            lambda: {"net_gex": 0.0, "call_gex": 0.0, "put_gex": 0.0}
        )

        for row in filtered_rows:
            strike = float(row["strike"])
            by_strike[strike]["net_gex"] += float(row["net_gex"])
            by_strike[strike]["call_gex"] += float(row["call_gex"])
            by_strike[strike]["put_gex"] += float(row["put_gex"])

        value_field = VIEW_TO_FIELD[view]
        points = [
            GexPoint(
                strike=strike,
                net_gex=values["net_gex"],
                call_gex=values["call_gex"],
                put_gex=values["put_gex"],
                value=values[value_field],
            )
            for strike, values in sorted(by_strike.items())
        ]

        return GexProfileResponse(
            as_of=self._parse_as_of(str(payload["as_of"])),
            underlying="BTC",
            spot_price=float(payload["spot_price"]),
            selected_expiry=selected_expiry,
            view=view,
            expiries=expiries,
            points=points,
            ledger_policy=ledger_policy,  # type: ignore[arg-type]
            include_otc_prints_available=otc_available,
        )

    def get_iv_signal_scan(
        self,
        *,
        expiry: str,
        tail_threshold: float = 0.02,
        band_width: float = 0.03,
        signal_delta: float = 0.03,
        freshness_threshold_seconds: int = 180,
        feed_silence_threshold_seconds: float = 5.0,
    ) -> IvSignalScanResponse:
        """Deprecated adapter. Directional fields are retired (always NO_TRADE)."""
        selected_expiry = str(expiry or "").strip()
        if selected_expiry.upper() == "ALL":
            raise ValueError(
                'IV signal scan requires one ISO expiry; "ALL" is not supported.'
            )
        result, feed, freshness = self._compute_options_surface(
            selected_expiry,
            freshness_threshold_seconds=freshness_threshold_seconds,
            feed_silence_threshold_seconds=feed_silence_threshold_seconds,
        )
        return to_legacy_scan_response(
            result,
            expiry=selected_expiry,
            feed=feed,
            freshness=freshness,
            tail_threshold=tail_threshold,
            band_width=band_width,
            signal_delta=signal_delta,
        )

    def get_options_surface(
        self,
        *,
        expiry: str,
        freshness_threshold_seconds: int = 180,
        feed_silence_threshold_seconds: float = 5.0,
        persist: bool = True,
    ) -> OptionsSurfaceResponse:
        """Build the market-implied options surface for one expiry."""
        selected_expiry = str(expiry or "").strip()
        if selected_expiry.upper() == "ALL":
            raise ValueError(
                'Options surface requires one ISO expiry; "ALL" is not supported.'
            )
        result, feed, freshness = self._compute_options_surface(
            selected_expiry,
            freshness_threshold_seconds=freshness_threshold_seconds,
            feed_silence_threshold_seconds=feed_silence_threshold_seconds,
            persist=persist,
        )
        return to_options_surface_response(
            result,
            expiry=selected_expiry,
            feed=feed,
            freshness=freshness,
        )

    def _compute_options_surface(
        self,
        selected_expiry: str,
        *,
        freshness_threshold_seconds: int,
        feed_silence_threshold_seconds: float,
        persist: bool = True,
    ):
        chain, feed, feed_ready, as_of, now = self._iv_chain_context(
            selected_expiry,
            freshness_threshold_seconds=freshness_threshold_seconds,
            feed_silence_threshold_seconds=feed_silence_threshold_seconds,
        )
        del feed_ready
        futures = ()
        if self.futures_provider is not None:
            try:
                futures = self.futures_provider.fetch()
            except Exception:
                futures = ()
        result = build_options_surface(
            chain.rows,
            expiry=selected_expiry,
            as_of_utc=as_of,
            index_usd=float(chain.spot),
            futures=futures,
            underlying="BTC",
            feed={
                "source": chain.source,
                "transport": feed.transport,
                "status": feed.status,
            },
            require_iv_market=str(chain.source).startswith("deribit_ticker_ws"),
            require_open_state=str(chain.source).startswith("deribit_ticker_ws"),
            require_sizes=str(chain.source).startswith("deribit_ticker_ws"),
        )
        if persist:
            try:
                self.options_surface_store.persist(result)
            except OSError:
                pass
        snapshot_age_seconds = max(
            float(feed.last_message_age_seconds or 0.0),
            max((now - (
                chain.as_of if chain.as_of.tzinfo else chain.as_of.replace(tzinfo=UTC)
            ).astimezone(UTC)).total_seconds(), 0.0),
        )
        freshness = IvSignalFreshness(
            snapshot_age_seconds=snapshot_age_seconds,
            threshold_seconds=freshness_threshold_seconds,
            is_fresh=snapshot_age_seconds <= freshness_threshold_seconds,
        )
        return result, feed, freshness

    def _iv_chain_context(
        self,
        selected_expiry: str,
        *,
        freshness_threshold_seconds: int,
        feed_silence_threshold_seconds: float,
    ):
        try:
            chain = self.iv_chain_provider.fetch(expiry=selected_expiry)
        except TypeError as exc:
            if "unexpected keyword argument" not in str(exc):
                raise
            chain = self.iv_chain_provider.fetch()
        expiries = sorted({str(row.get("expiry")) for row in chain.rows})
        if selected_expiry not in expiries:
            raise KeyError(f"Unknown expiry: {selected_expiry}")
        if freshness_threshold_seconds < 1:
            raise ValueError("freshness_threshold_seconds must be at least 1.")
        if (
            not math.isfinite(float(feed_silence_threshold_seconds))
            or feed_silence_threshold_seconds <= 0
        ):
            raise ValueError(
                "feed_silence_threshold_seconds must be positive and finite."
            )
        chain_as_of = (
            chain.as_of if chain.as_of.tzinfo else chain.as_of.replace(tzinfo=UTC)
        ).astimezone(UTC)
        now = self._utc_now()
        feed = self._iv_feed_health(
            chain.feed,
            source=chain.source,
            chain_as_of=chain_as_of,
            now=now,
            expiry_row_count=sum(
                1 for row in chain.rows if str(row.get("expiry")) == selected_expiry
            ),
        )
        feed_silent = (
            feed.last_message_age_seconds is None
            or feed.last_message_age_seconds > feed_silence_threshold_seconds
        )
        if feed_silent and feed.status == "READY":
            feed.status = "DEGRADED"
        feed_ready = (
            feed.transport == "websocket"
            and feed.status == "READY"
            and feed.connected
            and feed.warmup_complete
            and feed.universe_is_current
            and feed.expected_expiry_instruments > 0
            and feed.subscribed_expiry_instruments
            == feed.expected_expiry_instruments
            and feed.initialized_expiry_instruments
            == feed.expected_expiry_instruments
            and feed.fresh_expiry_instruments
            == feed.expected_expiry_instruments
            and math.isclose(feed.completeness_ratio, 1.0, abs_tol=1e-9)
            and not feed_silent
        )
        as_of = now if feed.transport == "websocket" else chain_as_of
        return chain, feed, feed_ready, as_of, now

    def get_forward_surface(
        self,
        *,
        n_times: int = 64,
        n_prices: int = 128,
        price_window_pct: float = 8.0,
        metric: ForwardMetric = "gamma",
        iv_shift: float = 0.0,
        expiry_scope: ForwardExpiryScope = "0dte",
    ) -> GexForwardSurfaceResponse:
        """Single-expiry forward dealer-Greek surface (not historical heatmap).

        Holds the front-expiry chain fixed and revalues net GEX on a dense
        future (time × price) grid by advancing τ toward Deribit settle.
        """
        payload = self._load_payload()
        rows = list(payload.get("rows") or [])
        try:
            spot = float(payload.get("spot_price") or 0.0)
        except (TypeError, ValueError):
            spot = 0.0
        as_of = payload.get("as_of")
        as_of_ms = _as_of_to_ms(as_of)

        expiries = sorted({str(r.get("expiry")) for r in rows if r.get("expiry")})
        # One clean chain cliff for the selected tenor — never an ALL aggregate.
        front = select_forward_expiry(
            expiries, now_ms=as_of_ms, scope=expiry_scope
        ) or ""

        surface = build_forward_gamma_surface(
            rows,
            spot=spot,
            as_of_ms=as_of_ms,
            front_expiry=front or None,
            n_times=n_times,
            n_prices=n_prices,
            price_window_pct=price_window_pct,
            metric=metric,
            iv_shift=iv_shift,
            expiry_scope=expiry_scope,
        )
        if not surface.times_ms:
            empty = empty_forward_surface(
                spot=spot if math.isfinite(spot) else 0.0,
                as_of_ms=as_of_ms,
                expiry=front,
                note=str(surface.meta.get("note") or "empty forward surface"),
                metric=metric,
                iv_shift=iv_shift,
                expiry_scope=expiry_scope,
            )
            return _forward_surface_response(empty)

        return _forward_surface_response(surface)

    def get_heatmap_surface(
        self,
        *,
        from_ms: int | None = None,
        to_ms: int | None = None,
        max_samples: int | None = None,
    ) -> GexHeatmapSurfaceResponse:
        """Serve net-GEX time × strike samples from gex_window_history.json.

        Empty history returns a valid empty payload (not 503) so the FE can
        degrade cleanly while the ring warms.
        """
        doc = load_history_doc(self.artifacts_dir)
        raw_samples = list(doc.get("samples") or [])
        samples_out: list[GexHeatmapSample] = []

        lo = int(from_ms) if from_ms is not None else None
        hi = int(to_ms) if to_ms is not None else None

        for raw in raw_samples:
            if not isinstance(raw, dict):
                continue
            try:
                ts_ms = int(raw.get("ts_ms", 0))
            except (TypeError, ValueError):
                continue
            if ts_ms <= 0:
                continue
            if lo is not None and ts_ms < lo:
                continue
            if hi is not None and ts_ms > hi:
                continue

            by_strike = raw.get("by_strike") or {}
            cells = _heatmap_cells_from_by_strike(by_strike)
            if not cells:
                continue

            try:
                spot = float(raw.get("spot", 0.0) or 0.0)
            except (TypeError, ValueError):
                spot = 0.0
            try:
                net_gex = float(raw.get("net_gex", 0.0) or 0.0)
            except (TypeError, ValueError):
                net_gex = 0.0

            samples_out.append(
                GexHeatmapSample(
                    ts_ms=ts_ms,
                    spot=spot if math.isfinite(spot) else 0.0,
                    net_gex=net_gex if math.isfinite(net_gex) else 0.0,
                    cells=cells,
                )
            )

        samples_out.sort(key=lambda s: s.ts_ms)

        # Evenly downsample if the client requests a cap.
        if max_samples is not None and max_samples > 0 and len(samples_out) > max_samples:
            samples_out = _downsample_evenly(samples_out, max_samples)

        as_of_ms = samples_out[-1].ts_ms if samples_out else 0
        methodology = str(
            doc.get("methodology")
            or "signed cumulative flow inventory; production ledger (blocks/combos excluded)"
        )
        version = str(doc.get("version") or HISTORY_VERSION)

        return GexHeatmapSurfaceResponse(
            as_of_ms=as_of_ms,
            version=version,
            sample_count=len(samples_out),
            samples=samples_out,
            meta=GexHeatmapSurfaceMeta(
                retention_ms=HISTORY_RETENTION_MS,
                methodology=methodology,
                note=(
                    "Net GEX by strike over time from gex_window_history; "
                    "call/put splits are not stored in the history ring."
                ),
                version=version,
            ),
        )

    def get_terminal_snapshot(self, expiry: str = "ALL") -> dict[str, Any]:
        payload = self._load_payload()
        expiries = sorted({str(row["expiry"]) for row in payload["rows"]})
        selected_expiry = expiry or "ALL"
        if selected_expiry != "ALL" and selected_expiry not in expiries:
            # Soft-normalize common Deribit / ISO forms against listed keys.
            selected_expiry = _normalize_expiry_key(selected_expiry, expiries)
        if selected_expiry != "ALL" and selected_expiry not in expiries:
            raise KeyError(f"Unknown expiry: {selected_expiry}")

        spot = float(payload["spot_price"])
        as_of_ms = int(self._parse_as_of(str(payload["as_of"])).timestamp() * 1000)
        exposure_rows = _attach_delta_exposures(
            payload["rows"],
            spot=spot,
            as_of_ms=as_of_ms,
        )
        # Live Deribit btc_usd for Price Index, chart spot lines, and DIST %.
        # GEX bars / Flip / EM methodology stay on materialize ``spot``.
        live_index = _fetch_deribit_btc_usd_index()
        display_spot = float(live_index) if live_index is not None else spot
        all_rows = _aggregate_rows(exposure_rows)
        selected_rows = all_rows if selected_expiry == "ALL" else _aggregate_rows(
            [row for row in exposure_rows if str(row["expiry"]) == selected_expiry]
        )
        front_expiry = expiries[0] if expiries else selected_expiry
        front_rows = _aggregate_rows([row for row in exposure_rows if str(row["expiry"]) == front_expiry])
        # Level peaks from GEX surface; distance labels vs display_spot (live index).
        all_levels = _build_all_expiry_levels(all_rows, display_spot)
        zero_dte_levels = _build_zero_dte_levels(front_rows, display_spot)
        weekly_levels = _build_kind_levels(payload["rows"], display_spot, kind="weekly")
        monthly_levels = _build_kind_levels(payload["rows"], display_spot, kind="monthly")
        quarterly_levels = _build_kind_levels(payload["rows"], display_spot, kind="quarterly")
        # HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12%
        # (mass filter 1.5%). Not classic OI gamma flip.
        # Per-expiry map + Book (ALL) secondary. Levels default HVL uses the
        # active/front session expiry — never the ALL-book aggregate as primary.
        # Eligibility window uses materialize spot (GEX methodology), not live index.
        hvl_by_expiry = _compute_hvl_by_expiry(payload["rows"], spot=spot, expiries=expiries)
        book_hvl_level, book_hvl_status = _estimate_gamma_flip(all_rows, spot=spot)
        book_hvl_note = _gamma_flip_empty_note(
            all_rows, spot=spot, status=book_hvl_status
        )
        hvl_book = {
            "level": book_hvl_level,
            "status": book_hvl_status,
            "note": book_hvl_note,
        }

        # Primary HVL surface: selected expiry when filtered; else front session.
        if selected_expiry != "ALL":
            hvl_primary_expiry = selected_expiry
            primary_rows = selected_rows
        else:
            hvl_primary_expiry = front_expiry
            primary_rows = front_rows if front_rows else selected_rows

        primary_entry = hvl_by_expiry.get(hvl_primary_expiry)
        if primary_entry is not None:
            gamma_flip = primary_entry.get("level")
            gamma_flip_status = str(primary_entry.get("status") or "no_cross")
            gamma_flip_note = primary_entry.get("note")
        else:
            gamma_flip, gamma_flip_status = _estimate_gamma_flip(primary_rows, spot=spot)
            gamma_flip_note = _gamma_flip_empty_note(
                primary_rows, spot=spot, status=gamma_flip_status
            )

        reference_levels = _build_reference_levels(
            all_rows,
            payload["rows"],
            spot,
            front_expiry,
            gamma_flip=gamma_flip,
            gamma_flip_status=gamma_flip_status,
            gamma_flip_note=gamma_flip_note,
            hvl_scope_label=hvl_primary_expiry if hvl_primary_expiry != "ALL" else front_expiry,
            hvl_book_level=book_hvl_level,
            hvl_book_status=book_hvl_status,
            hvl_book_note=book_hvl_note,
            distance_spot=display_spot,
        )

        otc_source = payload.get("rows_include_otc")
        otc_available = isinstance(otc_source, list) and len(otc_source) > 0
        gamma_bars_include_otc = None
        if otc_available:
            otc_exposure_rows = _attach_delta_exposures(
                otc_source,
                spot=spot,
                as_of_ms=as_of_ms,
            )
            otc_selected = (
                _aggregate_rows(otc_exposure_rows)
                if selected_expiry == "ALL"
                else _aggregate_rows(
                    [row for row in otc_exposure_rows if str(row["expiry"]) == selected_expiry]
                )
            )
            gamma_bars_include_otc = [_to_gamma_bar(row) for row in otc_selected]

        result: dict[str, Any] = {
            "as_of_utc": str(payload["as_of"]),
            "symbol": "BTC",
            "expiry": selected_expiry,
            "expiries": expiries,
            # Materialize median option underlying — GEX math / Flip window only.
            "spot": spot,
            # Live Deribit btc_usd when reachable; null → FE falls back to ``spot``.
            "live_index": live_index,
            # Production default: blocks + combos excluded.
            "gamma_bars": [_to_gamma_bar(row) for row in selected_rows],
            "total_net_gex_usd": sum(row["net_gex"] for row in selected_rows),
            "total_call_gex_usd": sum(row["call_gex"] for row in selected_rows),
            "total_put_gex_usd": sum(row["put_gex"] for row in selected_rows),
            "max_positive_gamma_strike": _strike_for_extreme(selected_rows, highest=True),
            "max_negative_gamma_strike": _strike_for_extreme(selected_rows, highest=False),
            # HVL: real cumulative zero-cross only. null + no_cross when absent.
            # Primary = active/front session expiry (not ALL-book aggregate).
            # gamma_flip / zero_gamma remain temporary API aliases of hvl.
            "hvl": gamma_flip,
            "hvl_status": gamma_flip_status,
            "hvl_note": gamma_flip_note,
            "hvl_expiry": hvl_primary_expiry if hvl_primary_expiry != "ALL" else front_expiry,
            "hvl_by_expiry": hvl_by_expiry,
            "hvl_book": hvl_book,
            "gamma_flip": gamma_flip,
            "gamma_flip_status": gamma_flip_status,
            # Locked empty-state copy when status is no_cross; null when ok.
            "gamma_flip_note": gamma_flip_note,
            "zero_gamma": gamma_flip,
            "market_sources": _build_market_sources(deribit_index=live_index),
            "book_stats": _build_book_stats(all_rows),
            "levels": {
                "all_expiry": all_levels,
                "zero_dte": zero_dte_levels,
                "weekly": weekly_levels,
                "monthly": monthly_levels,
                "quarterly": quarterly_levels,
                "reference": reference_levels,
            },
            "rankings": {
                "all_expiry": _build_rankings(all_rows, display_spot, payload["rows"]),
                "selected_expiry": _build_rankings(selected_rows, display_spot, payload["rows"]),
                "zero_dte": _build_rankings(front_rows, display_spot, payload["rows"]),
            },
            # Near-spot OPEX metrics use display_spot; notional still snapshot spot.
            "expiry_events": _build_expiry_events(
                payload["rows"],
                spot,
                distance_spot=display_spot,
            ),
            "ledger_policy_default": "exclude_otc_prints",
            "include_otc_prints_available": otc_available,
        }
        if gamma_bars_include_otc is not None:
            result["gamma_bars_include_otc"] = gamma_bars_include_otc
        # Additive secondary Regime analytics (Velocity / Horizon / Active Strikes).
        # Always scoped to the full production book; never mutates main Regime fields.
        # Live vol_compare (DVOL + RV overlay) is attached at serve time so Deribit /
        # Hyperliquid history is not re-fetched by the materializer on every cycle.
        vol_compare = _fetch_vol_compare()
        flow_regime = payload.get("flow_regime")
        if isinstance(flow_regime, dict):
            # Shallow copy so cached snapshot payload is never mutated in place.
            flow_regime = dict(flow_regime)
            flow_regime["vol_compare"] = vol_compare
            result["flow_regime"] = flow_regime
        else:
            # Materialize may omit flow_regime; still expose series as sibling.
            result["vol_compare"] = vol_compare
        return result


def _build_market_sources(
    *,
    deribit_index: float | None = None,
    hyperliquid_mid: float | None = None,
) -> list[dict[str, Any]]:
    """Price panel feeds: live Deribit btc_usd index + live HL mid.

    Basis = HL_BTC_mid − Deribit_btc_usd_index (both live/cached serve-time legs).
    Snapshot GEX ``spot_price`` is intentionally not used here.

    Optional pre-fetched legs avoid a second HTTP call when the terminal
    snapshot builder already resolved live_index for charts/DIST %.
    """
    sources: list[dict[str, Any]] = []

    if deribit_index is None:
        deribit_index = _fetch_deribit_btc_usd_index()
    if hyperliquid_mid is None:
        hyperliquid_mid = _fetch_hyperliquid_btc_perp_mid()

    if deribit_index is not None:
        sources.append(
            {
                "name": "Index (Deribit)",
                "value": deribit_index,
                "note": "settlement index",
                "color": "#d35fe9",
            }
        )

    if hyperliquid_mid is not None:
        if deribit_index is not None:
            basis = hyperliquid_mid - deribit_index
            note = f"basis {basis:+,.2f}"
        else:
            # Index unavailable — do not invent basis from snapshot spot.
            note = "live mid"
        sources.append(
            {
                "name": "Perps (Hyperliquid)",
                "value": hyperliquid_mid,
                "note": note,
                "color": "#27a7dc",
            }
        )

    return sources


def _fetch_deribit_btc_usd_index() -> float | None:
    """Live Deribit BTC-USD settlement index for Price panel Index/basis.

    Cached briefly at serve time (same pattern as HL mid). On fetch failure,
    returns last good cache when present; never falls back to GEX snapshot spot.
    """
    global _deribit_btc_usd_index_cache

    now = datetime.now(UTC)
    if (
        _deribit_btc_usd_index_cache is not None
        and (now - _deribit_btc_usd_index_cache[0]).total_seconds()
        <= DERIBIT_BTC_USD_INDEX_CACHE_SECONDS
    ):
        return _deribit_btc_usd_index_cache[1]

    try:
        response = httpx.get(
            f"{DERIBIT_API_BASE}/public/get_index_price",
            params={"index_name": DERIBIT_BTC_USD_INDEX},
            timeout=2.5,
        )
        response.raise_for_status()
        payload = response.json()
        index_price = float(payload["result"]["index_price"])
    except (httpx.HTTPError, KeyError, TypeError, ValueError):
        return (
            _deribit_btc_usd_index_cache[1]
            if _deribit_btc_usd_index_cache is not None
            else None
        )

    if not math.isfinite(index_price) or index_price <= 0:
        return (
            _deribit_btc_usd_index_cache[1]
            if _deribit_btc_usd_index_cache is not None
            else None
        )

    _deribit_btc_usd_index_cache = (now, index_price)
    return index_price


def _fetch_hyperliquid_btc_perp_mid() -> float | None:
    global _hyperliquid_btc_mid_cache

    now = datetime.now(UTC)
    if (
        _hyperliquid_btc_mid_cache is not None
        and (now - _hyperliquid_btc_mid_cache[0]).total_seconds() <= HYPERLIQUID_MID_CACHE_SECONDS
    ):
        return _hyperliquid_btc_mid_cache[1]

    try:
        response = httpx.post(
            HYPERLIQUID_INFO_URL,
            json={"type": "allMids"},
            headers={"Content-Type": "application/json"},
            timeout=2.5,
        )
        response.raise_for_status()
        payload = response.json()
        btc_mid = float(payload["BTC"])
    except (httpx.HTTPError, KeyError, TypeError, ValueError):
        return (
            _hyperliquid_btc_mid_cache[1]
            if _hyperliquid_btc_mid_cache is not None
            else None
        )

    if not math.isfinite(btc_mid) or btc_mid <= 0:
        return (
            _hyperliquid_btc_mid_cache[1]
            if _hyperliquid_btc_mid_cache is not None
            else None
        )

    _hyperliquid_btc_mid_cache = (now, btc_mid)
    return btc_mid


def _build_book_stats(all_rows: list[dict[str, float]]) -> dict[str, Any]:
    """Full-surface stats for the Regime desk (always ALL, independent of chart expiry)."""
    net_gex_usd = sum(row["net_gex"] for row in all_rows)
    call_oi = sum(row.get("call_open_interest", 0.0) for row in all_rows)
    put_oi = sum(row.get("put_open_interest", 0.0) for row in all_rows)
    put_call_oi_ratio = (put_oi / call_oi) if call_oi > 0 else None
    dvol = _fetch_deribit_dvol()
    rv_trend = _fetch_rv_trend()
    return {
        "net_gex_usd": net_gex_usd,
        "call_open_interest": call_oi,
        "put_open_interest": put_oi,
        "put_call_oi_ratio": put_call_oi_ratio,
        "dvol": dvol,
        "rv_ratio": rv_trend.get("rv_ratio"),
        "rv_trend": rv_trend.get("rv_trend"),
        "rv_short": rv_trend.get("rv_short"),
        "rv_long": rv_trend.get("rv_long"),
    }


def _fetch_deribit_dvol() -> float | None:
    """BTC DVOL (Deribit vol index). Cached briefly; never blocks the snapshot on failure."""
    global _deribit_dvol_cache

    now = datetime.now(UTC)
    if (
        _deribit_dvol_cache is not None
        and (now - _deribit_dvol_cache[0]).total_seconds() <= DERIBIT_DVOL_CACHE_SECONDS
    ):
        return _deribit_dvol_cache[1]

    try:
        response = httpx.get(
            f"{DERIBIT_API_BASE}/public/get_index_price",
            params={"index_name": DERIBIT_DVOL_INDEX},
            timeout=2.5,
        )
        response.raise_for_status()
        payload = response.json()
        dvol = float(payload["result"]["index_price"])
    except (httpx.HTTPError, KeyError, TypeError, ValueError):
        return _deribit_dvol_cache[1] if _deribit_dvol_cache is not None else None

    if not math.isfinite(dvol) or dvol <= 0:
        return None

    _deribit_dvol_cache = (now, dvol)
    return dvol


def _fetch_rv_trend() -> dict[str, Any]:
    """Short vs longer realized-vol ratio from Hyperliquid 1h BTC closes.

    - short window: last ~24 hours (24 × 1h returns)
    - long window: last ~7 days (168 × 1h returns)
    - ratio = short_rv / long_rv
    - Accelerating ≥ 1.30, Expanding ≥ 1.10, Stable ≥ 0.90,
      Contracting ≥ 0.70, else Collapsing

    Light Regime confirmation only — never overrides Dealer Γ polarity.
    Cached; failure returns null fields without blocking the snapshot.
    """
    global _rv_trend_cache

    empty: dict[str, Any] = {
        "rv_ratio": None,
        "rv_trend": None,
        "rv_short": None,
        "rv_long": None,
    }

    now = datetime.now(UTC)
    if (
        _rv_trend_cache is not None
        and (now - _rv_trend_cache[0]).total_seconds() <= RV_TREND_CACHE_SECONDS
    ):
        return _rv_trend_cache[1]

    try:
        end_ms = int(now.timestamp() * 1000)
        start_ms = end_ms - 8 * 24 * 60 * 60 * 1000  # ~8d buffer for 7d window
        response = httpx.post(
            HYPERLIQUID_INFO_URL,
            json={
                "type": "candleSnapshot",
                "req": {
                    "coin": "BTC",
                    "interval": "1h",
                    "startTime": start_ms,
                    "endTime": end_ms,
                },
            },
            headers={"Content-Type": "application/json"},
            timeout=3.0,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list) or len(payload) < 30:
            return _rv_trend_cache[1] if _rv_trend_cache is not None else empty

        closes: list[float] = []
        for row in payload:
            close = _hyperliquid_candle_close(row)
            if close is not None and close > 0:
                closes.append(close)

        result = _compute_rv_trend_from_closes(closes)
    except (httpx.HTTPError, KeyError, TypeError, ValueError, IndexError):
        return _rv_trend_cache[1] if _rv_trend_cache is not None else empty

    _rv_trend_cache = (now, result)
    return result


def _hyperliquid_candle_close(row: Any) -> float | None:
    """Parse close from Hyperliquid candle row (array or object form)."""
    try:
        if isinstance(row, (list, tuple)):
            # [t, o, h, l, c, v, n?] — close at index 4
            if len(row) < 5:
                return None
            return float(row[4])
        if isinstance(row, dict):
            return float(row["c"])
    except (TypeError, ValueError, KeyError):
        return None
    return None


def _compute_rv_trend_from_closes(closes: list[float]) -> dict[str, Any]:
    """Annualized short/long realized vol from sequential closes; ratio + label."""
    empty: dict[str, Any] = {
        "rv_ratio": None,
        "rv_trend": None,
        "rv_short": None,
        "rv_long": None,
    }
    if len(closes) < 30:
        return empty

    log_returns: list[float] = []
    for previous, current in zip(closes, closes[1:]):
        if previous <= 0 or current <= 0:
            continue
        log_returns.append(math.log(current / previous))

    if len(log_returns) < 28:
        return empty

    # 1h bars → annualize with √(24 * 365)
    periods_per_year = 24.0 * 365.0
    short_n = min(24, len(log_returns))
    long_n = min(168, len(log_returns))
    short_rv = _sample_stdev(log_returns[-short_n:]) * math.sqrt(periods_per_year)
    long_rv = _sample_stdev(log_returns[-long_n:]) * math.sqrt(periods_per_year)

    if not (math.isfinite(short_rv) and math.isfinite(long_rv)) or long_rv <= 1e-12:
        return empty

    ratio = short_rv / long_rv
    return {
        "rv_ratio": round(ratio, 4),
        "rv_trend": _rv_trend_label(ratio),
        "rv_short": round(short_rv * 100, 2),  # percent units
        "rv_long": round(long_rv * 100, 2),
    }


def _rv_trend_label(ratio: float) -> str:
    """EXPANDING ↔ CONTRACTING pair with outer extremes (desk label grammar).

    Thresholds (short_rv / long_rv):
      ≥ 1.30 Accelerating · ≥ 1.10 Expanding · ≥ 0.90 Stable ·
      ≥ 0.70 Contracting · else Collapsing
    """
    if ratio >= 1.30:
        return "Accelerating"
    if ratio >= 1.10:
        return "Expanding"
    if ratio >= 0.90:
        return "Stable"
    if ratio >= 0.70:
        return "Contracting"
    return "Collapsing"


def _sample_stdev(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    variance = sum((value - mean) ** 2 for value in values) / (n - 1)
    return math.sqrt(max(variance, 0.0))


def _fetch_vol_compare(*, window: str = VOL_COMPARE_DEFAULT_WINDOW) -> dict[str, Any]:
    """DVOL history + aligned RV30 (primary) + spread for Regime vol-compare chart.

    Primary pair is **DVOL (30d) vs RV30** (720 × 1h returns). RV7 is included
    as an optional secondary overlay only — it does not drive the spread or
    IV rich/cheap chip.

    Cached (~90s). On Deribit/HL failure, returns last good payload when available,
    otherwise an empty series shape — never raises into the terminal snapshot path.
    """
    global _vol_compare_cache

    win = window if window in VOL_COMPARE_WINDOW_MS else VOL_COMPARE_DEFAULT_WINDOW
    now = datetime.now(UTC)
    if (
        _vol_compare_cache is not None
        and _vol_compare_cache[1] == win
        and (now - _vol_compare_cache[0]).total_seconds() <= VOL_COMPARE_CACHE_SECONDS
    ):
        return _vol_compare_cache[2]

    as_of_ms = int(now.timestamp() * 1000)
    window_ms = VOL_COMPARE_WINDOW_MS[win]
    # Extra day buffer for sparse candles / clock skew.
    dvol_start_ms = as_of_ms - window_ms - 86_400_000
    # RV30 needs ~720 1h returns before the chart window starts (+ buffer).
    rv30_start_ms = as_of_ms - window_ms - (RV30_LOOKBACK_RETURNS + 48) * 3_600_000
    try:
        dvol_candles = _fetch_deribit_dvol_history(
            start_ms=dvol_start_ms,
            end_ms=as_of_ms,
            resolution="3600",
        )
        deribit_btc_closes = _fetch_deribit_btc_perpetual_1h_closes(
            start_ms=rv30_start_ms,
            end_ms=as_of_ms,
        )
        if not dvol_candles:
            raise ValueError("empty DVOL history")
        if not deribit_btc_closes:
            raise ValueError("empty Deribit BTC-PERPETUAL history")

        window_start_ms = as_of_ms - window_ms
        payload = assemble_vol_compare(
            dvol_raw_candles=dvol_candles,
            # Use the full-depth Deribit history for every rolling RV tenor.
            # Hyperliquid's ~5,000-candle retention capped RV1/RV7 near 208d.
            hl_candles=deribit_btc_closes,
            rv30_candles=deribit_btc_closes,
            as_of_ms=as_of_ms,
            window=win,
            window_start_ms=window_start_ms,
            include_rv7=True,
        )
        if not payload.get("dvol_series"):
            raise ValueError("DVOL series empty after parse")
    except Exception as exc:  # noqa: BLE001 — never break Regime serve path
        if _vol_compare_cache is not None and _vol_compare_cache[1] == win:
            return _vol_compare_cache[2]
        return empty_vol_compare_payload(
            as_of_ms=as_of_ms,
            window=win,
            error=str(exc)[:240],
        )

    _vol_compare_cache = (now, win, payload)
    return payload


def _fetch_deribit_dvol_history(
    *,
    start_ms: int,
    end_ms: int,
    resolution: str = "3600",
) -> list[Any]:
    """Deribit BTC volatility index candles (OHLC; close is DVOL level).

    Deribit caps each response at ~1000 bars (~41d of 1h). Chunk the range
    so long windows, including the full-year default, fill completely.
    """
    start = int(start_ms)
    end = int(end_ms)
    if end <= start:
        return []

    # ~30d of hourly bars stays under the 1000-candle cap with margin.
    chunk_ms = 30 * 86_400_000
    merged: list[Any] = []
    seen_ts: set[int] = set()
    cursor = start
    while cursor < end:
        chunk_end = min(cursor + chunk_ms, end)
        rows = _fetch_deribit_dvol_history_chunk(
            start_ms=cursor,
            end_ms=chunk_end,
            resolution=resolution,
        )
        for row in rows:
            try:
                if isinstance(row, (list, tuple)) and len(row) >= 1:
                    ts = int(row[0])
                elif isinstance(row, dict):
                    ts = int(row.get("ts_ms") or row.get("timestamp") or 0)
                else:
                    continue
            except (TypeError, ValueError):
                continue
            if ts <= 0 or ts in seen_ts:
                continue
            seen_ts.add(ts)
            merged.append(row)
        cursor = chunk_end

    merged.sort(
        key=lambda row: int(
            row[0]
            if isinstance(row, (list, tuple))
            else (row.get("ts_ms") or row.get("timestamp") or 0)  # type: ignore[union-attr]
        )
    )
    return merged


def _fetch_deribit_dvol_history_chunk(
    *,
    start_ms: int,
    end_ms: int,
    resolution: str = "3600",
) -> list[Any]:
    """Single Deribit DVOL history request (≤ ~1000 bars)."""
    response = httpx.get(
        f"{DERIBIT_API_BASE}/public/get_volatility_index_data",
        params={
            "currency": "BTC",
            "start_timestamp": int(start_ms),
            "end_timestamp": int(end_ms),
            "resolution": str(resolution),
        },
        timeout=6.0,
    )
    response.raise_for_status()
    body = response.json()
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result, dict):
        return []
    data = result.get("data")
    return data if isinstance(data, list) else []


def _fetch_hyperliquid_btc_1h_closes(
    *,
    start_ms: int,
    end_ms: int,
) -> list[tuple[int, float]]:
    """BTC 1h candle closes from Hyperliquid (same source as RV Trend).

    Pages in ~45d chunks so long VRP windows (365d + RV30 lookback) fill fully
    under HL's soft per-request candle cap.
    """
    start = int(start_ms)
    end = int(end_ms)
    if end <= start:
        return []

    chunk_ms = 45 * 86_400_000
    by_ts: dict[int, float] = {}
    cursor = start
    while cursor < end:
        chunk_end = min(cursor + chunk_ms, end)
        response = httpx.post(
            HYPERLIQUID_INFO_URL,
            json={
                "type": "candleSnapshot",
                "req": {
                    "coin": "BTC",
                    "interval": "1h",
                    "startTime": cursor,
                    "endTime": chunk_end,
                },
            },
            headers={"Content-Type": "application/json"},
            timeout=6.0,
        )
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, list):
            for row in payload:
                ts_ms = _hyperliquid_candle_ts(row)
                close = _hyperliquid_candle_close(row)
                if ts_ms is None or close is None or close <= 0:
                    continue
                by_ts[ts_ms] = close
        cursor = chunk_end

    out = sorted(by_ts.items(), key=lambda p: p[0])
    return out


def _fetch_deribit_btc_perpetual_1h_closes(
    *,
    start_ms: int,
    end_ms: int,
) -> list[tuple[int, float]]:
    """Full-depth BTC-PERPETUAL hourly closes for the primary RV30 series."""
    start = int(start_ms)
    end = int(end_ms)
    if end <= start:
        return []

    chunk_ms = 30 * 86_400_000
    by_ts: dict[int, float] = {}
    cursor = start
    while cursor < end:
        chunk_end = min(cursor + chunk_ms, end)
        response = httpx.get(
            f"{DERIBIT_API_BASE}/public/get_tradingview_chart_data",
            params={
                "instrument_name": "BTC-PERPETUAL",
                "start_timestamp": cursor,
                "end_timestamp": chunk_end,
                "resolution": "60",
            },
            timeout=6.0,
        )
        response.raise_for_status()
        body = response.json()
        result = body.get("result") if isinstance(body, dict) else None
        ticks = result.get("ticks") if isinstance(result, dict) else None
        closes = result.get("close") if isinstance(result, dict) else None
        if isinstance(ticks, list) and isinstance(closes, list):
            for raw_ts, raw_close in zip(ticks, closes, strict=False):
                try:
                    ts_ms = int(raw_ts)
                    close = float(raw_close)
                except (TypeError, ValueError):
                    continue
                if ts_ms > 0 and math.isfinite(close) and close > 0:
                    by_ts[ts_ms] = close
        cursor = chunk_end

    return sorted(by_ts.items(), key=lambda point: point[0])


def _hyperliquid_candle_ts(row: Any) -> int | None:
    """Parse open timestamp (ms) from Hyperliquid candle row."""
    try:
        if isinstance(row, (list, tuple)):
            if len(row) < 1:
                return None
            return int(row[0])
        if isinstance(row, dict):
            return int(row["t"])
    except (TypeError, ValueError, KeyError):
        return None
    return None


def _aggregate_rows(rows: list[dict[str, Any]]) -> list[dict[str, float]]:
    buckets: dict[float, dict[str, float]] = defaultdict(
        lambda: {
            "strike": 0.0,
            "net_gex": 0.0,
            "call_gex": 0.0,
            "put_gex": 0.0,
            "net_delta_exposure_usd": 0.0,
            "call_delta_exposure_usd": 0.0,
            "put_delta_exposure_usd": 0.0,
            "open_interest": 0.0,
            "call_open_interest": 0.0,
            "put_open_interest": 0.0,
            "iv_weighted": 0.0,
        }
    )

    for row in rows:
        strike = float(row["strike"])
        bucket = buckets[strike]
        bucket["strike"] = strike
        bucket["net_gex"] += float(row["net_gex"])
        bucket["call_gex"] += float(row["call_gex"])
        bucket["put_gex"] += float(row["put_gex"])
        bucket["net_delta_exposure_usd"] += _row_float(row, "net_delta_exposure_usd")
        bucket["call_delta_exposure_usd"] += _row_float(row, "call_delta_exposure_usd")
        bucket["put_delta_exposure_usd"] += _row_float(row, "put_delta_exposure_usd")
        open_interest = _row_open_interest(row)
        bucket["open_interest"] += open_interest
        bucket["call_open_interest"] += _row_float(row, "call_open_interest")
        bucket["put_open_interest"] += _row_float(row, "put_open_interest")
        bucket["iv_weighted"] += _row_iv(row) * open_interest

    return [
        {
            **bucket,
            "mark_iv": (bucket["iv_weighted"] / bucket["open_interest"])
            if bucket["open_interest"] > 0
            else 0.0,
        }
        for _, bucket in sorted(buckets.items())
    ]


def _to_gamma_bar(row: dict[str, float]) -> dict[str, float]:
    return {
        "strike": row["strike"],
        "gamma_exposure_usd": row["net_gex"],
        "call_gamma_exposure_usd": row["call_gex"],
        "put_gamma_exposure_usd": row["put_gex"],
        "net_gamma_exposure_usd": row["net_gex"],
        "delta_exposure_usd": row.get("net_delta_exposure_usd", 0.0),
        "call_delta_exposure_usd": row.get("call_delta_exposure_usd", 0.0),
        "put_delta_exposure_usd": row.get("put_delta_exposure_usd", 0.0),
        "net_delta_exposure_usd": row.get("net_delta_exposure_usd", 0.0),
        "open_interest": row.get("open_interest", 0.0),
        "call_open_interest": row.get("call_open_interest", 0.0),
        "put_open_interest": row.get("put_open_interest", 0.0),
        "mark_iv": row.get("mark_iv", 0.0),
    }


def _attach_delta_exposures(
    rows: list[dict[str, Any]],
    *,
    spot: float,
    as_of_ms: int,
) -> list[dict[str, Any]]:
    """Attach signed call/put/net USD delta notional at the live snapshot state."""
    enriched: list[dict[str, Any]] = []
    for source in rows:
        row = dict(source)
        strike = _row_float(row, "strike")
        settle_ms = settle_ms_from_expiry(str(row.get("expiry") or ""))
        if not (spot > 0 and strike > 0 and settle_ms is not None and settle_ms > as_of_ms):
            call_delta_exposure = 0.0
            put_delta_exposure = 0.0
        else:
            tau = max(MIN_TAU_YEARS, (settle_ms - as_of_ms) / MS_PER_YEAR)
            call_delta_exposure = _row_delta_exposure(
                row,
                option_type="call",
                spot=spot,
                strike=strike,
                t_years=tau,
            )
            put_delta_exposure = _row_delta_exposure(
                row,
                option_type="put",
                spot=spot,
                strike=strike,
                t_years=tau,
            )
        row["call_delta_exposure_usd"] = call_delta_exposure
        row["put_delta_exposure_usd"] = put_delta_exposure
        row["net_delta_exposure_usd"] = call_delta_exposure + put_delta_exposure
        enriched.append(row)
    return enriched


def _row_delta_exposure(
    row: dict[str, Any],
    *,
    option_type: str,
    spot: float,
    strike: float,
    t_years: float,
) -> float:
    iv = _row_leg_iv(row, option_type)
    if iv is None:
        return 0.0
    delta = bs_delta(
        spot=spot,
        strike=strike,
        t_years=t_years,
        iv=iv,
        option_type=option_type,
    )
    if delta is None:
        return 0.0

    position = _optional_row_float(row, f"{option_type}_position_units")
    if position is None:
        gamma = bs_gamma(spot=spot, strike=strike, t_years=t_years, iv=iv)
        denominator = (gamma or 0.0) * spot * spot * 0.01
        if gamma is None or gamma < MIN_REF_GAMMA or denominator == 0:
            return 0.0
        position = _row_float(row, f"{option_type}_gex") / denominator

    exposure = position * delta * spot
    return exposure if math.isfinite(exposure) else 0.0


def _row_leg_iv(row: dict[str, Any], option_type: str) -> float | None:
    for key in (f"{option_type}_flow_iv", f"{option_type}_mark_iv", "mark_iv"):
        iv = normalize_mark_iv(row.get(key))
        if iv is not None:
            return iv
    return None


def _optional_row_float(row: dict[str, Any], key: str) -> float | None:
    value = row.get(key)
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _build_all_expiry_levels(rows: list[dict[str, float]], spot: float) -> list[dict[str, Any]]:
    """
    All-expiry flow GEX peaks (taker-flow net_gex by strike).

    - Positive Gamma: strike with most positive net_gex (argmax).
    - Negative Gamma: strike with most negative net_gex (argmin).

    Gamma Flip lives under Key Levels / reference (not here).
    """
    peaks = _peak_gex_levels(rows, spot)
    return [
        _level(
            "Positive Gamma",
            peaks["positive_gamma"],
            spot,
            "#94c970",
            net_gex=peaks["positive_gamma_gex"],
        ),
        _level(
            "Negative Gamma",
            peaks["negative_gamma"],
            spot,
            "#ee5f66",
            net_gex=peaks["negative_gamma_gex"],
        ),
    ]


def _build_zero_dte_levels(rows: list[dict[str, float]], spot: float) -> list[dict[str, Any]]:
    """Same peak semantics as all-expiry, scoped to the front/0DTE surface."""
    peaks = _peak_gex_levels(rows, spot)
    return [
        _level(
            "0DTE Positive Gamma",
            peaks["positive_gamma"],
            spot,
            "#94c970",
            net_gex=peaks["positive_gamma_gex"],
        ),
        _level(
            "0DTE Negative Gamma",
            peaks["negative_gamma"],
            spot,
            "#ee5f66",
            net_gex=peaks["negative_gamma_gex"],
        ),
    ]


def _build_kind_levels(
    source_rows: list[dict[str, Any]],
    spot: float,
    *,
    kind: str,
) -> list[dict[str, Any]]:
    """Positive/Negative Gamma peaks for the nearest upcoming expiry of ``kind``.

    Kinds match ``_expiry_kind`` (weekly / monthly / quarterly). Empty list when
    no live listed expiry of that kind exists. Labels match All/0DTE so the
    Levels desk can share row chrome; ``scope_label`` carries the expiry date.
    """
    expiry = _select_nearest_expiry_of_kind(source_rows, kind)
    if expiry is None:
        return []

    rows = _aggregate_rows([row for row in source_rows if str(row["expiry"]) == expiry])
    if not rows:
        return []

    peaks = _peak_gex_levels(rows, spot)
    return [
        _level(
            "Positive Gamma",
            peaks["positive_gamma"],
            spot,
            "#94c970",
            net_gex=peaks["positive_gamma_gex"],
            scope_label=expiry,
        ),
        _level(
            "Negative Gamma",
            peaks["negative_gamma"],
            spot,
            "#ee5f66",
            net_gex=peaks["negative_gamma_gex"],
            scope_label=expiry,
        ),
    ]


def _select_nearest_expiry_of_kind(
    source_rows: list[dict[str, Any]],
    kind: str,
) -> str | None:
    """Nearest not-yet-settled listed expiry classified as ``kind``."""
    seen: set[str] = set()
    candidates: list[tuple[float, str]] = []
    for row in source_rows:
        expiry = str(row["expiry"])
        if expiry in seen:
            continue
        seen.add(expiry)
        if _expiry_kind(expiry) != kind:
            continue
        _days, hours = _time_to_expiry(expiry)
        if hours <= 0:
            continue
        candidates.append((hours, expiry))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]


def _compute_hvl_by_expiry(
    source_rows: list[dict[str, Any]],
    *,
    spot: float,
    expiries: list[str],
) -> dict[str, dict[str, Any]]:
    """HVL per listed expiry: cumulative flow-GEX zero-cross on that surface.

    HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12%
    (mass filter 1.5%). Not classic OI gamma flip.
    """
    out: dict[str, dict[str, Any]] = {}
    for expiry in expiries:
        rows = _aggregate_rows(
            [row for row in source_rows if str(row["expiry"]) == expiry]
        )
        level, status = _estimate_gamma_flip(rows, spot=spot)
        note = _gamma_flip_empty_note(rows, spot=spot, status=status)
        out[str(expiry)] = {
            "level": level,
            "status": status,
            "note": note,
        }
    return out


def _build_reference_levels(
    all_rows: list[dict[str, float]],
    source_rows: list[dict[str, Any]],
    spot: float,
    front_expiry: str,
    *,
    gamma_flip: float | None = None,
    gamma_flip_status: str | None = None,
    gamma_flip_note: str | None = None,
    hvl_scope_label: str | None = None,
    hvl_book_level: float | None = None,
    hvl_book_status: str | None = None,
    hvl_book_note: str | None = None,
    distance_spot: float | None = None,
) -> list[dict[str, Any]]:
    """Reference metrics for the terminal Levels desk.

    - HVL (primary): cumulative net_gex zero-cross on the **session / front
      expiry** (or selected expiry), inside spot ± 12% (see
      `_estimate_gamma_flip`). Not the ALL-book aggregate.
      Value is "—" when status is no_cross (never a fake flattest-bar level).
      Optional `note` carries locked empty-state copy (one-sided short/long).
    - Book HVL (secondary): optional multi-expiry ALL-surface zero-cross with
      an explicit multi-expiry tooltip — never the default Levels readout.
    - Max Pain: OI-based settlement strike (minimizes call+put extrinsic payout).
    - Expected Move: vol-based 1σ band from front-expiry IV — independent of GEX.

    ``spot`` is materialize GEX spot (HVL eligibility + Expected Move band).
    ``distance_spot`` (default ``spot``) is the trading reference for DIST %
    — live Deribit index when available.

    API aliases: historical label "Zero Gamma" / fields gamma_flip / zero_gamma
    still map to the same HVL level for compatibility.
    """
    dist_ref = float(distance_spot) if distance_spot is not None else spot
    scope_label = hvl_scope_label or front_expiry
    if gamma_flip_status is None:
        # Callers that only pass rows (tests / older paths): prefer front expiry
        # surface over ALL-book aggregate when rows are multi-expiry.
        front_rows = _aggregate_rows(
            [row for row in source_rows if str(row["expiry"]) == front_expiry]
        )
        hvl_rows = front_rows if front_rows else all_rows
        gamma_flip, gamma_flip_status = _estimate_gamma_flip(hvl_rows, spot=spot)
        if gamma_flip_note is None and gamma_flip_status == "no_cross":
            gamma_flip_note = _gamma_flip_empty_note(
                hvl_rows, spot=spot, status=gamma_flip_status
            )
    if gamma_flip_note is None and gamma_flip_status == "no_cross":
        front_rows = _aggregate_rows(
            [row for row in source_rows if str(row["expiry"]) == front_expiry]
        )
        gamma_flip_note = _gamma_flip_empty_note(
            front_rows if front_rows else all_rows,
            spot=spot,
            status=gamma_flip_status,
        )
    max_pain_expiry = _select_max_pain_expiry(source_rows, front_expiry)
    max_pain_rows = [row for row in source_rows if str(row["expiry"]) == max_pain_expiry] or source_rows
    max_pain = _estimate_max_pain(max_pain_rows)
    expected_move = _estimate_expected_move(source_rows, spot, front_expiry)
    flip_value = _format_usd(gamma_flip) if gamma_flip is not None else "—"
    # Distance convention (Levels + rankings): (level − display_spot) / display_spot × 100.
    flip_change = (
        f"{_distance_from_spot(gamma_flip, dist_ref):+.2f}%"
        if gamma_flip is not None
        else None
    )
    # Primary HVL — session/front (or selected) expiry, not ALL book.
    flip_metric: dict[str, Any] = {
        "label": "HVL",
        "value": flip_value,
        "change": flip_change,
        "color": "#d0bc62",
        "scope": "session",
        "scope_label": scope_label if scope_label and scope_label != "ALL" else front_expiry,
        "status": gamma_flip_status,
        # HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12%
        # (mass filter 1.5%). Not classic OI gamma flip.
        "definition": (
            "HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12% "
            "(mass filter 1.5%). Not classic OI gamma flip."
        ),
    }
    if gamma_flip_note:
        flip_metric["note"] = gamma_flip_note

    metrics: list[dict[str, Any]] = [flip_metric]

    # Optional Book HVL (ALL multi-expiry sum) — secondary, clearly labeled.
    if hvl_book_status is not None:
        book_value = (
            _format_usd(hvl_book_level) if hvl_book_level is not None else "—"
        )
        book_change = (
            f"{_distance_from_spot(hvl_book_level, dist_ref):+.2f}%"
            if hvl_book_level is not None
            else None
        )
        book_metric: dict[str, Any] = {
            "label": "Book HVL",
            "value": book_value,
            "change": book_change,
            "color": "#a8b7c4",
            "scope": "book",
            "scope_label": "ALL",
            "status": hvl_book_status,
            "note": hvl_book_note or HVL_BOOK_NOTE,
            "tooltip": HVL_BOOK_NOTE,
            "definition": (
                "Book HVL = cumulative flow-GEX zero-cross on the multi-expiry "
                "ALL surface (summed inventory). Secondary to session HVL."
            ),
        }
        metrics.append(book_metric)

    metrics.extend(
        [
            {
                "label": "Max Pain",
                "value": _format_usd(max_pain),
                "color": "#d35fe9",
                "scope": "session",
                "scope_label": max_pain_expiry,
            },
            {
                "label": "Expected Move",
                "value": f"{_format_usd(expected_move[0])}-{_format_usd(expected_move[1])}",
                "color": "#e4cf7e",
                "scope": "session",
                "scope_label": front_expiry,
            },
        ]
    )
    return metrics


def _select_max_pain_expiry(source_rows: list[dict[str, Any]], front_expiry: str) -> str:
    """Pick the expiry whose max pain is most actionable right now.

    Max pain only matters near settlement. Prefer the largest book among
    expiries inside their kind-specific window (monthly/quarterly/weekly).
    When no major OPEX is near, fall back to the front/0DTE contract.
    """
    rows_by_expiry: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in source_rows:
        rows_by_expiry[str(row["expiry"])].append(row)

    if not rows_by_expiry:
        return front_expiry

    total_oi = sum(_row_open_interest(row) for row in source_rows) or 1.0
    best_expiry = front_expiry if front_expiry in rows_by_expiry else next(iter(rows_by_expiry))
    best_score = -1.0

    for expiry, rows in rows_by_expiry.items():
        days, hours = _time_to_expiry(expiry)
        # Skip already-settled contracts so stale history cannot dominate.
        if hours <= 0:
            continue
        kind = _expiry_kind(expiry)
        oi_share = sum(_row_open_interest(row) for row in rows) / total_oi
        window = _max_pain_window_score(kind, days, hours)
        if window <= 0:
            continue
        # Size matters once the expiry is in its settlement window.
        score = window * (0.35 + 0.65 * oi_share)
        if score > best_score:
            best_score = score
            best_expiry = expiry

    return best_expiry


def _max_pain_window_score(kind: str, days: float, hours: float) -> float:
    """How 'live' max pain is for this kind given time to settlement.

    Returns 0 outside the useful window so far tenors never win by size alone.
    """
    if kind == "quarterly":
        if days <= 7:
            return 1.45
        if days <= 14:
            return 1.05
        if days <= 21:
            return 0.45
        return 0.0

    if kind == "monthly":
        if days <= 5:
            return 1.35
        if days <= 10:
            return 0.95
        if days <= 14:
            return 0.4
        return 0.0

    if kind == "weekly":
        if days <= 2:
            return 1.15
        if days <= 5:
            return 0.7
        return 0.0

    # daily / front session — always a valid fallback, strongest inside ~1.5d
    if hours <= 36:
        return 1.0
    if days <= 2:
        return 0.55
    return 0.2


def _build_rankings(
    rows: list[dict[str, float]],
    spot: float,
    source_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    ranked = sorted(rows, key=lambda row: abs(row["net_gex"]), reverse=True)[:10]
    return [
        {
            "rank": index + 1,
            "strike": row["strike"],
            "distance_from_spot_percent": _distance_from_spot(row["strike"], spot),
            "gamma_exposure_usd": row["net_gex"],
            "call_gamma_exposure_usd": row["call_gex"],
            "put_gamma_exposure_usd": row["put_gex"],
            "open_interest": row.get("open_interest", 0.0),
            "call_open_interest": row.get("call_open_interest", 0.0),
            "put_open_interest": row.get("put_open_interest", 0.0),
            "gex_history": [
                {
                    "label": "Live",
                    "net_gex_usd": row["net_gex"],
                    "call_gex_usd": row["call_gex"],
                    "put_gex_usd": row["put_gex"],
                }
            ],
            "expiry_contributions": _build_expiry_contributions(source_rows, row["strike"]),
        }
        for index, row in enumerate(ranked)
    ]


def _build_expiry_contributions(source_rows: list[dict[str, Any]], strike: float) -> list[dict[str, Any]]:
    contributions = [
        {
            "expiry": str(row["expiry"]),
            "gamma_exposure_usd": float(row["net_gex"]),
            "call_gamma_exposure_usd": float(row["call_gex"]),
            "put_gamma_exposure_usd": float(row["put_gex"]),
            "open_interest": _row_open_interest(row),
            "call_open_interest": _row_float(row, "call_open_interest"),
            "put_open_interest": _row_float(row, "put_open_interest"),
        }
        for row in source_rows
        if float(row["strike"]) == strike
    ]
    return sorted(contributions, key=lambda row: abs(row["gamma_exposure_usd"]), reverse=True)


def _build_expiry_events(
    source_rows: list[dict[str, Any]],
    spot: float,
    *,
    distance_spot: float | None = None,
) -> list[dict[str, Any]]:
    """OPEX positioning events.

    ``spot`` is used for expiring notional (snapshot underlying).
    ``distance_spot`` (default ``spot``) drives near-spot filters and DIST %.
    """
    dist_ref = float(distance_spot) if distance_spot is not None else spot
    rows_by_expiry: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in source_rows:
        rows_by_expiry[str(row["expiry"])].append(row)

    total_open_interest = sum(_row_open_interest(row) for row in source_rows)
    max_expiry_share = 0.0
    unscored: list[dict[str, Any]] = []
    for expiry, rows in rows_by_expiry.items():
        expiry_open_interest = sum(_row_open_interest(row) for row in rows)
        max_expiry_share = max(max_expiry_share, expiry_open_interest / total_open_interest if total_open_interest else 0.0)
        near_spot_rows = [row for row in rows if abs(_distance_from_spot(float(row["strike"]), dist_ref)) <= 2.5]
        near_spot_open_interest = sum(_row_open_interest(row) for row in near_spot_rows)
        days_to_expiry, hours_to_expiry = _time_to_expiry(expiry)
        top_strikes = sorted(
            rows,
            key=lambda row: _row_open_interest(row) * (1 + (1 / (1 + abs(_distance_from_spot(float(row["strike"]), dist_ref))))),
            reverse=True,
        )[:4]
        unscored.append(
            {
                "expiry": expiry,
                "kind": _expiry_kind(expiry),
                "days_to_expiry": days_to_expiry,
                "hours_to_expiry": hours_to_expiry,
                "expiring_open_interest": expiry_open_interest,
                "expiring_notional_usd": expiry_open_interest * spot,
                "open_interest_share_percent": (expiry_open_interest / total_open_interest * 100) if total_open_interest else 0.0,
                "abs_gamma_exposure_usd": sum(abs(float(row["net_gex"])) for row in rows),
                "near_spot_open_interest": near_spot_open_interest,
                "near_spot_open_interest_share_percent": (near_spot_open_interest / expiry_open_interest * 100) if expiry_open_interest else 0.0,
                "near_spot_gamma_exposure_usd": sum(abs(float(row["net_gex"])) for row in near_spot_rows),
                "urgency_score": _clamp((1 - days_to_expiry / 45) * 100, 0, 100),
                "top_strikes": [
                    {
                        "strike": float(row["strike"]),
                        "distance_from_spot_percent": _distance_from_spot(float(row["strike"]), dist_ref),
                        "gamma_exposure_usd": float(row["net_gex"]),
                        "call_gamma_exposure_usd": float(row["call_gex"]),
                        "put_gamma_exposure_usd": float(row["put_gex"]),
                        "open_interest": _row_open_interest(row),
                        "call_open_interest": _row_float(row, "call_open_interest"),
                        "put_open_interest": _row_float(row, "put_open_interest"),
                        "open_interest_share_percent": (_row_open_interest(row) / expiry_open_interest * 100) if expiry_open_interest else 0.0,
                    }
                    for row in top_strikes
                ],
            }
        )

    events = []
    for event in unscored:
        open_interest_share = event["open_interest_share_percent"] / 100
        size_score = (open_interest_share / max_expiry_share * 100) if max_expiry_share else 0.0
        concentration_score = event["near_spot_open_interest_share_percent"]
        importance_score = (size_score * 0.4) + (concentration_score * 0.35) + (event["urgency_score"] * 0.25)
        events.append(
            {
                **event,
                "size_score": size_score,
                "concentration_score": concentration_score,
                "importance_score": importance_score,
            }
        )

    return sorted(events, key=lambda event: event["importance_score"], reverse=True)


def _estimate_gamma_flip(
    rows: list[dict[str, float]],
    spot: float | None = None,
) -> tuple[float | None, str]:
    """
    HVL from a taker-flow net GEX surface (cumulative zero-cross).

    HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12%
    (mass filter 1.5%). Not classic OI gamma flip.

    UI label is **HVL**. API fields ``gamma_flip`` / ``zero_gamma`` / ``hvl``
    share this level for temporary compatibility.

    ``rows`` is the surface under study — a single expiry (preferred) or the
    full ALL book (Book HVL secondary only). Levels default uses front/active
    session expiry, not the multi-expiry aggregate.

    Taker-flow notes (vs common OI models):
      - Sign is pure dealer inventory from cumulative taker flow (no put flip).
      - Flow-netted books are smaller/noisier → mass filter drops zig-zag noise.
      - Far wing zeros on one-sided near-spot books are not published.

    Shared definition used by:
      - levels.reference → HVL (session) / Book HVL (ALL secondary)
      - terminal hvl / gamma_flip / zero_gamma
      - bands-chart HVL line (FE mirrors this estimator)

    Algorithm:
      1. Walk strikes low → high; accumulate net_gex.
      2. Detect zero-crossings of the *cumulative* series only
         (linear interpolation between adjacent cumulative sums).
      3. Mass filter vs **window-local** Σ|net_gex| (eligibility window strikes;
         full book if window empty): |prev_cum| + |next_cum| ≥ 1.5% of that sum.
      4. Eligibility: |level − spot| / spot ≤ 0.12 (±12%).
      5. Among eligible crossings, pick nearest to spot (tie → larger mass).
      6. If none: return (None, "no_cross"). Never invent from flattest |net_gex|.

    Returns:
      (level, status) where status is "ok" | "no_cross".
    """
    if not rows:
        return None, "no_cross"

    sorted_rows = sorted(rows, key=lambda row: row["strike"])
    ref = (
        float(spot)
        if spot is not None and spot > 0
        else float(sorted_rows[len(sorted_rows) // 2]["strike"])
    )

    # Mass denominator: prefer Σ|net| inside the eligibility window so far-wing
    # inventory does not bury a real near-spot cumulative cross on flow books.
    max_dist = ref * GAMMA_FLIP_MAX_DISTANCE_FRAC if ref > 0 else None
    if max_dist is not None:
        window_rows = [
            row
            for row in sorted_rows
            if abs(float(row["strike"]) - ref) <= max_dist
        ]
    else:
        window_rows = []
    mass_rows = window_rows if window_rows else sorted_rows
    total_abs = sum(abs(float(row["net_gex"])) for row in mass_rows)
    min_mass = max(total_abs * GAMMA_FLIP_MIN_MASS_FRACTION, 1e-12)

    # (level, mass) — mass = |prev_cum| + |next_cum| at the step
    crossings: list[tuple[float, float]] = []
    previous_strike: float | None = None
    previous_cumulative: float | None = None
    cumulative = 0.0

    for row in sorted_rows:
        strike = float(row["strike"])
        next_cumulative = cumulative + float(row["net_gex"])

        if previous_cumulative is not None and previous_strike is not None:
            prev = previous_cumulative
            nxt = next_cumulative

            if prev == 0.0 and nxt == 0.0:
                # Still at zero — not a new crossing.
                pass
            elif nxt == 0.0 and prev != 0.0:
                # True cumulative zero lands on this strike.
                mass = abs(prev) + abs(nxt)
                if mass >= min_mass:
                    crossings.append((strike, mass))
            elif prev != 0.0 and nxt != 0.0 and math.copysign(1.0, prev) != math.copysign(1.0, nxt):
                mass = abs(prev) + abs(nxt)
                if mass >= min_mass:
                    ratio = abs(prev) / mass
                    level = previous_strike + (strike - previous_strike) * ratio
                    crossings.append((level, mass))
            # prev == 0 and nxt != 0: leaving a prior zero — already recorded when we hit zero.

        cumulative = next_cumulative
        previous_strike = strike
        previous_cumulative = cumulative

    # Near-spot eligibility: discard mass-valid crosses outside spot ± 12%.
    if max_dist is not None:
        crossings = [item for item in crossings if abs(item[0] - ref) <= max_dist]

    if not crossings:
        return None, "no_cross"

    level = min(crossings, key=lambda item: (abs(item[0] - ref), -item[1]))[0]
    return level, "ok"


def _one_sided_gex_polarity(
    rows: list[dict[str, float]],
    spot: float | None = None,
) -> str | None:
    """Local-book polarity for empty-state Flip copy.

    Prefers net GEX of strikes inside the Gamma Flip eligibility window
    (spot ± 15%). Falls back to the full listed book when the window is empty.
    Returns ``"short"`` / ``"long"`` only when |net| / Σ|net| is cleanly
    one-sided (≥ ``GAMMA_FLIP_ONE_SIDED_MIN_FRAC``); otherwise ``None``
    (neutral copy without suffix). Reading sign only — no GEX formula change.
    """
    if not rows:
        return None

    ref = float(spot) if spot is not None and spot > 0 else 0.0
    window_rows = rows
    if ref > 0:
        max_dist = ref * GAMMA_FLIP_MAX_DISTANCE_FRAC
        in_window = [
            row for row in rows if abs(float(row["strike"]) - ref) <= max_dist
        ]
        if in_window:
            window_rows = in_window

    net = sum(float(row["net_gex"]) for row in window_rows)
    total_abs = sum(abs(float(row["net_gex"])) for row in window_rows)
    if total_abs <= 0:
        return None

    score = net / total_abs
    if score <= -GAMMA_FLIP_ONE_SIDED_MIN_FRAC:
        return "short"
    if score >= GAMMA_FLIP_ONE_SIDED_MIN_FRAC:
        return "long"
    return None


def _gamma_flip_empty_note(
    rows: list[dict[str, float]],
    *,
    spot: float | None = None,
    status: str,
) -> str | None:
    """Locked empty-state string when Flip status is no_cross; else None."""
    if status != "no_cross":
        return None
    polarity = _one_sided_gex_polarity(rows, spot=spot)
    if polarity == "short":
        return GAMMA_FLIP_EMPTY_SHORT
    if polarity == "long":
        return GAMMA_FLIP_EMPTY_LONG
    return GAMMA_FLIP_EMPTY_NEUTRAL


# Backward-compatible name for any external importers / older docs.
def _estimate_zero_gamma(
    rows: list[dict[str, float]],
    spot: float | None = None,
) -> float | None:
    """Legacy alias: returns Flip level or None (no flattest-bar fallback)."""
    level, _status = _estimate_gamma_flip(rows, spot=spot)
    return level


def _peak_gex_levels(rows: list[dict[str, float]], spot: float) -> dict[str, float]:
    """Positive / Negative Gamma peaks from signed net GEX by strike.

    Pure argmax/argmin over the filtered surface (all-expiry or 0DTE) — no
    spot-side call/put wall heuristics.
    """
    if not rows:
        return {
            "positive_gamma": spot,
            "positive_gamma_gex": 0.0,
            "negative_gamma": spot,
            "negative_gamma_gex": 0.0,
        }

    positive = max(rows, key=lambda row: float(row["net_gex"]))
    negative = min(rows, key=lambda row: float(row["net_gex"]))

    return {
        "positive_gamma": float(positive["strike"]),
        "positive_gamma_gex": float(positive["net_gex"]),
        "negative_gamma": float(negative["strike"]),
        "negative_gamma_gex": float(negative["net_gex"]),
    }


def _estimate_max_pain(rows: list[dict[str, Any]]) -> float:
    strikes = sorted({float(row["strike"]) for row in rows})
    if not strikes:
        return 0.0

    def payout(candidate: float) -> float:
        return sum(
            _row_float(row, "call_open_interest") * max(0.0, candidate - float(row["strike"]))
            + _row_float(row, "put_open_interest") * max(0.0, float(row["strike"]) - candidate)
            for row in rows
        )

    return min(strikes, key=payout)


def _estimate_expected_move(rows: list[dict[str, Any]], spot: float, front_expiry: str) -> tuple[float, float]:
    front_rows = [row for row in rows if str(row["expiry"]) == front_expiry] or rows
    total_open_interest = sum(_row_open_interest(row) for row in front_rows)
    if total_open_interest > 0:
        iv = sum(_row_iv(row) * _row_open_interest(row) for row in front_rows) / total_open_interest
    else:
        iv = 0.55
    days_to_expiry, _ = _time_to_expiry(front_expiry)
    move = spot * _normalize_iv(iv) * math.sqrt(max(days_to_expiry, 1 / 24) / 365)
    return spot - move, spot + move


def _nearest_strike(rows: list[dict[str, float]], target: float) -> float:
    if not rows:
        return target
    return min(rows, key=lambda row: abs(row["strike"] - target))["strike"]


def _strike_for_extreme(rows: list[dict[str, float]], *, highest: bool) -> float:
    if not rows:
        return 0.0
    key = (lambda row: row["net_gex"]) if highest else (lambda row: -row["net_gex"])
    return max(rows, key=key)["strike"]


def _level(
    label: str,
    strike: float,
    spot: float,
    color: str,
    *,
    net_gex: float | None = None,
    scope_label: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "label": label,
        "strike": strike,
        "distance_from_spot_percent": _distance_from_spot(strike, spot),
        "color": color,
    }
    if net_gex is not None:
        payload["net_gex"] = float(net_gex)
    if scope_label:
        payload["scope_label"] = str(scope_label)
    return payload


def _row_open_interest(row: dict[str, Any]) -> float:
    explicit = _row_float(row, "open_interest")
    if explicit > 0:
        return explicit
    return _row_float(row, "call_open_interest") + _row_float(row, "put_open_interest")


def _row_iv(row: dict[str, Any]) -> float:
    return (
        _row_float(row, "mark_iv")
        or _row_float(row, "call_mark_iv")
        or _row_float(row, "put_mark_iv")
    )


def _row_float(row: dict[str, Any], key: str) -> float:
    value = row.get(key)
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _build_iv_signal_eligibility(
    *,
    scan: Mapping[str, Any],
    as_of: datetime,
    spot: float,
    snapshot_age_seconds: float,
    has_base_suppression: bool,
) -> tuple[IvSignalEligibility, list[str]]:
    """Apply the fail-closed product policy layered over the parity model.

    Longer-dated expiries retain the scanner's established release gates. A
    true UTC settlement-day contract must additionally clear every 0DTE check
    before either the API or the UI may expose a directional outlook.
    """
    normalized_as_of = as_of if as_of.tzinfo else as_of.replace(tzinfo=UTC)
    normalized_as_of = normalized_as_of.astimezone(UTC)
    settlement_at = scan.get("settlement_at")
    if not isinstance(settlement_at, datetime):
        raise ValueError("IV signal scan is missing an exact settlement timestamp.")
    normalized_settlement = (
        settlement_at
        if settlement_at.tzinfo
        else settlement_at.replace(tzinfo=UTC)
    ).astimezone(UTC)
    hours_to_settlement = max(
        (normalized_settlement - normalized_as_of).total_seconds() / 3600.0,
        0.0,
    )
    is_zero_dte = normalized_settlement.date() == normalized_as_of.date()

    raw_signals = scan.get("signals")
    signals = raw_signals if isinstance(raw_signals, Mapping) else {}
    active_directions: list[str] = []
    for signal_name in ("skew", "tails", "peak", "band"):
        raw_signal = signals.get(signal_name)
        if not isinstance(raw_signal, Mapping):
            continue
        direction = str(raw_signal.get("signal") or "NO_TRADE")
        if direction in {"LONG", "SHORT"}:
            active_directions.append(direction)
    model_verdict = str(scan.get("model_verdict") or "NO_TRADE")
    aligned_signal_count = (
        active_directions.count(model_verdict)
        if model_verdict in {"LONG", "SHORT"}
        else 0
    )
    signal_alignment = (
        model_verdict in {"LONG", "SHORT"}
        and aligned_signal_count >= IV_SIGNAL_ZERO_DTE_MIN_ALIGNED_SIGNALS
        and aligned_signal_count == len(active_directions)
    )

    selection = scan.get("selection")
    selection_map = selection if isinstance(selection, Mapping) else {}
    try:
        otm_ref = float(
            selection_map.get("otm_reference")
            or selection_map.get("implied_forward")
            or spot
        )
    except (TypeError, ValueError):
        otm_ref = float(spot)
    if not math.isfinite(otm_ref) or otm_ref <= 0:
        otm_ref = float(spot)
    lower_gaps: list[float] = []
    upper_gaps: list[float] = []
    if math.isfinite(otm_ref) and otm_ref > 0:
        raw_curve = scan.get("iv_curve")
        curve = raw_curve if isinstance(raw_curve, list) else []
        for raw_point in curve:
            if not isinstance(raw_point, Mapping) or raw_point.get("synthetic") is True:
                continue
            source = str(raw_point.get("source") or "")
            try:
                strike = float(raw_point.get("strike"))
            except (TypeError, ValueError):
                continue
            if not math.isfinite(strike) or strike <= 0 or strike == otm_ref:
                continue
            gap_percent = abs((strike / otm_ref) - 1.0) * 100.0
            if strike < otm_ref and source == "put_otm_mark_iv":
                lower_gaps.append(gap_percent)
            elif strike > otm_ref and source == "call_otm_mark_iv":
                upper_gaps.append(gap_percent)

    near_lower_count = sum(
        gap <= IV_SIGNAL_ZERO_DTE_NEAR_SPOT_WINDOW_PERCENT for gap in lower_gaps
    )
    near_upper_count = sum(
        gap <= IV_SIGNAL_ZERO_DTE_NEAR_SPOT_WINDOW_PERCENT for gap in upper_gaps
    )
    nearest_lower_gap = min(lower_gaps) if lower_gaps else None
    nearest_upper_gap = min(upper_gaps) if upper_gaps else None
    coverage = scan.get("coverage")
    coverage_map = coverage if isinstance(coverage, Mapping) else {}
    tenor = tenor_coverage_spec(hours_to_settlement / (365.0 * 24.0))
    two_sided_coverage = (
        near_lower_count >= IV_SIGNAL_ZERO_DTE_MIN_CANONICAL_STRIKES_PER_SIDE
        and near_upper_count >= IV_SIGNAL_ZERO_DTE_MIN_CANONICAL_STRIKES_PER_SIDE
        and nearest_lower_gap is not None
        and nearest_lower_gap <= IV_SIGNAL_ZERO_DTE_MAX_NEAREST_GAP_PERCENT
        and nearest_upper_gap is not None
        and nearest_upper_gap <= IV_SIGNAL_ZERO_DTE_MAX_NEAREST_GAP_PERCENT
        and bool(coverage_map.get("spot_bracketed"))
        and float(
            coverage_map.get("hard_valid_coverage_ratio")
            if coverage_map.get("hard_valid_coverage_ratio") is not None
            else coverage_map.get("iv_coverage_ratio")
            or 0.0
        )
        >= MIN_SIGNAL_IV_COVERAGE_RATIO
        and int(selection_map.get("selected_market_strikes") or 0)
        >= tenor.min_strikes
    )
    curve_quality = scan.get("curve_quality")
    quality_map = curve_quality if isinstance(curve_quality, Mapping) else {}
    requirements = IvSignalEligibilityRequirements(
        settlement_window=hours_to_settlement > IV_SIGNAL_ZERO_DTE_MIN_HOURS,
        curve_quality=str(quality_map.get("level") or "") == "HIGH",
        two_sided_coverage=two_sided_coverage,
        quote_freshness=(
            math.isfinite(float(snapshot_age_seconds))
            and snapshot_age_seconds <= IV_SIGNAL_ZERO_DTE_MAX_QUOTE_AGE_SECONDS
        ),
        signal_alignment=signal_alignment,
    )
    zero_dte_requirements_pass = all(
        (
            requirements.settlement_window,
            requirements.curve_quality,
            requirements.two_sided_coverage,
            requirements.quote_freshness,
            requirements.signal_alignment,
        )
    )
    directional_eligible = (
        not has_base_suppression
        and model_verdict in {"LONG", "SHORT"}
        and (not is_zero_dte or zero_dte_requirements_pass)
    )
    zero_dte_eligible = is_zero_dte and directional_eligible

    reasons: list[str] = []
    if is_zero_dte:
        if not requirements.settlement_window:
            reasons.append("0DTE requires more than 4 hours to settlement")
        if not requirements.curve_quality:
            reasons.append("0DTE requires HIGH curve quality")
        if not requirements.two_sided_coverage:
            reasons.append("0DTE requires strong two-sided strike coverage around spot")
        if not requirements.quote_freshness:
            reasons.append("0DTE requires quotes no more than 10 seconds old")
        if not requirements.signal_alignment:
            reasons.append("0DTE requires at least two aligned signals")

    eligibility = IvSignalEligibility(
        is_zero_dte=is_zero_dte,
        directional_eligible=directional_eligible,
        zero_dte_eligible=zero_dte_eligible,
        recommended_refresh_seconds=(
            IV_SIGNAL_ZERO_DTE_REFRESH_SECONDS
            if zero_dte_eligible
            else IV_SIGNAL_STANDARD_REFRESH_SECONDS
        ),
        hours_to_settlement=hours_to_settlement,
        active_signal_count=len(active_directions),
        aligned_signal_count=aligned_signal_count,
        lower_canonical_strikes=near_lower_count,
        upper_canonical_strikes=near_upper_count,
        nearest_lower_gap_percent=nearest_lower_gap,
        nearest_upper_gap_percent=nearest_upper_gap,
        requirements=requirements,
    )
    return eligibility, reasons


def _normalize_expiry_key(expiry: str, known: list[str]) -> str:
    """Map a client expiry string onto a listed snapshot expiry when possible."""
    if not expiry or expiry == "ALL":
        return "ALL"
    if expiry in known:
        return expiry
    # Exact ISO date prefix match (YYYY-MM-DD...).
    if len(expiry) >= 10:
        iso = expiry[:10]
        if iso in known:
            return iso
        for item in known:
            if item.startswith(iso) or iso.startswith(item[:10]):
                return item
    return expiry


def _normalize_iv(value: float) -> float:
    if value <= 0:
        return 0.55
    return value / 100 if value > 3 else value


def _distance_from_spot(strike: float, spot: float) -> float:
    if spot == 0:
        return 0.0
    return ((strike - spot) / spot) * 100


def _format_usd(value: float) -> str:
    return f"${value:,.0f}"


def _time_to_expiry(expiry: str) -> tuple[float, float]:
    expiry_dt = _parse_expiry_date(expiry)
    if expiry_dt is None:
        return 0.0, 0.0
    hours = max(0.0, (expiry_dt - datetime.now(UTC)).total_seconds() / 3600)
    return hours / 24, hours


def _parse_expiry_date(expiry: str) -> datetime | None:
    try:
        date = datetime.fromisoformat(expiry)
        return date.replace(tzinfo=UTC, hour=8, minute=0, second=0, microsecond=0)
    except ValueError:
        return None


def _expiry_kind(expiry: str) -> str:
    expiry_dt = _parse_expiry_date(expiry)
    if expiry_dt is None:
        return "daily"
    if expiry_dt.weekday() == 4:
        next_friday = expiry_dt.replace(day=expiry_dt.day) + timedelta(days=7)
        if next_friday.month != expiry_dt.month:
            return "quarterly" if expiry_dt.month in {3, 6, 9, 12} else "monthly"
        return "weekly"
    return "daily"


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def _as_of_to_ms(as_of: Any) -> int:
    """Best-effort snapshot as_of → epoch ms."""
    if as_of is None:
        return int(datetime.now(UTC).timestamp() * 1000)
    if isinstance(as_of, (int, float)) and math.isfinite(float(as_of)):
        v = float(as_of)
        # Heuristic: seconds vs ms.
        return int(v * 1000) if v < 1e12 else int(v)
    text = str(as_of).strip()
    if not text:
        return int(datetime.now(UTC).timestamp() * 1000)
    try:
        dt = SnapshotRepository._parse_as_of(text)
        return int(dt.timestamp() * 1000)
    except (TypeError, ValueError):
        return int(datetime.now(UTC).timestamp() * 1000)


def _forward_surface_response(surface: Any) -> GexForwardSurfaceResponse:
    meta = surface.meta if isinstance(surface.meta, dict) else {}
    return GexForwardSurfaceResponse(
        times=list(surface.times_ms),
        prices=list(surface.prices),
        values=[list(col) for col in surface.values],
        spot=float(surface.spot) if math.isfinite(float(surface.spot)) else 0.0,
        settle_ms=int(surface.settle_ms),
        as_of_ms=int(surface.as_of_ms),
        expiry=str(surface.expiry or ""),
        meta=GexForwardSurfaceMeta(
            version=str(meta.get("version") or FORWARD_SURFACE_VERSION),
            methodology=str(meta.get("methodology") or ""),
            note=str(meta.get("note") or ""),
            leg_count=int(meta.get("leg_count") or 0),
            n_times=int(meta.get("n_times") or 0),
            n_prices=int(meta.get("n_prices") or 0),
            price_window_pct=_optional_float(meta.get("price_window_pct")),
            tau0_years=_optional_float(meta.get("tau0_years")),
            tau0_hours=_optional_float(meta.get("tau0_hours")),
            metric=str(meta.get("metric") or "gamma"),
            unit=str(meta.get("unit") or "USD / 1% move"),
            iv_shift=float(meta.get("iv_shift") or 0.0),
            reference_iv=_optional_float(meta.get("reference_iv")),
            settlement_strike=_optional_float(meta.get("settlement_strike")),
            positioning_source="flow",
            position_recovery=str(meta.get("position_recovery") or "unavailable"),
            direct_position_leg_count=int(meta.get("direct_position_leg_count") or 0),
            reference_gex_coverage=float(meta.get("reference_gex_coverage") or 0.0),
            expiry_scope=str(meta.get("expiry_scope") or "0dte"),
        ),
    )


def _optional_float(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _heatmap_cells_from_by_strike(by_strike: Any) -> list[GexHeatmapCell]:
    """Map history by_strike dict/list → sorted strike cells (non-zero net only)."""
    parsed: dict[float, float] = {}
    if isinstance(by_strike, dict):
        for key, value in by_strike.items():
            try:
                strike = float(key)
                net = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(strike) and math.isfinite(net) and abs(net) > 0.0:
                parsed[strike] = parsed.get(strike, 0.0) + net
    elif isinstance(by_strike, list):
        for item in by_strike:
            try:
                if isinstance(item, dict):
                    strike = float(item["strike"])
                    net = float(item.get("net_gex", item.get("netGex", 0.0)))
                elif isinstance(item, (list, tuple)) and len(item) >= 2:
                    strike = float(item[0])
                    net = float(item[1])
                else:
                    continue
            except (TypeError, ValueError, KeyError):
                continue
            if math.isfinite(strike) and math.isfinite(net) and abs(net) > 0.0:
                parsed[strike] = parsed.get(strike, 0.0) + net

    return [
        GexHeatmapCell(strike=strike, net_gex=net)
        for strike, net in sorted(parsed.items())
    ]


def _downsample_evenly(items: list[Any], max_count: int) -> list[Any]:
    """Keep first/last and evenly spaced middle samples."""
    n = len(items)
    if max_count <= 0 or n <= max_count:
        return items
    if max_count == 1:
        return [items[-1]]
    # Always keep endpoints; fill remaining slots evenly.
    out: list[Any] = []
    last_idx = -1
    for i in range(max_count):
        idx = int(round(i * (n - 1) / (max_count - 1)))
        if idx == last_idx:
            continue
        out.append(items[idx])
        last_idx = idx
    return out
