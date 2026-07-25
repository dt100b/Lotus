/**
 * Shared hover readout for GEX desk charts (strike / profile / walls / …).
 * Positive + Negative GEX compose Net — not call/put decomposition.
 */

import type { ReactNode } from 'react'
import { formatMillions, formatStrike } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { splitPositiveNegativeGex } from '@/data/gexChartColors'

export type GexHoverSide = 'left' | 'right'

export type GexHoverCardModel = {
  strike: number
  netGexUsd: number
  /** Optional raw legs — split into +/− for display. */
  callGexUsd?: number
  putGexUsd?: number
  /** Pre-split legs when already available. */
  positiveGexUsd?: number
  negativeGexUsd?: number
  /** Extra metric rows (OI, dist, etc.). */
  extras?: Array<{ label: string; value: string; tone?: 'muted' | 'pos' | 'neg' | 'neutral' }>
}

type GexHoverCardProps = {
  model: GexHoverCardModel
  side: GexHoverSide
  xPct: number
  yPct: number
  className?: string
}

export function GexHoverCard({ model, side, xPct, yPct, className }: GexHoverCardProps) {
  return (
    <div
      className={cn('gex-hover-card', className)}
      style={{
        left: `${xPct}%`,
        top: `${yPct}%`,
        transform: side === 'left'
          ? 'translate(calc(-100% - 12px), -50%)'
          : 'translate(12px, -50%)',
      }}
      role="status"
      aria-live="polite"
    >
      <GexHoverCardBody model={model} />
    </div>
  )
}

export function GexHoverCardBody({ model }: { model: GexHoverCardModel }) {
  const split = resolveSplit(model)
  const net = split.netGexUsd
  const netPos = net >= 0

  return (
    <>
      <div className="gex-hover-card__head">
        <div className="gex-hover-card__kicker">
          <span className="gex-hover-card__strike-label">Strike</span>
        </div>
        <div className="gex-hover-card__strike">${formatStrike(model.strike)}</div>
      </div>

      <div className="gex-hover-card__rule" />

      <div className="gex-hover-card__rows">
        <HoverRow
          label="Net GEX"
          value={formatMillions(net)}
          emphasis
          tone={netPos ? 'pos' : 'neg'}
        />
        <HoverRow
          label="Positive GEX"
          value={formatMillions(split.positiveGexUsd)}
          tone={split.positiveGexUsd > 0 ? 'pos' : 'muted'}
        />
        <HoverRow
          label="Negative GEX"
          value={formatMillions(split.negativeGexUsd)}
          tone={split.negativeGexUsd < 0 ? 'neg' : 'muted'}
        />
        {model.extras?.map((row) => (
          <HoverRow
            key={row.label}
            label={row.label}
            value={row.value}
            tone={row.tone ?? 'muted'}
          />
        ))}
      </div>
    </>
  )
}

function HoverRow({
  label,
  value,
  tone = 'neutral',
  emphasis = false,
}: {
  label: string
  value: string
  tone?: 'muted' | 'pos' | 'neg' | 'neutral'
  emphasis?: boolean
}) {
  return (
    <div className={cn('gex-hover-card__row', emphasis && 'gex-hover-card__row--net')}>
      <span className="gex-hover-card__label">{label}</span>
      <span
        className={cn(
          'gex-hover-card__value',
          tone === 'pos' && 'gex-hover-card__value--pos',
          tone === 'neg' && 'gex-hover-card__value--neg',
          tone === 'muted' && 'gex-hover-card__value--muted',
        )}
      >
        {value}
      </span>
    </div>
  )
}

function resolveSplit(model: GexHoverCardModel) {
  if (
    model.positiveGexUsd != null
    && model.negativeGexUsd != null
    && Number.isFinite(model.positiveGexUsd)
    && Number.isFinite(model.negativeGexUsd)
  ) {
    return {
      positiveGexUsd: model.positiveGexUsd,
      negativeGexUsd: model.negativeGexUsd,
      netGexUsd: model.netGexUsd,
    }
  }
  return splitPositiveNegativeGex(
    model.callGexUsd ?? 0,
    model.putGexUsd ?? 0,
    model.netGexUsd,
  )
}

/** Lightweight positioned shell when body is custom. */
export function GexHoverCardShell({
  side,
  xPct,
  yPct,
  children,
  className,
}: {
  side: GexHoverSide
  xPct: number
  yPct: number
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn('gex-hover-card', className)}
      style={{
        left: `${xPct}%`,
        top: `${yPct}%`,
        transform: side === 'left'
          ? 'translate(calc(-100% - 12px), -50%)'
          : 'translate(12px, -50%)',
      }}
    >
      {children}
    </div>
  )
}
