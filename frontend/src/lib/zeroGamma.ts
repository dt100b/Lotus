/**
 * HVL (High Vol Level) for Lotus taker-flow GEX surfaces.
 *
 * Naming
 * ------
 * HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12%
 * (mass filter 1.5%). Not classic OI gamma flip.
 *
 * UI label is **HVL**. File / function names retain Zero Gamma aliases so
 * chart panes that already recompute per-surface keep working.
 *
 * Taker-flow vs naive OI models
 * ----------------------------
 * OI terminals often define zero-gamma from assumed dealer positioning
 * (short calls / long puts, put-sign flip) on open interest.
 * Lotus net GEX is signed **dealer inventory from cumulative taker flow**:
 *   - no automatic put flip
 *   - path-dependent, smaller, and noisier than OI walls
 *   - opposing flow nets out, so local bar zig-zags are common
 *
 * Algorithm (shared intent with backend `_estimate_gamma_flip`)
 * ------------------------------------------------------------
 * 1. Use the **selected expiry surface** (same gammaBars the chart paints).
 * 2. Walk strikes low → high; accumulate net GEX.
 * 3. Detect zero-crossings of the *cumulative* series only
 *    (linear interpolation between adjacent cumulative sums).
 *    Raw adjacent-bar sign flips that are not cumulative crosses are ignored.
 * 4. Mass filter: |prev_cum| + |next_cum| must be ≥
 *    MASS_FRAC × Σ|net| of strikes **inside the eligibility window**
 *    (falls back to full-book Σ|net| if the window is empty).
 *    Window-local mass avoids far-wing GEX inflating the threshold and
 *    killing legitimate near-spot crosses on flow books.
 * 5. Eligibility: |level − spot| / spot ≤ MAX_DISTANCE_FRAC.
 *    Far wing zeros on a one-sided near-spot book → no_cross.
 * 6. Among eligible crosses, pick nearest to spot (tie → larger mass).
 * 7. Never invent a level from flattest |net_gex| or an out-of-window cross.
 */

/** Mass filter vs window-local (or full-book) Σ|net_gex|. */
export const ZERO_GAMMA_MIN_MASS_FRACTION = 0.015 // 1.5%
/** Alias — same mass filter for HVL. */
export const HVL_MIN_MASS_FRACTION = ZERO_GAMMA_MIN_MASS_FRACTION
/**
 * Near-spot eligibility. ±12% of spot keeps HVL local enough to trade
 * against while still covering typical BTC strike spacing around spot.
 * (Was 15%; tightened after review — far wing zeros stay discarded.)
 */
export const ZERO_GAMMA_MAX_DISTANCE_FRAC = 0.12 // ±12% of spot
export const HVL_MAX_DISTANCE_FRAC = ZERO_GAMMA_MAX_DISTANCE_FRAC
/** Clean one-sided polarity threshold for empty-state copy. */
export const ZERO_GAMMA_ONE_SIDED_MIN_FRAC = 0.05
export const HVL_ONE_SIDED_MIN_FRAC = ZERO_GAMMA_ONE_SIDED_MIN_FRAC

export type ZeroGammaStatus = 'ok' | 'no_cross'
export type HvlStatus = ZeroGammaStatus

export type ZeroGammaOk = {
  level: number
  status: 'ok'
  note: null
}

export type ZeroGammaEmpty = {
  level: null
  status: 'no_cross'
  note: string
}

export type ZeroGammaResult = ZeroGammaOk | ZeroGammaEmpty
export type HvlResult = ZeroGammaResult

export type ZeroGammaBar = {
  strike: number
  netGexUsd: number
}
export type HvlBar = ZeroGammaBar

const EMPTY_NEUTRAL = 'No local HVL · GEX one-sided'
const EMPTY_SHORT = 'No local HVL · GEX one-sided (short)'
const EMPTY_LONG = 'No local HVL · GEX one-sided (long)'

/**
 * Estimate HVL from a GEX strike surface (selected expiry).
 * HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12%
 * (mass filter 1.5%). Not classic OI gamma flip.
 */
export function estimateZeroGamma(
  bars: ZeroGammaBar[] | null | undefined,
  spot: number | null | undefined,
): ZeroGammaResult {
  if (!bars || bars.length === 0) {
    return emptyResult(EMPTY_NEUTRAL)
  }

  const sorted = bars
    .map((b) => ({
      strike: Number(b.strike),
      net: Number(b.netGexUsd),
    }))
    .filter((r) => Number.isFinite(r.strike) && r.strike > 0 && Number.isFinite(r.net))
    .sort((a, b) => a.strike - b.strike)

  if (sorted.length === 0) return emptyResult(EMPTY_NEUTRAL)

  // De-dupe identical strikes (sum net).
  const deduped: Array<{ strike: number; net: number }> = []
  for (const r of sorted) {
    const prev = deduped[deduped.length - 1]
    if (prev && prev.strike === r.strike) prev.net += r.net
    else deduped.push({ ...r })
  }

  const ref =
    spot != null && Number.isFinite(spot) && spot > 0
      ? spot
      : deduped[Math.floor(deduped.length / 2)]!.strike

  // Mass denominator: prefer Σ|net| inside the eligibility window so far-wing
  // inventory does not bury a real near-spot cumulative cross.
  const maxDist = ref > 0 ? ref * ZERO_GAMMA_MAX_DISTANCE_FRAC : Infinity
  const windowRows =
    ref > 0
      ? deduped.filter((r) => Math.abs(r.strike - ref) <= maxDist)
      : deduped
  const massRows = windowRows.length > 0 ? windowRows : deduped
  const totalAbs = massRows.reduce((s, r) => s + Math.abs(r.net), 0)
  const minMass = Math.max(totalAbs * ZERO_GAMMA_MIN_MASS_FRACTION, 1e-12)

  type Crossing = { level: number; mass: number }
  let crossings: Crossing[] = []
  let previousStrike: number | null = null
  let previousCumulative: number | null = null
  let cumulative = 0

  for (const row of deduped) {
    const nextCumulative = cumulative + row.net

    if (previousCumulative !== null && previousStrike !== null) {
      const prev = previousCumulative
      const next = nextCumulative

      if (prev === 0 && next === 0) {
        // still at zero
      } else if (next === 0 && prev !== 0) {
        const mass = Math.abs(prev) + Math.abs(next)
        if (mass >= minMass) {
          crossings.push({ level: row.strike, mass })
        }
      } else if (prev !== 0 && next !== 0 && Math.sign(prev) !== Math.sign(next)) {
        const mass = Math.abs(prev) + Math.abs(next)
        if (mass >= minMass) {
          const ratio = Math.abs(prev) / mass
          const level = previousStrike + (row.strike - previousStrike) * ratio
          crossings.push({ level, mass })
        }
      }
    }

    cumulative = nextCumulative
    previousStrike = row.strike
    previousCumulative = cumulative
  }

  if (ref > 0 && Number.isFinite(maxDist)) {
    crossings = crossings.filter((c) => Math.abs(c.level - ref) <= maxDist)
  }

  if (crossings.length === 0) {
    return emptyResult(formatEmptyNote(deduped, ref))
  }

  crossings.sort((a, b) => {
    const da = Math.abs(a.level - ref)
    const db = Math.abs(b.level - ref)
    if (da !== db) return da - db
    return b.mass - a.mass
  })

  return {
    level: Math.round(crossings[0]!.level),
    status: 'ok',
    note: null,
  }
}

function emptyResult(note: string): ZeroGammaEmpty {
  return { level: null, status: 'no_cross', note }
}

function formatEmptyNote(
  rows: Array<{ strike: number; net: number }>,
  ref: number,
): string {
  let windowRows = rows
  if (ref > 0) {
    const maxDist = ref * ZERO_GAMMA_MAX_DISTANCE_FRAC
    const inWindow = rows.filter((r) => Math.abs(r.strike - ref) <= maxDist)
    if (inWindow.length > 0) windowRows = inWindow
  }
  const net = windowRows.reduce((s, r) => s + r.net, 0)
  const abs = windowRows.reduce((s, r) => s + Math.abs(r.net), 0)
  if (!(abs > 0)) return EMPTY_NEUTRAL
  const score = net / abs
  if (score <= -ZERO_GAMMA_ONE_SIDED_MIN_FRAC) return EMPTY_SHORT
  if (score >= ZERO_GAMMA_ONE_SIDED_MIN_FRAC) return EMPTY_LONG
  return EMPTY_NEUTRAL
}

/** Map heatmap / terminal gamma bars into estimator input. */
export function barsToZeroGammaInput(
  bars: Array<{
    strike: number
    gammaExposureUsd: number
    netGammaExposureUsd?: number
  }> | null | undefined,
): ZeroGammaBar[] {
  if (!bars || bars.length === 0) return []
  const out: ZeroGammaBar[] = []
  for (const b of bars) {
    const strike = Number(b.strike)
    if (!Number.isFinite(strike) || strike <= 0) continue
    const netRaw =
      b.netGammaExposureUsd != null && Number.isFinite(b.netGammaExposureUsd)
        ? b.netGammaExposureUsd
        : b.gammaExposureUsd
    const net = Number(netRaw)
    if (!Number.isFinite(net)) continue
    out.push({ strike, netGexUsd: net })
  }
  return out
}

// Backward-compatible aliases while callers migrate.
export {
  estimateZeroGamma as estimateGammaFlipZone,
  estimateZeroGamma as estimateHvl,
  barsToZeroGammaInput as barsToFlipInput,
  barsToZeroGammaInput as barsToHvlInput,
}
