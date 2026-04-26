# Phase 5 Dashboard Contract

Phase 5 is a presentation-only layer for validated BTC gamma exposure outputs.
It does not reconstruct trades, replay inventory, or recompute dealer methodology.
Those responsibilities remain upstream in `collector/`, `normalizer/`, `ledger/`, and `greeks/`.

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
  ]
}
```

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

Response fields:

- `as_of`
- `underlying`
- `spot_price`
- `selected_expiry`
- `view`
- `expiries`
- `points`

Each item in `points` contains:

- `strike`
- `net_gex`
- `call_gex`
- `put_gex`
- `value`

`value` is the selected display series for the requested `view`.
For `expiry=ALL`, Phase 5 aggregates snapshot rows by strike across expiries.

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
