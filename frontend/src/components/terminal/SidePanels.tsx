import { Copy } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { TerminalSnapshot } from '@/data/mockTerminal'
import { formatSignedPercent, formatStrike, formatUsd } from '@/lib/formatters'

type SidePanelsProps = {
  snapshot: TerminalSnapshot
}

export function SidePanels({ snapshot }: SidePanelsProps) {
  return (
    <aside className="terminal-panel terminal-rail grid content-start">
      <RailSection
        title="Price Sources"
        action={
          <Button size="compact" className="text-[#ff8a00]">
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>
        }
      >
        <div className="grid gap-1.5">
          {snapshot.marketSources.map((source) => (
            <div
              key={source.name}
              className="grid grid-cols-[1fr_auto] items-center gap-4 rounded-[4px] px-1 py-0.5 text-sm transition-colors hover:bg-[#0c1416]"
            >
              <div className="flex items-center gap-3 text-[#a9a8a1]">
                <SourceLogo sourceName={source.name} />
                <span>{source.name}</span>
              </div>
              <div className="text-right">
                <div className="terminal-value font-semibold text-[#ff8a00]">{formatUsd(source.value)}</div>
                <div className="text-[11px] text-[#948f86]">{source.note}</div>
              </div>
            </div>
          ))}
        </div>
      </RailSection>

      <LevelPanel title="All-Expiry Levels" items={snapshot.levels.allExpiry} />
      <LevelPanel title="0DTE Levels" items={snapshot.levels.zeroDte} />

      <RailSection title="Advanced">
        <div className="grid gap-1.5">
          {snapshot.levels.advanced.map((metric) => (
            <div
              key={metric.label}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-[4px] px-1 py-0.5 text-sm transition-colors hover:bg-[#0c1416]"
            >
              <div className="flex items-center gap-3 text-[#a9a8a1]">
                <MetricMarker color={metric.color} variant={getAdvancedMarkerVariant(metric.label)} />
                {metric.label}
              </div>
              <div className="terminal-value text-[#ff8a00]">{metric.value}</div>
              <div className={metric.change ? 'terminal-value text-[#ff4b43]' : 'terminal-value text-[#c8bea8]'}>
                {metric.change ?? '-'}
              </div>
            </div>
          ))}
        </div>
      </RailSection>

      <GammaRegimePanel snapshot={snapshot} />
    </aside>
  )
}

type LevelPanelProps = {
  title: string
  items: TerminalSnapshot['levels']['allExpiry']
}

type RailSectionProps = {
  title: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

function RailSection({ title, action, className, children }: RailSectionProps) {
  return (
    <section className={`terminal-rail-section ${className ?? ''}`}>
      <div className="mb-2 flex items-center gap-3">
        <h2 className="whitespace-nowrap text-[14px] uppercase tracking-[0.08em] text-[#e8ded0]">{title}</h2>
        <div className="terminal-divider h-px flex-1" />
        {action}
      </div>
      {children}
    </section>
  )
}

function LevelPanel({ title, items }: LevelPanelProps) {
  return (
    <RailSection title={title}>
      <div className="grid gap-1.5">
        {items.map((item) => (
            <div
              key={item.label}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-[4px] px-1 py-0.5 text-sm transition-colors hover:bg-[#0c1416]"
          >
            <div className="flex items-center gap-3 text-[#a9a8a1]">
              <MetricMarker color={getLevelMarkerColor(title, item.label)} variant={getLevelMarkerVariant(item.label)} />
              {item.label}
            </div>
            <div className="terminal-value font-semibold text-[#ff8a00]">${formatStrike(item.strike)}</div>
            <div className={item.changePercent && item.changePercent < 0 ? 'terminal-value text-[#ff4b43]' : 'terminal-value text-[#51cf66]'}>
              {item.changePercent === undefined ? '-' : formatSignedPercent(item.changePercent)}
            </div>
          </div>
        ))}
      </div>
    </RailSection>
  )
}

function SourceLogo({ sourceName }: { sourceName: string }) {
  const isDeribit = sourceName.includes('Deribit')

  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--marker-color)] drop-shadow-[0_0_8px_var(--marker-color)]"
      style={{ '--marker-color': isDeribit ? '#2dae9a' : '#97fce4' } as CSSProperties}
    >
      {isDeribit ? <DeribitLogo /> : <HyperliquidLogo />}
    </span>
  )
}

function DeribitLogo() {
  return (
    <svg viewBox="0 0 179.25 174.75" className="h-[15px] w-[15px]" role="img" aria-label="Deribit">
      <path
        d="m131 59.39a30.73 30.73 0 0 0-8.89-1.22l-64.26.16v58.17h64.09a28.37 28.37 0 0 0 17.56-5.86 28 28 0 0 0 7.58-9.22 31 31 0 0 0-.3-29.26 26.43 26.43 0 0 0-15.78-12.77z"
        fill="none"
      />
      <path
        d="m179.25 88c-.62-26.5-13.31-41.31-25.84-49.5a61.49 61.49 0 0 0-33.67-9.75h-3v-28.75h-28.24v28.75h-30.75v-28.75h-28.25v28.75h-29.5l.13 29.5h29.25v58.13h-29.38v28.62h29.5v29.75h28.25v-29.75h30.75v29.75h28.25v-29.75h5a59.09 59.09 0 0 0 28.25-7c30-16.3 29.25-50 29.25-50zm-32.19 13.42a28 28 0 0 1-7.58 9.22 28.37 28.37 0 0 1-17.56 5.86h-64.09v-58.17l64.26-.16a30.73 30.73 0 0 1 8.91 1.22 26.43 26.43 0 0 1 15.78 12.77 31 31 0 0 1 .28 29.26z"
        fill="currentColor"
      />
    </svg>
  )
}

function HyperliquidLogo() {
  return (
    <svg viewBox="0 0 144 144" className="h-4 w-4" role="img" aria-label="Hyperliquid">
      <path
        d="M144 71.6991C144 119.306 114.866 134.582 99.5156 120.98C86.8804 109.889 83.1211 86.4521 64.116 84.0456C39.9942 81.0113 37.9057 113.133 22.0334 113.133C3.5504 113.133 0 86.2428 0 72.4315C0 58.3063 3.96809 39.0542 19.736 39.0542C38.1146 39.0542 39.1588 66.5722 62.132 65.1073C85.0007 63.5379 85.4184 34.8689 100.247 22.6271C113.195 12.0593 144 23.4641 144 71.6991Z"
        fill="currentColor"
      />
    </svg>
  )
}

type MarkerVariant = 'diamond' | 'chevronUp' | 'chevronDown' | 'crosshair' | 'slash' | 'bracket' | 'flipZone'

function MetricMarker({ color, variant }: { color: string; variant: MarkerVariant }) {
  const commonStyle = {
    color,
    '--marker-color': color,
  } as CSSProperties

  if (variant === 'diamond') {
    return (
      <span
        aria-hidden="true"
        className="flex h-4 w-4 shrink-0 items-center justify-center"
        style={commonStyle}
      >
        <span className="h-2.5 w-2.5 rotate-45 border border-[var(--marker-color)] bg-[color-mix(in_srgb,var(--marker-color)_30%,transparent)] shadow-[0_0_12px_var(--marker-color)]" />
      </span>
    )
  }

  if (variant === 'chevronUp' || variant === 'chevronDown') {
    return (
      <span
        aria-hidden="true"
        className="relative h-4 w-4 shrink-0 text-[var(--marker-color)] drop-shadow-[0_0_8px_var(--marker-color)]"
        style={commonStyle}
      >
        <span
          className={
            variant === 'chevronUp'
              ? 'absolute left-1/2 top-[4px] h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-l-2 border-t-2 border-current'
              : 'absolute left-1/2 top-[1px] h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-b-2 border-r-2 border-current'
          }
        />
      </span>
    )
  }

  if (variant === 'crosshair') {
    return (
      <span aria-hidden="true" className="relative h-4 w-4 shrink-0" style={commonStyle}>
        <span className="absolute left-1/2 top-[2px] h-3 w-px -translate-x-1/2 bg-[var(--marker-color)] opacity-80" />
        <span className="absolute left-[2px] top-1/2 h-px w-3 -translate-y-1/2 bg-[var(--marker-color)] opacity-80" />
        <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-[var(--marker-color)] bg-[#071012] shadow-[0_0_10px_var(--marker-color)]" />
      </span>
    )
  }

  if (variant === 'slash') {
    return (
      <span aria-hidden="true" className="relative h-4 w-4 shrink-0" style={commonStyle}>
        <span className="absolute left-1/2 top-1/2 h-[2px] w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-[var(--marker-color)] shadow-[0_0_10px_var(--marker-color)]" />
      </span>
    )
  }

  if (variant === 'flipZone') {
    return (
      <span aria-hidden="true" className="relative h-4 w-4 shrink-0" style={commonStyle}>
        <span className="absolute left-[2px] top-[4px] h-2 w-2 rotate-45 border-l-2 border-b-2 border-[var(--marker-color)] shadow-[0_0_8px_var(--marker-color)]" />
        <span className="absolute right-[2px] top-[4px] h-2 w-2 rotate-45 border-r-2 border-t-2 border-[var(--marker-color)] opacity-75 shadow-[0_0_8px_var(--marker-color)]" />
      </span>
    )
  }

  return (
    <span aria-hidden="true" className="relative h-4 w-4 shrink-0" style={commonStyle}>
      <span className="absolute left-[3px] top-[4px] h-2.5 w-[3px] rounded-px bg-[var(--marker-color)] shadow-[0_0_9px_var(--marker-color)]" />
      <span className="absolute right-[3px] top-[4px] h-2.5 w-[3px] rounded-px bg-[var(--marker-color)] opacity-60 shadow-[0_0_9px_var(--marker-color)]" />
      <span className="absolute left-[5px] top-[4px] h-[3px] w-1.5 bg-[var(--marker-color)] opacity-70" />
    </span>
  )
}

function getLevelMarkerColor(title: string, label: string) {
  if (label.includes('Call')) return '#42e66f'
  if (label.includes('Put')) return '#ff4b43'
  if (title.includes('0DTE')) return '#62b8ff'

  return '#f5b946'
}

function getLevelMarkerVariant(label: string): MarkerVariant {
  if (label.includes('HVL')) return 'diamond'
  if (label.includes('Call')) return 'chevronUp'
  if (label.includes('Put')) return 'chevronDown'

  return 'diamond'
}

function getAdvancedMarkerVariant(label: string): MarkerVariant {
  if (label.includes('Zero')) return 'crosshair'
  if (label.includes('Pain')) return 'slash'
  if (label.includes('Expected')) return 'bracket'

  return 'flipZone'
}

function GammaRegimePanel({ snapshot }: SidePanelsProps) {
  const score = getRegimeScore(snapshot.totalNetGexUsd)
  const pointerAngle = scoreToAngle(score)
  const meter = { cx: 180, cy: 104, radius: 88, needleRadius: 72 }
  const pointerTip = polarPoint(meter.cx, meter.cy, meter.needleRadius, pointerAngle)
  const scoreDot = polarPoint(meter.cx, meter.cy, meter.radius, pointerAngle)
  const positive = score >= 0

  return (
    <RailSection title="Gamma Regime" className="pb-2">
      <svg viewBox="0 0 360 184" className="block h-[176px] w-full" role="img" aria-label="Gamma regime score">
        <defs>
          <linearGradient id="meter-green-segment" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#164c3b" />
            <stop offset="100%" stopColor="#20d464" />
          </linearGradient>
          <linearGradient id="meter-red-segment" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#e9352d" />
            <stop offset="100%" stopColor="#4c2222" />
          </linearGradient>
          <filter id="regime-pointer-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="meter-dot-glow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="meter-hub-gradient" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#dfffee" />
            <stop offset="46%" stopColor="#45d982" />
            <stop offset="100%" stopColor="#07120f" />
          </radialGradient>
        </defs>

        <path
          d={describeArc(meter.cx, meter.cy, meter.radius, 180, 360)}
          fill="none"
          stroke="#111b1d"
          strokeWidth="24"
          strokeLinecap="round"
        />
        {Array.from({ length: 34 }, (_, index) => {
          const start = 184 + index * 5
          const end = start + 3.8
          const normalized = (start + end) / 2
          const stroke =
            normalized < 234
              ? 'url(#meter-red-segment)'
              : normalized > 306
                ? 'url(#meter-green-segment)'
                : '#2b3738'
          const opacity = normalized < 234 || normalized > 306 ? 0.92 : 0.72

          return (
            <path
              key={start}
              d={describeArc(meter.cx, meter.cy, meter.radius, start, end)}
              fill="none"
              stroke={stroke}
              strokeWidth="21"
              strokeLinecap="butt"
              strokeOpacity={opacity}
            />
          )
        })}
        <path
          d={describeArc(meter.cx, meter.cy, meter.radius - 15, 180, 360)}
          fill="none"
          stroke="#233235"
          strokeWidth="4"
          strokeOpacity="0.8"
          strokeLinecap="round"
        />
        {Array.from({ length: 21 }, (_, index) => -1 + index * 0.1).map((tick) => {
          const angle = scoreToAngle(tick)
          const isMajor = Math.abs(Math.round(tick * 10)) % 5 === 0
          const outer = polarPoint(meter.cx, meter.cy, meter.radius + (isMajor ? 18 : 14), angle)
          const inner = polarPoint(meter.cx, meter.cy, meter.radius + 7, angle)

          return (
            <line
              key={tick}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={tick === 0 ? '#5fb8ba' : '#74807d'}
              strokeOpacity={tick === 0 ? 0.92 : isMajor ? 0.5 : 0.24}
              strokeWidth={tick === 0 ? 2 : isMajor ? 1.2 : 0.7}
            />
          )
        })}

        <line
          x1={meter.cx}
          y1={meter.cy}
          x2={pointerTip.x}
          y2={pointerTip.y}
          stroke={positive ? '#6ff6a1' : '#ff8b82'}
          strokeWidth="4"
          strokeLinecap="round"
          filter="url(#regime-pointer-glow)"
        />
        <circle cx={meter.cx} cy={meter.cy} r="10" fill="#07110f" stroke="#1c4e39" strokeWidth="2.2" />
        <circle cx={meter.cx} cy={meter.cy} r="4.6" fill="url(#meter-hub-gradient)" />
        <circle cx={scoreDot.x} cy={scoreDot.y} r="8" fill={positive ? '#2ee77e' : '#ff3f37'} opacity="0.28" filter="url(#meter-dot-glow)" />
        <circle cx={scoreDot.x} cy={scoreDot.y} r="5" fill="#081310" stroke={positive ? '#c4ffd5' : '#ffb0a8'} strokeWidth="2.3" />

        <text x="45" y="112" textAnchor="middle" fill="#ff3f37" fontSize="13">
          -1
        </text>
        <text x="315" y="112" textAnchor="middle" fill="#51cf66" fontSize="13">
          +1
        </text>
        <text x="180" y="22" textAnchor="middle" fill="#d8d4ca" fontSize="11">
          0
        </text>
        <text x="180" y="151" textAnchor="middle" fill={positive ? '#39d85f' : '#ff4b43'} fontSize="19" fontWeight="700">
          {positive ? 'LONG GAMMA' : 'SHORT GAMMA'}
        </text>
        <text x="180" y="174" textAnchor="middle" fill={positive ? '#39d85f' : '#ff4b43'} fontSize="16">
          {positive ? 'Positive' : 'Negative'} {formatRegimeScore(score)}
        </text>
      </svg>
    </RailSection>
  )
}

function getRegimeScore(totalNetGexUsd: number) {
  return Math.max(-1, Math.min(1, Math.tanh(totalNetGexUsd / 4_200_000_000)))
}

function formatRegimeScore(score: number) {
  return `${score >= 0 ? '+' : ''}${score.toFixed(2)}`
}

function scoreToAngle(score: number) {
  return 180 + ((score + 1) / 2) * 180
}

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  const radians = (angle * Math.PI) / 180

  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  }
}

function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarPoint(cx, cy, radius, startAngle)
  const end = polarPoint(cx, cy, radius, endAngle)
  const largeArcFlag = Math.abs(endAngle - startAngle) <= 180 ? 0 : 1

  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`
}
