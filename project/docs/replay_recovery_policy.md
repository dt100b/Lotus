# Replay Recovery Policy (Phase 3.1)

This policy defines deterministic restart and downtime recovery for the Phase 3
dealer ledger.

## Goals

- Preserve replay determinism.
- Minimize restart cost using snapshots.
- Keep failure handling auditable and explicit.

## Source of Truth

- Raw and normalized streams remain upstream truth.
- Derived artifacts (`position_deltas`, snapshots, manifest) are rebuildable and
  disposable.

## Restart Procedure

1. Load latest valid snapshot by highest `last_trade_seq`.
2. Validate snapshot `methodology_version` matches the target run.
3. Resume replay from normalized events strictly greater than snapshot
   `last_trade_seq`.
4. Apply deterministic ordering (`trade_seq`, `ts_ms`, `event_id`) before
   application.
5. Re-emit deltas/snapshots/manifest for the resumed run.

If no snapshot exists, run full replay from the start of the normalized event
range.

## Snapshot Cadence

- Default cadence is policy-driven (`snapshot_every=10_000` applied events).
- Higher cadence reduces recovery time but increases write volume.
- Cadence changes do not alter ledger math but do alter snapshot artifacts; treat
  as configuration metadata for audit.

## Gap and Duplicate Handling

### Duplicates

- Duplicate `event_id` values within a replay window should be treated as input
  integrity violations.
- v1 recommendation: fail fast and require upstream normalization reconciliation.
- If future requirements permit deduplication, dedupe rules must be
  methodology-versioned.

### Gaps in `trade_seq`

- Gaps indicate incomplete source windows or transport loss.
- v1 recommendation: fail closed for production materialization jobs and mark run
  incomplete.
- For investigative/offline runs, gaps may be allowed only with explicit operator
  override and annotated manifest metadata.

## Reconciliation Strategy

- Daily/periodic reconciliation should re-run replay from an agreed checkpoint
  and compare:
  - canonical output hashes,
  - final positions,
  - counts in manifest.
- Any mismatch is a hard alert and requires root-cause analysis before outputs
  are promoted.

## Operational Invariants

- Same input set + same ordering + same methodology version => identical derived
  state and canonical hashes.
- Methodology changes require new `methodology_version` and side-by-side
  reproducibility checks.
