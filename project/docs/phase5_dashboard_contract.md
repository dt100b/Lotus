# Phase 5 Dashboard Contract

Current contract version: `phase5.dashboard.v2`.

Phase 5 is a presentation-only layer for validated BTC gamma exposure outputs.
It does not reconstruct trades, replay inventory, or recompute dealer methodology.
Those responsibilities remain upstream in `collector/`, `normalizer/`, `ledger/`, and `greeks/`.

Continuous snapshot refresh and the production live terminal path are **Phase 6**
(`project/docs/phase6_live_ops.md`). Phase 6 reuses this contract without
changing field semantics.

## Boundary

- Input to Phase 5 is a single validated snapshot file.
- Phase 5 may filter and aggregate that snapshot for display.
- Phase 5 may not infer inventory, derive gamma from raw trades, or introduce alternate methodology rules.
- Phase 5 v1 is BTC-only and expects only listed single-leg options that were already filtered upstream.

## Snapshot Input Schema

The dashboard reads one JSON document with this exact shape:

```json
{
  "as_of": "2026-04-25T21:45:00Z",
  "underlying": "BTC",
  "spot_price": 94750.25,
  "rows": [
    {
      "expiry": "2026-05-01",
      "strike": 90000,
      "net_gex": 12.4,
      "call_gex": 18.7,
      "put_gex": -6.3
    }
  ],
}
```

`rows` is required and is always the production (blocks/combos excluded) profile.
Optional archived fields `rows_include_otc` / `include_otc_prints_available` may
appear if dual materialize was re-enabled; they are not used by the live desk
(see `project/docs/archived_include_otc_prints.md`).

## Field Semantics

- `as_of`: ISO-8601 timestamp for the validated snapshot time.
- `underlying`: must be `"BTC"` in Phase 5 v1.
- `spot_price`: BTC spot used by the validated upstream snapshot.
- `rows[].expiry`: expiry label exposed to the dashboard filter. Phase 5 treats it as an opaque string.
- `rows[].strike`: numeric strike bucket.
- `rows[].call_gex`: signed call exposure from the validated snapshot.
- `rows[].put_gex`: signed put exposure from the validated snapshot.
- `rows[].net_gex`: signed net exposure and must equal `call_gex + put_gex`.

Signed values are preserved as-is from upstream. Phase 5 does not flip put signs, normalize magnitudes, or reinterpret exposure direction.

## API Endpoints

### `GET /api/v1/health`

Returns repository status for the current snapshot:

- `status`
- `underlying`
- `as_of`
- `spot_price`
- `row_count`
- `snapshot_age_seconds`
- `freshness_threshold_seconds`
- `is_fresh`
- `contract_version`
- `snapshot_provenance`

Returns `503` if the snapshot file is missing and `500` if the snapshot is malformed.
`is_fresh` is an observability signal only and is computed from snapshot age versus the configured dashboard refresh threshold. It does not change methodology behavior.
When `is_fresh` is `false`, the dashboard remains read-only, continues rendering the loaded snapshot values as-is, and visibly marks the view as stale rather than suppressing or mutating the data.

### `GET /api/v1/config`

Returns presentation defaults only:

- `app_name`
- `refresh_seconds`
- `contract_version`
- `default_expiry`
- `default_view`
- `supported_views`

This endpoint must not expose methodology controls or upstream replay settings.

### `GET /api/v1/expiries`

Returns:

- `as_of`
- `underlying`
- `spot_price`
- `expiries`

`expiries` is the sorted unique expiry list present in the snapshot rows.

### `GET /api/v1/gex-profile`

Query parameters:

- `expiry`: `"ALL"` or one expiry present in the snapshot
- `view`: `net`, `call`, or `put`
- `include_otc_prints`: `false` (default) or `true` — **archived secondary path**;
  see `project/docs/archived_include_otc_prints.md`. Live desk does not use this.

Response fields:

- `as_of`
- `underlying`
- `spot_price`
- `selected_expiry`
- `view`
- `expiries`
- `points`
- `ledger_policy`: always `"exclude_otc_prints"` for the live default
- `include_otc_prints_available`: whether an archived secondary profile is present

Each item in `points` contains:

- `strike`
- `net_gex`
- `call_gex`
- `put_gex`
- `value`

`value` is the selected display series for the requested `view`.
For `expiry=ALL`, Phase 5 aggregates snapshot rows by strike across expiries.

### `GET /api/v1/terminal-snapshot`

Returns the enriched terminal-ready snapshot used by the Vite frontend. This is
an additive v2 API over the v1 profile endpoints.

Top-level fields include:

- `as_of_utc`, `symbol`, `expiry`, `expiries`, and `spot` (materialize GEX spot)
- `live_index`: live Deribit `btc_usd` when reachable (null otherwise). Shared
  by Price panel Index, chart spot lines, and trading DIST %; charts fall back
  to `spot` when null. GEX bar heights / Flip level still use materialize data.
- `gamma_bars` with signed net/call/put GEX by strike (production, blocks/combos excluded)
- `market_sources` with live Deribit `btc_usd` settlement index (serve-time,
  short cache) and, when reachable, the cached Hyperliquid BTC perp mid plus
  live basis (`HL_mid − Deribit_btc_usd_index`). Snapshot `spot` / GEX
  `spot_price` is not used for Index or basis.
- `levels` with backend-derived all-expiry, 0DTE, and reference level metadata
- `rankings` for all-expiry, selected-expiry, and 0DTE top strikes
- `expiry_events` for the compact `OPEX` panel

Archived optional fields (`gamma_bars_include_otc`, `include_otc_prints_available`)
are documented in `project/docs/archived_include_otc_prints.md` and are not used
by the live terminal UI.

Level semantics (taker-flow net GEX peaks + independent reference metrics):

- `Positive Gamma`: strike with most positive `net_gex` (`argmax`).
- `Negative Gamma`: strike with most negative `net_gex` (`argmin`).
- Same two fields under `zero_dte`, computed only on the front/0DTE surface.
- `Gamma Flip` (under `reference`): mass-valid cumulative net-GEX zero-cross (low→high),
  linear interpolation between strikes, nearest to spot among valid crosses (tie → larger
  mass). Mass filter: |prev_cum| + |next_cum| ≥ 1.5% of Σ|net_gex|. Eligibility window:
  |level − spot| / spot ≤ 0.15 (±15%); far mass-valid crosses are discarded. When no
  mass-valid in-window cross: value is `—`, `status` is `no_cross`, and top-level
  `gamma_flip` / `zero_gamma` are null (`gamma_flip_status: "no_cross"`). Never invent
  Flip from flattest |net_gex| or an out-of-window cross. Empty-state copy is carried on
  `gamma_flip_note` (and reference `note`) with locked strings:
  `No local flip · GEX one-sided`, optionally suffixed `(short)` / `(long)` from clean
  local-book net GEX sign inside the ±15% window (else neutral). (Regime profile corridor
  is a separate display-only band at spot ± 8%.)
- `Max Pain` (under `reference`): OI-weighted payoff-minimization strike (OI-derived).
- `Expected Move` (under `reference`): one-standard-deviation range from spot, IV, and
  time to front expiry — independent of the GEX model.

Signed call/put GEX are **not** flipped in the presentation layer. Each leg follows
dealer inventory sign from cumulative taker flow.

The frontend treats this endpoint as authoritative and does not recompute
methodology from raw trades.

## Validation Rules

The repository rejects snapshots that violate the Phase 5 contract, including:

- missing top-level keys
- non-BTC underlyings
- non-numeric `spot_price`
- non-list `rows`
- missing row keys
- non-numeric row values
- rows where `net_gex != call_gex + put_gex`
- truncated or otherwise invalid JSON payloads

These failures surface as `500` responses from the API so the dashboard never silently visualizes invalid state.
