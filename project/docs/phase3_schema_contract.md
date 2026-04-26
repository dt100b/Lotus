# Phase 3 Schema Contract (v1)

This document freezes the Phase 3 ledger contract for normalized inputs and
derived outputs. It is the compatibility boundary between Phase 2 normalization
and Phase 3 replay/materialization.

## Scope

- Venue scope: Deribit only.
- Asset scope: BTC only.
- Product scope: listed single-leg options for derived v1 calculations.
- Exclusions in derived v1: combo and block trades are excluded from dealer
  position application, but remain represented in `position_deltas` as
  auditable, non-applied events.

## Input Contract: Normalized Event JSON

Required keys (must be present):

- `event_id` (string)
- `trade_seq` (int)
- `ts_ms` (int)
- `base_currency` (string)
- `instrument_name` (string)
- `option_type` (string)
- `strike` (decimal-like string/number)
- `expiry_ts_ms` (int)
- `amount` (decimal-like string/number)
- `price` (decimal-like string/number)
- `taker_side` (string: `buy` or `sell` for v1 eligibility)

Optional keys with defaults at ingest:

- `source_trade_id` -> defaults to `event_id`
- `venue` -> defaults to `deribit`
- `kind` -> defaults to `option`
- `contract_size` -> defaults to `1`
- `is_block_trade` -> defaults to `false`
- `is_combo_trade` -> defaults to `false`
- `is_single_leg` -> defaults to `true`
- `normalization_version` -> defaults to `phase2.v1`

Malformed events (missing required keys or invalid numeric coercion) are rejected
at model construction.

## Replay Ordering Contract

Replay order is deterministic and computed by:

1. `trade_seq` ascending
2. `ts_ms` ascending
3. `event_id` ascending

This ordering applies regardless of source file order.

## Output Contract: `position_deltas.jsonl`

One line per input event (including excluded events) with keys:

- `event_id`
- `source_trade_id`
- `trade_seq`
- `ts_ms`
- `instrument_name`
- `taker_side`
- `dealer_position_delta` (decimal string)
- `dealer_position_after` (decimal string)
- `applied` (bool)
- `exclusion_reason` (string or null)
- `normalization_version`
- `methodology_version`

Interpretation:

- Dealer mirror rule: taker `buy` => dealer delta `-amount`;
  taker `sell` => dealer delta `+amount`.
- Excluded events have `applied=false`, delta `0`, and a non-null
  `exclusion_reason`.

## Output Contract: `dealer_inventory_snapshots.jsonl`

Each line contains:

- `snapshot_id`
- `ts_ms`
- `last_trade_seq`
- `positions` (map instrument -> decimal string)
- `methodology_version`

Behavior:

- Includes a genesis snapshot (`snapshot_id=genesis`, `last_trade_seq=-1`).
- Includes periodic snapshots every `snapshot_every` applied events.
- Includes a final snapshot if last emitted snapshot does not match final
  replay trade sequence.
- Dust positions near zero are pruned by the configured epsilon in replay code.

## Output Contract: `ledger_manifest.json`

Required keys:

- `methodology_version`
- `input_event_count`
- `applied_event_count`
- `excluded_event_count`
- `position_delta_count`
- `snapshot_count`
- `final_trade_seq`
- `final_nonzero_position_count`
- `position_deltas_sha256`
- `snapshots_sha256`

Hash semantics:

- `position_deltas_sha256` and `snapshots_sha256` are canonical content hashes.
- Canonical payload is computed as newline-joined JSON objects with sorted keys
  and compact separators `(",", ":")`.
- Hashes are SHA256 over UTF-8 encoded canonical payload.

## Versioning Contract

- Input lineage: each delta records `normalization_version`.
- Methodology lineage: all derived outputs record `methodology_version`.
- Any breaking change to rules, ordering, or output schema requires a new
  methodology version.
