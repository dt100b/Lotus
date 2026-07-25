# Archived: Regime Structure / NY Session polarity

**Status:** archived / dormant (not on the live REGIME desk)  
**Archived:** 2026-07-22  
**Reason:** simplified Regime hierarchy; vol chips + IV vs RV own the secondary zone.

UI block caption was **"Cumulative book vs flow since NY open"** — two display-only
meters (Structure vs NY Session) driven by `flow_regime.horizon`.

## What production still does (unchanged)

- Backend still computes / materializes `flow_regime.horizon` when present
- API + FE mapping (`fullScore`, `sessionScore`, …) remain intact
- No scoring formula was removed from the pipeline

## Archived pieces (still in tree)

| Layer | Location | Notes |
|-------|----------|--------|
| FE block + score helpers | `frontend/src/components/terminal/archived/RegimePolarityBlock.tsx` | Not imported by `RegimePanel` |
| FE CSS | `frontend/src/index.css` → `.regime-polarity*` | Marked ARCHIVED; safe to leave |
| CSS vars | `.regime-panel` → `--regime-polarity-*` | Dormant tokens |

## How to re-enable later

1. In `RegimePanel.tsx`, import from the archive:

```tsx
import {
  RegimePolarityBlock,
  getRegimePolarityScores,
} from '@/components/terminal/archived/RegimePolarityBlock'
```

2. Mount after vol chips, before `VolCompareZone`:

```tsx
const polarity = useMemo(() => getRegimePolarityScores(bookSnapshot), [bookSnapshot])
// …
<RegimeVolChips chips={volChips} />
<RegimePolarityBlock structure={polarity.structure} session={polarity.session} />
<VolCompareZone … />
```

3. Confirm `.regime-polarity*` CSS is still active (not deleted).

4. Revisit IV vs RV height budget — default desk pins the chart near the
   workspace bottom-row fraction (`38cqh`); polarity will need a few px back.
