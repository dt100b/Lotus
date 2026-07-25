# Phase 1 Raw Schema Contract (Locked)

Status: locked for Phase 2 start  
Scope: raw ingestion only (`ingest_runs`, `backfill_jobs`, `backfill_cursors`, `raw_instruments`, `raw_trades`)  
Effective date: 2026-04-25

## Purpose

This contract freezes the Phase 1 raw schema and behavior so downstream normalization and analytics can rely on stable, auditable inputs.

The collector and backfill path are already validated; this document defines what must not drift.

## Contract Principles

1. **Raw payload immutability**: `payload_json` stores Deribit objects unchanged (no field rewriting or pruning).
2. **Idempotent append behavior**: deduplication occurs only on storage keys, not by transforming payloads.
3. **Durable resume**: cursor state is persisted at page boundaries so interrupted jobs can continue safely.
4. **Replayability**: all derived state in later phases must be reproducible from these raw tables.

## Canonical Tables

## `ingest_runs`

- **Primary key**: `run_id`
- **Columns**:
  - `run_id` (TEXT, PK)
  - `phase_name` (TEXT, required; Phase 1 value: `phase1_raw`)
  - `started_at_ms` (INTEGER, required)
  - `finished_at_ms` (INTEGER, nullable)
  - `window_start_ms` (INTEGER, required)
  - `window_end_ms` (INTEGER, required)
  - `status` (TEXT, required)
  - `summary_json` (TEXT, nullable)

`status` is an execution state (`running`, `completed`, `failed`, `failed_validation`).

## `backfill_jobs`

- **Primary key**: `job_name`
- **Columns**:
  - `job_name` (TEXT, PK; stable identity across reruns)
  - `created_at_ms` (INTEGER, required)
  - `updated_at_ms` (INTEGER, required)
  - `window_start_ms` (INTEGER, required)
  - `window_end_ms` (INTEGER, required)
  - `status` (TEXT, required)
  - `last_run_id` (TEXT, nullable)
  - `summary_json` (TEXT, nullable)

## `backfill_cursors`

- **Primary key**: (`job_name`, `chunk_start_ms`, `chunk_end_ms`, `trade_kind`)
- **Foreign key**: `job_name -> backfill_jobs.job_name`
- **Columns**:
  - `job_name` (TEXT, required)
  - `chunk_start_ms` (INTEGER, required)
  - `chunk_end_ms` (INTEGER, required)
  - `trade_kind` (TEXT, required; Phase 1 currently `option`)
  - `continuation` (TEXT, nullable)
  - `status` (TEXT, required)
  - `page_count` (INTEGER, required, default `0`)
  - `fetched_rows` (INTEGER, required, default `0`)
  - `updated_at_ms` (INTEGER, required)

Cursor row semantics:
- `status=running`: chunk has in-progress pagination; `continuation` points to next page token.
- `status=completed`: chunk fully consumed; `continuation` must be `NULL`.

## `raw_instruments`

- **Primary key**: `instrument_name`
- **Columns**:
  - `instrument_name` (TEXT, PK)
  - `collected_at_ms` (INTEGER, required)
  - `payload_json` (TEXT, required; immutable Deribit instrument object)

Upsert behavior is intentional for current instrument snapshot freshness.

## `raw_trades`

- **Primary key**: (`instrument_name`, `trade_id`)
- **Foreign key**: `source_run_id -> ingest_runs.run_id`
- **Columns**:
  - `instrument_name` (TEXT, required)
  - `trade_id` (TEXT, required)
  - `trade_seq` (INTEGER, nullable)
  - `timestamp_ms` (INTEGER, required)
  - `direction` (TEXT, nullable)
  - `block_trade_id` (TEXT, nullable)
  - `combo_trade_id` (TEXT, nullable)
  - `source_run_id` (TEXT, required)
  - `ingested_at_ms` (INTEGER, required)
  - `payload_json` (TEXT, required; immutable Deribit trade object)

Insert behavior is `INSERT OR IGNORE` on PK to enforce idempotency across retries/resumes.

## Locked Runtime Semantics

- Backfill uses Deribit trade paging (`public/get_last_trades_by_currency_and_time`) with `sorting=asc` and `include_old=true`.
- Deep historical backfill targets **`history.deribit.com`** by default; live/rolling appends and instrument sync use the main Deribit host.
- Resume unit is **(job_name, chunk_start_ms, chunk_end_ms, trade_kind)**.
- Page resume tokens may be either:
  - Native Deribit `continuation` strings (main host), or
  - Synthetic `ts:<next_start_ms>` tokens when the host returns `has_more` without `continuation` (history host timestamp advance).
- Each fetched page is committed before moving to the next resume token.
- Validation compares local key set vs remote key set in sampled windows (same trade host as backfill).

## Audit Invariants (Must Hold)

1. `duplicate_trade_groups == 0` where grouped by (`instrument_name`, `trade_id`).
2. For sampled validation windows:
   - `missing_count == 0`
   - `extra_count == 0`
3. Rerun with same `job_name` must not reinsert existing trade keys.

## Allowed vs Disallowed Changes (Before Phase 2)

Allowed:
- Additive indexes.
- Additive nullable columns with default `NULL`.
- Additive JSON keys inside `summary_json`.

Disallowed without explicit migration/version bump:
- Renaming/removing raw table columns.
- Changing PK/FK definitions.
- Altering `payload_json` content prior to persistence.
- Changing dedupe key from (`instrument_name`, `trade_id`).
- Changing cursor identity tuple.

## Versioning Rule

This is contract **v1**.  
Any disallowed change requires:
1. new contract version,
2. migration plan, and
3. replay/audit impact note.
