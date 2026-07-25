from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
import json
import math

import httpx

from .schemas import (
    ExpiryListResponse,
    GexHeatmapCell,
    GexHeatmapSample,
    GexHeatmapSurfaceMeta,
    GexHeatmapSurfaceResponse,
    GexPoint,
    GexProfileResponse,
    HealthResponse,
)
from pipeline.flow_regime import (
    HISTORY_RETENTION_MS,
    HISTORY_VERSION,
    load_history_doc,
)
from pipeline.vol_compare import (
    DEFAULT_WINDOW as VOL_COMPARE_DEFAULT_WINDOW,
    RV_LOOKBACK_RETURNS,
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

# Live BTC settlement index for Price panel Index/basis (not GEX snapshot spot).
DERIBIT_BTC_USD_INDEX = "btc_usd"
DERIBIT_BTC_USD_INDEX_CACHE_SECONDS = 10
_deribit_btc_usd_index_cache: tuple[datetime, float] | None = None

# Realized-vol trend (short vs longer window) for Regime confirmation.
RV_TREND_CACHE_SECONDS = 60
_rv_trend_cache: tuple[datetime, dict[str, Any]] | None = None

# DVOL vs RV time series for Regime vol-compare mini chart (not every UI poll).
VOL_COMPARE_CACHE_SECONDS = 90
_vol_compare_cache: tuple[datetime, dict[str, Any]] | None = None
# Mass filter for Gamma Flip cumulative zero-crossings.
# Softened from 2.0% → 1.5% of Σ|net_gex| to reduce cliff risk near the old
# hard threshold. A crossing is kept only when |prev_cum| + |next_cum| at the
# step is ≥ max(this fraction × Σ|net_gex|, tiny epsilon). Crosses that fail
# are discarded permanently — never resurrected as Flip via flattest-bar fallback.
GAMMA_FLIP_MIN_MASS_FRACTION = 0.015  # 1.5%
# Near-spot eligibility window for Gamma Flip. A mass-valid cumulative zero-cross
# is only published when |level − spot| / spot ≤ this fraction. Far crosses
# (e.g. deep wing zeros on a one-sided near-spot book) yield no_cross — never
# fall back to flattest |net_gex| or an out-of-window cross.
# Separate from the Regime profile corridor (display-only, spot ± 8%).
GAMMA_FLIP_MAX_DISTANCE_FRAC = 0.15  # ±15% of spot
# Clean polarity for empty-state copy when Flip is unavailable.
# |net| / Σ|net| of strikes inside the eligibility window (fallback: full book)
# must meet this fraction before suffixing (short)/(long); otherwise neutral.
GAMMA_FLIP_ONE_SIDED_MIN_FRAC = 0.05
# Locked empty-state copy (Regime headline subline + optional API note).
GAMMA_FLIP_EMPTY_NEUTRAL = "No local flip · GEX one-sided"
GAMMA_FLIP_EMPTY_SHORT = "No local flip · GEX one-sided (short)"
GAMMA_FLIP_EMPTY_LONG = "No local flip · GEX one-sided (long)"


class SnapshotRepository:
    def __init__(self, snapshot_path: Path, artifacts_dir: Path | None = None):
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
        # Live Deribit btc_usd for Price Index, chart spot lines, and DIST %.
        # GEX bars / Flip / EM methodology stay on materialize ``spot``.
        live_index = _fetch_deribit_btc_usd_index()
        display_spot = float(live_index) if live_index is not None else spot
        all_rows = _aggregate_rows(payload["rows"])
        selected_rows = all_rows if selected_expiry == "ALL" else _aggregate_rows(
            [row for row in payload["rows"] if str(row["expiry"]) == selected_expiry]
        )
        front_expiry = expiries[0] if expiries else selected_expiry
        front_rows = _aggregate_rows([row for row in payload["rows"] if str(row["expiry"]) == front_expiry])
        # Level peaks from GEX surface; distance labels vs display_spot (live index).
        all_levels = _build_all_expiry_levels(all_rows, display_spot)
        zero_dte_levels = _build_zero_dte_levels(front_rows, display_spot)
        weekly_levels = _build_kind_levels(payload["rows"], display_spot, kind="weekly")
        monthly_levels = _build_kind_levels(payload["rows"], display_spot, kind="monthly")
        quarterly_levels = _build_kind_levels(payload["rows"], display_spot, kind="quarterly")
        # Single shared Gamma Flip estimate (ALL-expiry net_gex).
        # Null when no mass-valid cross inside spot ± 15% eligibility window.
        # Eligibility window uses materialize spot (GEX methodology), not live index.
        gamma_flip, gamma_flip_status = _estimate_gamma_flip(all_rows, spot=spot)
        gamma_flip_note = _gamma_flip_empty_note(
            all_rows,
            spot=spot,
            status=gamma_flip_status,
        )
        reference_levels = _build_reference_levels(
            all_rows,
            payload["rows"],
            spot,
            front_expiry,
            gamma_flip=gamma_flip,
            gamma_flip_status=gamma_flip_status,
            gamma_flip_note=gamma_flip_note,
            distance_spot=display_spot,
        )

        otc_source = payload.get("rows_include_otc")
        otc_available = isinstance(otc_source, list) and len(otc_source) > 0
        gamma_bars_include_otc = None
        if otc_available:
            otc_selected = (
                _aggregate_rows(otc_source)
                if selected_expiry == "ALL"
                else _aggregate_rows(
                    [row for row in otc_source if str(row["expiry"]) == selected_expiry]
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
            # Gamma Flip: real cumulative zero-cross only. null + no_cross when absent.
            # zero_gamma is a legacy alias of gamma_flip (same nullability).
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
    - Expanding ≥ 1.12, Compressing ≤ 0.88, else Neutral

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
    if ratio >= 1.12:
        label = "Expanding"
    elif ratio <= 0.88:
        label = "Compressing"
    else:
        label = "Neutral"

    return {
        "rv_ratio": round(ratio, 4),
        "rv_trend": label,
        "rv_short": round(short_rv * 100, 2),  # percent units
        "rv_long": round(long_rv * 100, 2),
    }


def _sample_stdev(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    variance = sum((value - mean) ** 2 for value in values) / (n - 1)
    return math.sqrt(max(variance, 0.0))


def _fetch_vol_compare(*, window: str = VOL_COMPARE_DEFAULT_WINDOW) -> dict[str, Any]:
    """DVOL history + aligned RV + spread for Regime vol-compare chart.

    Cached (~90s). On Deribit/HL failure, returns last good payload when available,
    otherwise an empty series shape — never raises into the terminal snapshot path.
    """
    global _vol_compare_cache

    win = window if window in VOL_COMPARE_WINDOW_MS else VOL_COMPARE_DEFAULT_WINDOW
    now = datetime.now(UTC)
    if (
        _vol_compare_cache is not None
        and (now - _vol_compare_cache[0]).total_seconds() <= VOL_COMPARE_CACHE_SECONDS
    ):
        return _vol_compare_cache[1]

    as_of_ms = int(now.timestamp() * 1000)
    window_ms = VOL_COMPARE_WINDOW_MS[win]
    # Extra day buffer for sparse candles / clock skew.
    dvol_start_ms = as_of_ms - window_ms - 86_400_000
    # RV needs lookback_returns of 1h bars before the window starts.
    hl_start_ms = as_of_ms - window_ms - (RV_LOOKBACK_RETURNS + 24) * 3_600_000

    try:
        dvol_candles = _fetch_deribit_dvol_history(
            start_ms=dvol_start_ms,
            end_ms=as_of_ms,
            resolution="3600",
        )
        hl_candles = _fetch_hyperliquid_btc_1h_closes(
            start_ms=hl_start_ms,
            end_ms=as_of_ms,
        )
        if not dvol_candles:
            raise ValueError("empty DVOL history")

        window_start_ms = as_of_ms - window_ms
        payload = assemble_vol_compare(
            dvol_raw_candles=dvol_candles,
            hl_candles=hl_candles,
            as_of_ms=as_of_ms,
            window=win,
            window_start_ms=window_start_ms,
        )
        if not payload.get("dvol_series"):
            raise ValueError("DVOL series empty after parse")
    except Exception as exc:  # noqa: BLE001 — never break Regime serve path
        if _vol_compare_cache is not None:
            return _vol_compare_cache[1]
        return empty_vol_compare_payload(
            as_of_ms=as_of_ms,
            window=win,
            error=str(exc)[:240],
        )

    _vol_compare_cache = (now, payload)
    return payload


def _fetch_deribit_dvol_history(
    *,
    start_ms: int,
    end_ms: int,
    resolution: str = "3600",
) -> list[Any]:
    """Deribit BTC volatility index candles (OHLC; close is DVOL level)."""
    response = httpx.get(
        f"{DERIBIT_API_BASE}/public/get_volatility_index_data",
        params={
            "currency": "BTC",
            "start_timestamp": int(start_ms),
            "end_timestamp": int(end_ms),
            "resolution": str(resolution),
        },
        timeout=4.0,
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
    """BTC 1h candle closes from Hyperliquid (same source as RV Trend)."""
    response = httpx.post(
        HYPERLIQUID_INFO_URL,
        json={
            "type": "candleSnapshot",
            "req": {
                "coin": "BTC",
                "interval": "1h",
                "startTime": int(start_ms),
                "endTime": int(end_ms),
            },
        },
        headers={"Content-Type": "application/json"},
        timeout=4.0,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        return []

    out: list[tuple[int, float]] = []
    for row in payload:
        ts_ms = _hyperliquid_candle_ts(row)
        close = _hyperliquid_candle_close(row)
        if ts_ms is None or close is None or close <= 0:
            continue
        out.append((ts_ms, close))
    out.sort(key=lambda p: p[0])
    return out


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
        "open_interest": row.get("open_interest", 0.0),
        "call_open_interest": row.get("call_open_interest", 0.0),
        "put_open_interest": row.get("put_open_interest", 0.0),
        "mark_iv": row.get("mark_iv", 0.0),
    }


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


def _build_reference_levels(
    all_rows: list[dict[str, float]],
    source_rows: list[dict[str, Any]],
    spot: float,
    front_expiry: str,
    *,
    gamma_flip: float | None = None,
    gamma_flip_status: str | None = None,
    gamma_flip_note: str | None = None,
    distance_spot: float | None = None,
) -> list[dict[str, Any]]:
    """Reference metrics for the terminal Levels desk.

    - Gamma Flip: shared cumulative net_gex zero-cross inside spot ± 15%
      (see `_estimate_gamma_flip`). Same definition as terminal gamma_flip /
      zero_gamma and Regime Flip. Value is "—" when status is no_cross
      (never a fake flattest-bar level or a far out-of-window cross).
      Optional `note` carries locked empty-state copy (one-sided short/long).
    - Max Pain: OI-based settlement strike (minimizes call+put extrinsic payout).
    - Expected Move: vol-based 1σ band from front-expiry IV — independent of GEX.

    ``spot`` is materialize GEX spot (Flip eligibility + Expected Move band).
    ``distance_spot`` (default ``spot``) is the trading reference for Flip DIST %
    — live Deribit index when available.
    """
    dist_ref = float(distance_spot) if distance_spot is not None else spot
    if gamma_flip_status is None:
        # Callers that only pass rows (tests / older paths) recompute once here.
        gamma_flip, gamma_flip_status = _estimate_gamma_flip(all_rows, spot=spot)
    if gamma_flip_note is None and gamma_flip_status == "no_cross":
        gamma_flip_note = _gamma_flip_empty_note(
            all_rows, spot=spot, status=gamma_flip_status
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
    flip_metric: dict[str, Any] = {
        "label": "Gamma Flip",
        "value": flip_value,
        "change": flip_change,
        "color": "#d0bc62",
        "scope": "book",
        "scope_label": "ALL",
        "status": gamma_flip_status,
    }
    if gamma_flip_note:
        flip_metric["note"] = gamma_flip_note
    return [
        flip_metric,
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
    Gamma Flip from the ALL-expiry net GEX profile (flow, not OI).

    Shared definition used by:
      - levels.reference → Gamma Flip
      - terminal gamma_flip / zero_gamma (Regime distance / profile marker)
      - any consumer of Flip on the map

    Algorithm:
      1. Walk strikes low → high; accumulate net_gex.
      2. Detect zero-crossings of the *cumulative* series only
         (linear interpolation between adjacent cumulative sums).
         True cumulative zeros at a strike are included; raw local
         adjacent-bar sign changes and exact-zero bars that are not
         cumulative zeros are ignored.
      3. Keep crossings with meaningful mass on both sides of the step:
         |prev_cum| + |next_cum| ≥ max(GAMMA_FLIP_MIN_MASS_FRACTION × Σ|net_gex|,
         tiny epsilon). Constant is 1.5% (softened from 2.0%).
      4. Eligibility window: only crosses with
         |level − spot| / spot ≤ GAMMA_FLIP_MAX_DISTANCE_FRAC (0.15, ±15%).
         Far mass-valid crosses are discarded (same empty state as no cross).
      5. Among eligible crossings, pick the one nearest to spot
         (tie-break: larger mass).
      6. If none: return (None, "no_cross"). Never invent Flip from flattest
         |net_gex|, a far out-of-window cross, or any non-zero bar.

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
    total_abs = sum(abs(float(row["net_gex"])) for row in sorted_rows)
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

    # Near-spot eligibility: discard mass-valid crosses outside spot ± 15%.
    if ref > 0:
        max_dist = ref * GAMMA_FLIP_MAX_DISTANCE_FRAC
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
