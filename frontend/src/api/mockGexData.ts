import {
  getActiveDeribitExpiries,
  getDeribitExpiryMs,
  parseDeribitExpiry,
  type DeribitExpiry,
} from '@/api/deribitExpiries'

export type OpexExpiry = DeribitExpiry
export type GexExpiry = 'ALL' | OpexExpiry

export type MockGexStrike = {
  strike: number
  callGexUsd: number
  putGexUsd: number
  netGexUsd: number
  gammaExposureUsd: number
  callGammaExposureUsd: number
  putGammaExposureUsd: number
  netGammaExposureUsd: number
}

export type MockGexSnapshot = {
  symbol: 'BTC'
  expiry: GexExpiry
  spot: number
  asOfUtc: string
  gammaBars: MockGexStrike[]
  totalNetGexUsd: number
  totalCallGexUsd: number
  totalPutGexUsd: number
  maxPositiveGammaStrike: number
  maxNegativeGammaStrike: number
  /** Gamma Flip level, or null when no mass-valid cumulative zero-cross. */
  zeroGamma: number | null
  gammaFlip: number | null
  gammaFlipStatus: 'ok' | 'no_cross'
  /** Locked empty-state copy when status is no_cross. */
  gammaFlipNote: string | null
}

type ExpiryProfile = {
  callClusters: GexCluster[]
  putClusters: GexCluster[]
  textureScale: number
}

type GexCluster = {
  strike: number
  width: number
  value: number
}

const spot = 77_041
const asOfUtc = '04:58:01 UTC'
const dayMs = 86_400_000

const referenceCallClusters: GexCluster[] = [
  { strike: 75_000, width: 250, value: 33_000_000 },
  { strike: 78_000, width: 320, value: 8_000_000 },
  { strike: 80_000, width: 170, value: 37_000_000 },
  { strike: 82_000, width: 210, value: 18_000_000 },
  { strike: 83_000, width: 320, value: 7_500_000 },
  { strike: 84_000, width: 260, value: 10_000_000 },
  { strike: 85_000, width: 350, value: 9_000_000 },
  { strike: 87_500, width: 300, value: 5_500_000 },
  { strike: 90_000, width: 260, value: 10_500_000 },
  { strike: 95_000, width: 360, value: 4_200_000 },
]
const referencePutClusters: GexCluster[] = [
  { strike: 60_000, width: 360, value: 8_700_000 },
  { strike: 63_000, width: 230, value: 2_200_000 },
  { strike: 65_000, width: 300, value: 3_000_000 },
  { strike: 68_000, width: 280, value: 3_600_000 },
  { strike: 70_000, width: 250, value: 4_500_000 },
  { strike: 73_500, width: 260, value: 5_400_000 },
  { strike: 76_500, width: 190, value: 8_700_000 },
  { strike: 77_000, width: 180, value: 12_000_000 },
  { strike: 78_000, width: 230, value: 3_000_000 },
]

const strikeGrid = buildStrikeGrid()

export function getMockGexSnapshot(expiry: GexExpiry = 'ALL'): MockGexSnapshot {
  const snapshots = buildSnapshots()
  return snapshots[expiry] ?? buildExpirySnapshot(expiry)
}

export function getMockGexSnapshots() {
  return buildSnapshots()
}

export function getOpexExpiries(nowMs = Date.now()): OpexExpiry[] {
  return getActiveDeribitExpiries(nowMs)
}

export const opexExpiries = getOpexExpiries()

function buildSnapshots(): Record<string, MockGexSnapshot> & { ALL: MockGexSnapshot } {
  const expiries = getOpexExpiries()
  const datedSnapshots = Object.fromEntries(
    expiries.map((expiry) => [expiry, buildExpirySnapshot(expiry)]),
  ) as Record<OpexExpiry, MockGexSnapshot>

  return {
    ALL: buildAllExpirySnapshot(datedSnapshots),
    ...datedSnapshots,
  }
}

function buildExpirySnapshot(expiry: OpexExpiry): MockGexSnapshot {
  const profile = buildExpiryProfile(expiry)
  const gammaBars = strikeGrid.map((strike) => buildStrike(strike, profile))

  return summarizeSnapshot(expiry, gammaBars)
}

function buildAllExpirySnapshot(
  datedSnapshots: Record<OpexExpiry, MockGexSnapshot>,
): MockGexSnapshot {
  const expiries = Object.keys(datedSnapshots) as OpexExpiry[]
  const gammaBars = strikeGrid.map((strike) => {
    const rows = expiries.map((expiry) => datedSnapshots[expiry].gammaBars.find((row) => row.strike === strike))
    const callGexUsd = roundUsd(sum(rows.map((row) => row?.callGexUsd ?? 0)))
    const putGexUsd = roundUsd(sum(rows.map((row) => row?.putGexUsd ?? 0)))
    const netGexUsd = roundUsd(callGexUsd + putGexUsd)

    return toStrikeRow(strike, callGexUsd, putGexUsd, netGexUsd)
  })

  return summarizeSnapshot('ALL', gammaBars)
}

function buildExpiryProfile(expiry: OpexExpiry): ExpiryProfile {
  const activeExpiries = getOpexExpiries()
  const expiryIndex = activeExpiries.indexOf(expiry)
  const tenorDays = getTenorDays(expiry)
  const tenor = Math.min(1, tenorDays / 333)
  const weight = getLiquidityWeight(expiry, expiryIndex, tenorDays)
  const frontDayBoost = expiryIndex === 0 ? 1.2 : 1
  const callStrikeDrift = tenor * 1_500
  const putStrikeDrift = -tenor * 2_000

  return {
    callClusters: referenceCallClusters.map((cluster) => ({
      ...cluster,
      strike: roundStrike(cluster.strike + (cluster.strike >= 84_000 ? callStrikeDrift : 0)),
      width: cluster.width + tenor * 900,
      value: cluster.value * weight * frontDayBoost,
    })),
    putClusters: referencePutClusters.map((cluster) => ({
      ...cluster,
      strike: roundStrike(cluster.strike + (cluster.strike <= 70_000 ? putStrikeDrift : 0)),
      width: cluster.width + tenor * 700,
      value: cluster.value * weight * frontDayBoost,
    })),
    textureScale: 760_000 * weight * (1 + tenor * 0.8),
  }
}

function buildStrike(strike: number, profile: ExpiryProfile): MockGexStrike {
  // Mock clusters remain call-positive / put-negative for readable walls, but do not
  // clamp signs — dealer inventory can produce either sign on either leg.
  const callCluster = sum(profile.callClusters.map((cluster) => gaussian(strike, cluster.strike, cluster.width) * cluster.value))
  const putCluster = -sum(profile.putClusters.map((cluster) => gaussian(strike, cluster.strike, cluster.width) * cluster.value))
  const localTexture = deterministicTexture(strike) * profile.textureScale
  const callGexUsd = roundUsd(callCluster + localTexture * 0.35)
  const putGexUsd = roundUsd(putCluster + localTexture * -0.35)
  const netGexUsd = roundUsd(callGexUsd + putGexUsd)

  return toStrikeRow(strike, callGexUsd, putGexUsd, netGexUsd)
}

function toStrikeRow(
  strike: number,
  callGexUsd: number,
  putGexUsd: number,
  netGexUsd: number,
): MockGexStrike {
  return {
    strike,
    callGexUsd,
    putGexUsd,
    netGexUsd,
    gammaExposureUsd: netGexUsd,
    callGammaExposureUsd: callGexUsd,
    putGammaExposureUsd: putGexUsd,
    netGammaExposureUsd: netGexUsd,
  }
}

function summarizeSnapshot(expiry: GexExpiry, gammaBars: MockGexStrike[]): MockGexSnapshot {
  const totalCallGexUsd = roundUsd(sum(gammaBars.map((row) => row.callGexUsd)))
  const totalPutGexUsd = roundUsd(sum(gammaBars.map((row) => row.putGexUsd)))
  const totalNetGexUsd = roundUsd(totalCallGexUsd + totalPutGexUsd)
  const maxPositive = gammaBars.reduce((best, row) => (row.netGexUsd > best.netGexUsd ? row : best))
  const maxNegative = gammaBars.reduce((best, row) => (row.netGexUsd < best.netGexUsd ? row : best))

  return {
    symbol: 'BTC',
    expiry,
    spot,
    asOfUtc,
    gammaBars,
    totalNetGexUsd,
    totalCallGexUsd,
    totalPutGexUsd,
    maxPositiveGammaStrike: maxPositive.strike,
    maxNegativeGammaStrike: maxNegative.strike,
    ...(() => {
      const flip = estimateGammaFlip(gammaBars, spot)
      return {
        zeroGamma: flip.level,
        gammaFlip: flip.level,
        gammaFlipStatus: flip.status,
        gammaFlipNote: flip.note,
      }
    })(),
  }
}

function buildStrikeGrid() {
  const strikes = new Set<number>()
  addRange(strikes, 40_000, 55_000, 5_000)
  addRange(strikes, 56_000, 100_000, 500)
  addRange(strikes, 105_000, 145_000, 5_000)

  return [...strikes].sort((a, b) => a - b)
}

function addRange(strikes: Set<number>, start: number, end: number, step: number) {
  for (let strike = start; strike <= end; strike += step) {
    strikes.add(strike)
  }
}

/**
 * Mass filter for Gamma Flip cumulative zero-crossings.
 * Softened from 2.0% → 1.5% of Σ|net_gex| (parity with backend
 * GAMMA_FLIP_MIN_MASS_FRACTION). Failed crosses are discarded — never
 * resurrected as Flip via flattest |net_gex| fallback.
 */
const GAMMA_FLIP_MIN_MASS_FRACTION = 0.015 // 1.5%
/**
 * Near-spot eligibility window (parity with backend
 * GAMMA_FLIP_MAX_DISTANCE_FRAC). Mass-valid crosses outside spot ± 12%
 * yield no_cross — never publish a far wing zero as HVL.
 * Separate from Regime profile corridor (display-only, spot ± 8%).
 */
const GAMMA_FLIP_MAX_DISTANCE_FRAC = 0.12 // ±12% of spot

/** Locked empty-state copy (parity with backend GAMMA_FLIP_EMPTY_*). */
const GAMMA_FLIP_EMPTY_NEUTRAL = 'No local HVL · GEX one-sided'
const GAMMA_FLIP_EMPTY_SHORT = 'No local HVL · GEX one-sided (short)'
const GAMMA_FLIP_EMPTY_LONG = 'No local HVL · GEX one-sided (long)'
/** Clean one-sided polarity threshold (parity with backend). */
const GAMMA_FLIP_ONE_SIDED_MIN_FRAC = 0.05

/**
 * Cumulative net-GEX zero-cross nearest spot with meaningful mass,
 * restricted to the spot ± 12% eligibility window.
 * Mirrors backend `_estimate_gamma_flip` (HVL definition).
 * Returns null level + no_cross when no mass-valid in-window cross exists.
 */
function estimateGammaFlip(
  rows: MockGexStrike[],
  spotPrice = spot,
): { level: number | null; status: 'ok' | 'no_cross'; note: string | null } {
  if (rows.length === 0) {
    return { level: null, status: 'no_cross', note: GAMMA_FLIP_EMPTY_NEUTRAL }
  }

  const sorted = [...rows].sort((a, b) => a.strike - b.strike)
  const ref = spotPrice > 0 ? spotPrice : sorted[Math.floor(sorted.length / 2)]!.strike
  const maxDist = ref > 0 ? ref * GAMMA_FLIP_MAX_DISTANCE_FRAC : Infinity
  // Window-local mass denominator (parity with backend / zeroGamma.ts).
  const windowRows =
    ref > 0
      ? sorted.filter((row) => Math.abs(row.strike - ref) <= maxDist)
      : sorted
  const massRows = windowRows.length > 0 ? windowRows : sorted
  const totalAbs = massRows.reduce((sum, row) => sum + Math.abs(row.netGexUsd), 0)
  const minMass = Math.max(totalAbs * GAMMA_FLIP_MIN_MASS_FRACTION, 1e-12)

  type Crossing = { level: number; mass: number }
  let crossings: Crossing[] = []
  let previousStrike: number | null = null
  let previousCumulative: number | null = null
  let cumulative = 0

  for (const row of sorted) {
    const nextCumulative = cumulative + row.netGexUsd

    if (previousCumulative !== null && previousStrike !== null) {
      const prev = previousCumulative
      const next = nextCumulative

      if (prev === 0 && next === 0) {
        // still at zero
      } else if (next === 0 && prev !== 0) {
        const mass = Math.abs(prev) + Math.abs(next)
        if (mass >= minMass) crossings.push({ level: row.strike, mass })
      } else if (prev !== 0 && next !== 0 && Math.sign(prev) !== Math.sign(next)) {
        const mass = Math.abs(prev) + Math.abs(next)
        if (mass >= minMass) {
          const ratio = Math.abs(prev) / mass
          crossings.push({
            level: previousStrike + (row.strike - previousStrike) * ratio,
            mass,
          })
        }
      }
    }

    cumulative = nextCumulative
    previousStrike = row.strike
    previousCumulative = cumulative
  }

  // Near-spot eligibility: discard mass-valid crosses outside spot ± 12%.
  if (ref > 0) {
    crossings = crossings.filter((item) => Math.abs(item.level - ref) <= maxDist)
  }

  if (crossings.length === 0) {
    return {
      level: null,
      status: 'no_cross',
      note: formatGammaFlipEmptyNote(rows, ref),
    }
  }

  crossings.sort((a, b) => {
    const da = Math.abs(a.level - ref)
    const db = Math.abs(b.level - ref)
    if (da !== db) return da - db
    return b.mass - a.mass
  })
  return { level: Math.round(crossings[0]!.level), status: 'ok', note: null }
}

/** One-sided polarity from local book in eligibility window (sign read only). */
function formatGammaFlipEmptyNote(rows: MockGexStrike[], ref: number): string {
  let windowRows = rows
  if (ref > 0) {
    const maxDist = ref * GAMMA_FLIP_MAX_DISTANCE_FRAC
    const inWindow = rows.filter((row) => Math.abs(row.strike - ref) <= maxDist)
    if (inWindow.length > 0) windowRows = inWindow
  }
  const net = windowRows.reduce((sum, row) => sum + row.netGexUsd, 0)
  const abs = windowRows.reduce((sum, row) => sum + Math.abs(row.netGexUsd), 0)
  if (!(abs > 0)) return GAMMA_FLIP_EMPTY_NEUTRAL
  const score = net / abs
  if (score <= -GAMMA_FLIP_ONE_SIDED_MIN_FRAC) return GAMMA_FLIP_EMPTY_SHORT
  if (score >= GAMMA_FLIP_ONE_SIDED_MIN_FRAC) return GAMMA_FLIP_EMPTY_LONG
  return GAMMA_FLIP_EMPTY_NEUTRAL
}

function gaussian(value: number, center: number, width: number) {
  return Math.exp(-((value - center) ** 2) / (2 * width ** 2))
}

function deterministicTexture(strike: number) {
  return Math.sin(strike / 640) * 0.46 + Math.cos(strike / 1_450) * 0.27 + Math.sin(strike / 2_900) * 0.16
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function roundUsd(value: number) {
  return Math.round(value / 10_000) * 10_000
}

function roundStrike(value: number) {
  return Math.round(value / 500) * 500
}

function getTenorDays(expiry: OpexExpiry) {
  const expiryMs = getDeribitExpiryMs(expiry)
  if (expiryMs === null) return 30

  return Math.max(0, Math.ceil((expiryMs - Date.now()) / dayMs))
}

function getLiquidityWeight(expiry: OpexExpiry, expiryIndex: number, tenorDays: number) {
  if (expiryIndex >= 0) {
    return Math.max(0.005, 0.24 * Math.exp(-expiryIndex / 3.1))
  }

  const expiryDate = parseDeribitExpiry(expiry)
  const weekdayBoost = expiryDate?.getUTCDay() === 5 ? 1.25 : 1

  return Math.max(0.005, 0.22 * Math.exp(-tenorDays / 42) * weekdayBoost)
}
