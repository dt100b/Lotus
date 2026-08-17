/** Density overlay and hover geometry. No clipping or renormalization. */

export type DensityLayerFlags = {
  forward: boolean
  central50: boolean
  central90: boolean
  wings: boolean
  sigma: boolean
  median: boolean
  mode: boolean
  quantileHairlines: boolean
}

export type DensityQuantiles = {
  p05: number
  p25: number
  p50: number
  p75: number
  p95: number
}

export type DensityInterval = {
  id: 'central50' | 'central90'
  left: number
  right: number
}

export type DensityOverlayDescriptor = {
  kind:
    | 'central90'
    | 'central50'
    | 'curve'
    | 'forward'
    | 'hairline'
    | 'wings'
    | 'sigma'
    | 'mode'
    | 'median'
  strike?: number
  left?: number
  right?: number
  label?: string
}

export type DensityHoverMetrics = {
  strike: number
  density: number
  cdf: number | null
  insideCentral50: boolean
  insideCentral90: boolean
  versusForward: 'below' | 'above' | 'at' | null
}

export const DEFAULT_LIVE_DENSITY_LAYERS: DensityLayerFlags = {
  forward: true,
  central50: true,
  central90: true,
  wings: false,
  sigma: false,
  median: false,
  mode: false,
  quantileHairlines: true,
}

export function emptyDensityLayers(): DensityLayerFlags {
  return {
    forward: false,
    central50: false,
    central90: false,
    wings: false,
    sigma: false,
    median: false,
    mode: false,
    quantileHairlines: false,
  }
}

export function intervalFromQuantiles(
  left: number,
  right: number,
): { left: number; right: number } | null {
  if (!Number.isFinite(left) || !Number.isFinite(right) || !(right > left)) return null
  return { left, right }
}

export function centralIntervals(quantiles: DensityQuantiles): {
  central90: DensityInterval | null
  central50: DensityInterval | null
} {
  const central90 = intervalFromQuantiles(quantiles.p05, quantiles.p95)
  const central50 = intervalFromQuantiles(quantiles.p25, quantiles.p75)
  return {
    central90: central90 ? { id: 'central90', ...central90 } : null,
    central50: central50 ? { id: 'central50', ...central50 } : null,
  }
}

export function intervalIsNested(
  inner: { left: number; right: number } | null,
  outer: { left: number; right: number } | null,
): boolean {
  if (!inner || !outer) return false
  return inner.left >= outer.left && inner.right <= outer.right
}

export function servedCdfIsAligned(
  strikes: readonly number[],
  cdf: readonly number[] | null | undefined,
): cdf is readonly number[] {
  if (!cdf || cdf.length === 0 || cdf.length !== strikes.length) return false
  return cdf.every((value) => Number.isFinite(value))
}

export function hoverFromServedResult(input: {
  strike: number
  density: number
  cdf: number | null
  forward: number
  quantiles: DensityQuantiles
}): DensityHoverMetrics {
  const { strike, density, cdf, forward, quantiles } = input
  const inside50 = Number.isFinite(quantiles.p25)
    && Number.isFinite(quantiles.p75)
    && strike >= quantiles.p25
    && strike <= quantiles.p75
  const inside90 = Number.isFinite(quantiles.p05)
    && Number.isFinite(quantiles.p95)
    && strike >= quantiles.p05
    && strike <= quantiles.p95
  let versusForward: DensityHoverMetrics['versusForward'] = null
  if (Number.isFinite(forward) && Number.isFinite(strike)) {
    if (strike < forward) versusForward = 'below'
    else if (strike > forward) versusForward = 'above'
    else versusForward = 'at'
  }
  return {
    strike,
    density,
    cdf: cdf != null && Number.isFinite(cdf) ? cdf : null,
    insideCentral50: inside50,
    insideCentral90: inside90,
    versusForward,
  }
}

export function describeDensityOverlays(input: {
  eligible: boolean
  layers: DensityLayerFlags
  forward: number
  quantiles: DensityQuantiles
  hasCurve: boolean
}): DensityOverlayDescriptor[] {
  if (!input.eligible) return []
  const overlays: DensityOverlayDescriptor[] = []
  const { central90, central50 } = centralIntervals(input.quantiles)
  if (input.layers.central90 && central90) {
    overlays.push({
      kind: 'central90',
      left: central90.left,
      right: central90.right,
      label: 'Central 90%',
    })
  }
  if (input.layers.central50 && central50) {
    overlays.push({
      kind: 'central50',
      left: central50.left,
      right: central50.right,
      label: 'Central 50%',
    })
  }
  if (input.hasCurve) overlays.push({ kind: 'curve', label: 'Density' })
  if (input.layers.forward && Number.isFinite(input.forward)) {
    overlays.push({ kind: 'forward', strike: input.forward, label: 'FWD' })
  }
  if (input.layers.quantileHairlines) {
    for (const [label, strike] of [
      ['P5', input.quantiles.p05],
      ['P25', input.quantiles.p25],
      ['P75', input.quantiles.p75],
      ['P95', input.quantiles.p95],
    ] as const) {
      if (Number.isFinite(strike)) overlays.push({ kind: 'hairline', strike, label })
    }
  }
  if (input.layers.wings) overlays.push({ kind: 'wings' })
  if (input.layers.sigma) overlays.push({ kind: 'sigma' })
  if (input.layers.mode) overlays.push({ kind: 'mode' })
  if (input.layers.median && Number.isFinite(input.quantiles.p50)) {
    overlays.push({ kind: 'median', strike: input.quantiles.p50, label: 'MED' })
  }
  return overlays
}

export function liveDensityLayers(input: {
  eligible: boolean
  showCentral50: boolean
  showCentral90: boolean
  showForward: boolean
}): DensityLayerFlags {
  if (!input.eligible) return emptyDensityLayers()
  return {
    ...DEFAULT_LIVE_DENSITY_LAYERS,
    forward: input.showForward,
    central50: input.showCentral50,
    central90: input.showCentral90,
    quantileHairlines: input.showCentral50 || input.showCentral90,
  }
}
