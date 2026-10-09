import {
  LineStyle,
  type IPriceLine,
  type ISeriesApi,
} from 'lightweight-charts'
import type { GexStrikeFocus } from '@/store/terminalStore'

export type LinkedStrikeLineHandle = {
  candles: ISeriesApi<'Candlestick'>
  linkedStrikeLines: Map<number, IPriceLine>
}

export type LinkedStrikeState = {
  hovered: GexStrikeFocus | null
  active: GexStrikeFocus | null
  marked: GexStrikeFocus[]
}

type LinkedStrikeStyle = 'hover' | 'active'

/** Synchronize transient, active, and multi-marked strike guides across a pane. */
export function syncLinkedStrikeLines(
  handle: LinkedStrikeLineHandle,
  state: LinkedStrikeState,
) {
  const desired = buildDesiredLines(state)

  for (const [strike, line] of handle.linkedStrikeLines) {
    if (desired.has(strike)) continue
    try {
      handle.candles.removePriceLine(line)
    } catch {
      // Chart teardown can win the race; nothing remains to clear.
    }
    handle.linkedStrikeLines.delete(strike)
  }

  for (const [strike, spec] of desired) {
    const options = lineOptions(spec.focus, spec.style)
    const existing = handle.linkedStrikeLines.get(strike)
    if (existing) {
      try {
        existing.applyOptions(options)
        continue
      } catch {
        handle.linkedStrikeLines.delete(strike)
      }
    }
    try {
      handle.linkedStrikeLines.set(strike, handle.candles.createPriceLine(options))
    } catch {
      // The owning chart may already be tearing down.
    }
  }
}

function buildDesiredLines(state: LinkedStrikeState) {
  const desired = new Map<number, { focus: GexStrikeFocus; style: LinkedStrikeStyle }>()

  for (const focus of state.marked) {
    if (validFocus(focus)) desired.set(focus.strike, { focus, style: 'active' })
  }
  if (validFocus(state.active)) {
    desired.set(state.active.strike, { focus: state.active, style: 'active' })
  }
  if (validFocus(state.hovered) && !desired.has(state.hovered.strike)) {
    desired.set(state.hovered.strike, { focus: state.hovered, style: 'hover' })
  }

  return desired
}

function lineOptions(focus: GexStrikeFocus, style: LinkedStrikeStyle) {
  const positive = focus.netGexUsd >= 0
  const isHover = style === 'hover'
  const isActive = style === 'active'
  const alpha = isHover ? 0.28 : isActive ? 0.72 : 0.56
  const baseColor = positive
    ? focus.positiveColor ?? 'rgb(101, 205, 190)'
    : focus.negativeColor ?? 'rgb(239, 108, 124)'
  const color = withAlpha(baseColor, alpha)

  return {
    price: focus.strike,
    color,
    lineWidth: (isActive ? 2 : 1) as 1 | 2,
    lineStyle: isHover ? LineStyle.Dotted : LineStyle.Solid,
    axisLabelVisible: !isHover,
    axisLabelColor: color,
    axisLabelTextColor: '#e8eef0',
    title: '',
  }
}

function withAlpha(color: string, alpha: number): string {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3)
  return channels?.length === 3
    ? `rgba(${channels.join(', ')}, ${alpha})`
    : color
}

function validFocus(focus: GexStrikeFocus | null): focus is GexStrikeFocus {
  return focus != null
    && focus.strike > 0
    && Number.isFinite(focus.strike)
    && Number.isFinite(focus.netGexUsd)
}
