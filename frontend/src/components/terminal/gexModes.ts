/**
 * Active GEX chart modes exposed in the terminal UI.
 *
 * Split / ABS / Profile are archived from the tab strip:
 * - Split/ABS: under the taker-flow model, signed net GEX is the primary signal.
 * - Profile: continuous Baseline smooth view; keep render path for restore, hide from UI.
 * Legacy mode strings still normalize cleanly via `normalizeExposureMode`.
 *
 * `forward` is the 0DTE forward gamma surface (pure τ projection) — independent of
 * historical heatmap / price-bands / strike profile.
 */
export const gexModes = ['net', 'heatmap', 'forward'] as const
export type GexModeOption = (typeof gexModes)[number]

/** Modes that render a real GEX profile/strike chart (excludes price-bands overlay). */
export const chartRenderModes = ['net'] as const
export type ChartRenderMode = (typeof chartRenderModes)[number]

/** Archived UI modes — kept for normalize/title fallbacks only. */
export const archivedGexModes = ['split', 'abs', 'profile'] as const
export type ArchivedGexMode = (typeof archivedGexModes)[number]

export const gexModeLabels: Record<GexModeOption, string> = {
  net: 'Strike',
  heatmap: 'Price',
  forward: 'Surface',
}

/** Legacy modes removed from the dashboard; map to a supported mode. */
export function normalizeExposureMode(mode: string): GexModeOption {
  // Archived call/put decomposition + continuous profile → Strike (signed inventory GEX).
  if (
    mode === 'call'
    || mode === 'put'
    || mode === 'split'
    || mode === 'abs'
    || mode === 'profile'
  ) {
    return 'net'
  }
  if ((gexModes as readonly string[]).includes(mode)) {
    return mode as GexModeOption
  }
  return 'net'
}

export function isChartRenderMode(mode: GexModeOption): mode is ChartRenderMode {
  return mode === 'net'
}

/** Modes that support the strike data-window control (includes price bands + forward). */
export function supportsDataWindow(mode: GexModeOption): boolean {
  return isChartRenderMode(mode) || mode === 'heatmap' || mode === 'forward'
}

/**
 * Default strike window for price-bands mode (~±6% ≈ $7–10k around BTC spot).
 * Tighter than strike charts so walls resolve with useful density.
 */
export const defaultHeatmapDataWindowPct = 6

/** Default ±% price window for 0DTE forward surface projection. */
export const defaultForwardDataWindowPct = 8

export function getGexChartTitle(mode: GexModeOption | ArchivedGexMode | string) {
  if (mode === 'net') {
    return 'GEX Strike'
  }

  if (mode === 'heatmap') {
    return 'PRICE/GEX'
  }

  if (mode === 'forward') {
    return 'GEX Surface'
  }

  // Archived titles only if something still routes here before normalize.
  if (mode === 'profile') {
    return 'NET GEX PROFILE'
  }

  if (mode === 'split') {
    return 'SPLIT GEX'
  }

  if (mode === 'abs') {
    return 'ABS CALL / PUT GEX'
  }

  return 'NET GEX'
}
