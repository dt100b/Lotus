# Archived: heatmap pane header chrome

**Archived:** 2026-07-23  
**Reason:** Phase A of heatmap rebuild — focus on a coherent Hyperliquid 15m OHLC chart only. Surface + chrome come back later.

## What was removed from the heatmap mode shell

- Pane title accessory row: expiry select, heatmap palette, mode select (for this pane path)
- In-chart OHLC interval toggles (5m / 15m / 30m / 1h)
- OHLC show/hide, Auto-fit button
- GEX surface sample legend / hover strike cards (surface disabled)

## Restore later

- Wire `titleAccessory` / `ChartControls` back in `WorkspacePaneCell` for `mode === 'heatmap'`
- Re-enable surface underlay only after OHLC density + default view are trusted
- Interval selector only if multi-TF is required; Phase A is **15m locked**

## Phase A contract

- Feed: Hyperliquid BTC-PERP `candleSnapshot` + live WS
- Interval: **15m only**
- History buffer: **90 days**
- Default visible window: **7 days** (pan left into full buffer)
