const usdFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

const strikeFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

export function formatStrike(value: number) {
  return strikeFormatter.format(value)
}

export function formatUsd(value: number) {
  return `$${usdFormatter.format(value)}`
}

export function formatSignedPercent(value: number) {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export function formatMillions(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${Math.abs(value / 1_000_000).toFixed(2)}M`
}

export function formatAxisMillions(value: number) {
  if (value === 0) {
    return '0'
  }

  const sign = value > 0 ? '+' : '-'
  const millions = Math.abs(value) / 1_000_000
  // Sub-1M steps (e.g. 2.5M) need a decimal; whole millions stay compact.
  const body = Number.isInteger(millions) || Math.abs(millions - Math.round(millions)) < 1e-9
    ? `${Math.round(millions)}`
    : millions.toFixed(1)

  return `${sign}${body}M`
}

/**
 * GEX strike-ladder / desk axis labels — dollar prefix, no leading +,
 * auto unit (K / M / B) to match the reference Net-GEX scale strip.
 * Examples: -$3B, -$500M, 0, $1B, $2.5M
 */
export function formatGexAxisTick(value: number) {
  if (!Number.isFinite(value) || value === 0) return '0'

  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)

  if (abs >= 1_000_000_000) {
    return `${sign}$${trimAxisUnit(abs / 1_000_000_000)}B`
  }
  if (abs >= 1_000_000) {
    return `${sign}$${trimAxisUnit(abs / 1_000_000)}M`
  }
  if (abs >= 1_000) {
    return `${sign}$${trimAxisUnit(abs / 1_000)}K`
  }
  return `${sign}$${Math.round(abs)}`
}

function trimAxisUnit(value: number): string {
  if (Number.isInteger(value) || Math.abs(value - Math.round(value)) < 1e-9) {
    return `${Math.round(value)}`
  }
  const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return fixed.replace(/\.0$/, '')
}
