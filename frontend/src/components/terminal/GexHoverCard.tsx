/**
 * Shared GEX desk readout — compact hover chip vs detailed pin card.
 * Positive + Negative GEX compose Net — not call/put decomposition.
 */

import type { ReactNode } from 'react'
import { formatMillions, formatStrike } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { splitPositiveNegativeGex } from '@/data/gexChartColors'

export type GexHoverSide = 'left' | 'right'

export type GexHoverCardVariant = 'compact' | 'detail'

export type GexHoverCardModel = {
  strike: number
  netGexUsd: number
  /** Exposure acronym used in the readout (GEX by default, DEX for Delta strike mode). */
  exposureLabel?: string
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
  /**
   * compact — minimal strike + net chip (pointer hover).
   * detail — full desk card (click / pin / keyboard).
   */
  variant?: GexHoverCardVariant
  /** Announce keyboard/pinned selection; pointer hover remains a quiet tooltip. */
  announce?: boolean
}

export function GexHoverCard({
  model,
  side,
  xPct,
  yPct,
  className,
  variant = 'detail',
  announce = true,
}: GexHoverCardProps) {
  const netTone = model.netGexUsd >= 0 ? 'pos' : model.netGexUsd < 0 ? 'neg' : 'flat'
  const offset = variant === 'compact' ? 8 : 12

  return (
    <div
      className={cn(
        'gex-hover-card',
        variant === 'compact' ? 'gex-hover-card--compact' : 'gex-hover-card--detail',
        netTone === 'pos' && 'gex-hover-card--net-pos',
        netTone === 'neg' && 'gex-hover-card--net-neg',
        className,
      )}
      style={{
        left: `${xPct}%`,
        top: `${yPct}%`,
        transform: side === 'left'
          ? `translate(calc(-100% - ${offset}px), -50%)`
          : `translate(${offset}px, -50%)`,
      }}
      role={announce ? 'status' : 'tooltip'}
      aria-live={announce ? 'polite' : undefined}
    >
      {variant === 'compact' ? (
        <GexHoverCardCompact model={model} />
      ) : (
        <GexHoverCardBody model={model} />
      )}
    </div>
  )
}

/** Minimal chip: strike + net only — keeps the ladder readable on hover. */
export function GexHoverCardCompact({ model }: { model: GexHoverCardModel }) {
  const net = model.netGexUsd
  const netPos = net > 0
  const netNeg = net < 0

  return (
    <div className="gex-hover-card__chip">
      <span className="gex-hover-card__chip-strike">${formatStrike(model.strike)}</span>
      <span className="gex-hover-card__chip-sep" aria-hidden />
      <span
        className={cn(
          'gex-hover-card__chip-net',
          netPos && 'gex-hover-card__value--pos',
          netNeg && 'gex-hover-card__value--neg',
          !netPos && !netNeg && 'gex-hover-card__value--muted',
        )}
      >
        {formatMillions(net)}
      </span>
    </div>
  )
}

export function GexHoverCardBody({ model }: { model: GexHoverCardModel }) {
  const split = resolveSplit(model)
  const net = split.netGexUsd
  const netPos = net >= 0

  return (
    <>
      <div className="gex-hover-card__accent" aria-hidden />
      <div className="gex-hover-card__body">
        <div className="gex-hover-card__head">
          <div className="gex-hover-card__kicker">Strike</div>
          <div className="gex-hover-card__strike">${formatStrike(model.strike)}</div>
        </div>

        <div className="gex-hover-card__rule" />

        <div className="gex-hover-card__rows">
          <HoverRow
            label={`Net ${model.exposureLabel ?? 'GEX'}`}
            value={formatMillions(net)}
            emphasis
            tone={netPos ? 'pos' : 'neg'}
          />
          <HoverRow
            label="Positive"
            value={formatMillions(split.positiveGexUsd)}
            tone={split.positiveGexUsd > 0 ? 'pos' : 'muted'}
          />
          <HoverRow
            label="Negative"
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
      className={cn('gex-hover-card gex-hover-card--detail', className)}
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
