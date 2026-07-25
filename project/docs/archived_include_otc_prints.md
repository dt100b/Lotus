# Archived: Include OTC Prints (secondary net GEX mode)

**Status:** archived / dormant (not on the live dashboard)  
**Archived:** 2026-07-20  
**Reason:** exploratory comparison only; not needed in current production desk UI.

This feature dual-computed a secondary net GEX by strike that **includes** Deribit
block and combo (OTC) prints, while leaving the production ledger (blocks + combos
excluded) untouched. It was removed from the terminal UI so the desk stays
production-only; code is kept for a possible future re-enable.

## What production still does (unchanged)

- `LedgerPolicy` defaults: `exclude_block_trades=True`, `exclude_combo_trades=True`,
  `require_single_leg=True`
- Phase 5 `rows` / terminal `gamma_bars` are always that production profile
- Inventory checkpoint / `inventory_snapshot.csv` are production-only

## Archived pieces (still in tree)

| Layer | Location | Notes |
|-------|----------|--------|
| Policy helpers | `ledger/rules.py` → `include_otc_ledger_policy()`, `INCLUDE_OTC_LEDGER_METHODOLOGY_VERSION` | Safe to import anytime |
| Dual materialize | `pipeline/dashboard_snapshot.py` | **Off by default** (`enable_include_otc_secondary=False`) |
| Checkpoint/CSV names | `pipeline/inventory_checkpoint.py` → `include_otc_*` paths | `*_with_blocks` filenames |
| API | `GET /api/v1/gex-profile?include_otc_prints=true` | Works only if snapshot has `rows_include_otc` |
| Terminal snapshot | optional `gamma_bars_include_otc` | Served when present on Phase 5 JSON |
| FE types / mapping | `liveTerminal.ts`, `mockTerminal.ts` | Optional fields still parsed if present |
| FE chart palette | `GexProfileChart` `colorPalette='include_otc'`, `.gex-palette-otc` in `index.css` | Purple/amber vs green/red |
| FE chrome control | `frontend/src/components/terminal/archived/includeOtcPrints.tsx` | Not mounted in the desk |

## How to re-enable later

### 1. Materialize secondary profile

```powershell
python project/scripts/materialize_dashboard_snapshot.py `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json `
  --mode full `
  --lightweight `
  --include-otc-secondary
```

Or from code:

```python
materialize_dashboard_snapshot(..., enable_include_otc_secondary=True)
```

Full mode seeds `inventory_checkpoint_with_blocks.json`. Incremental only advances
the OTC book when that checkpoint already exists.

### 2. Wire the UI toggle again

1. Import `OtcPrintsSelect` from `@/components/terminal/archived/includeOtcPrints`.
2. Restore per-pane `includeOtcPrints` on `PaneCellState` (see git history or the
   archived component module header).
3. In `WorkspacePaneCell`, when `includeOtcPrints && snapshot.gammaBarsIncludeOtc`:
   - feed those bars into `GexProfileChart`
   - set `colorPalette="include_otc"`
4. Remount the select in chart chrome for `net` / `profile` modes only.

### 3. Verify

- `GET /api/v1/gex-profile?include_otc_prints=true` returns non-production nets
- Terminal snapshot includes `gamma_bars_include_otc` and `include_otc_prints_available: true`
- Default path (`include_otc_prints=false` / no toggle) still matches production GEX

## Constraints (do not regress)

- Never overwrite production inventory, checkpoint, or default GEX artifacts
- Secondary path must stay clearly separated (`*_with_blocks`, `rows_include_otc`)
- Same GEX formula: position γ × S² × 0.01; only inventory policy differs
