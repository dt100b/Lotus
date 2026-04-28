export const opexExpiries = [
  '27APR26',
  '28APR26',
  '29APR26',
  '30APR26',
  '1MAY26',
  '8MAY26',
  '15MAY26',
  '29MAY26',
  '26JUN26',
  '31JUL26',
  '25SEP26',
  '25DEC26',
  '26MAR27',
] as const

export type OpexExpiry = (typeof opexExpiries)[number]
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
  zeroGamma: number
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
const expiries: OpexExpiry[] = [...opexExpiries]
const expiryTenorDays: Record<OpexExpiry, number> = {
  '27APR26': 0,
  '28APR26': 1,
  '29APR26': 2,
  '30APR26': 3,
  '1MAY26': 4,
  '8MAY26': 11,
  '15MAY26': 18,
  '29MAY26': 32,
  '26JUN26': 60,
  '31JUL26': 95,
  '25SEP26': 151,
  '25DEC26': 242,
  '26MAR27': 333,
}
const expiryLiquidityWeights: Record<OpexExpiry, number> = {
  '27APR26': 0.26,
  '28APR26': 0.16,
  '29APR26': 0.1,
  '30APR26': 0.07,
  '1MAY26': 0.08,
  '8MAY26': 0.1,
  '15MAY26': 0.07,
  '29MAY26': 0.055,
  '26JUN26': 0.045,
  '31JUL26': 0.025,
  '25SEP26': 0.018,
  '25DEC26': 0.012,
  '26MAR27': 0.005,
}

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
const snapshots = buildSnapshots()

export function getMockGexSnapshot(expiry: GexExpiry = 'ALL'): MockGexSnapshot {
  return snapshots[expiry]
}

export function getMockGexSnapshots() {
  return snapshots
}

function buildSnapshots(): Record<GexExpiry, MockGexSnapshot> {
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
  const tenorDays = expiryTenorDays[expiry]
  const tenor = tenorDays / expiryTenorDays['26MAR27']
  const weight = expiryLiquidityWeights[expiry]
  const frontDayBoost = expiry === '27APR26' ? 1.2 : 1
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
  const callCluster = sum(profile.callClusters.map((cluster) => gaussian(strike, cluster.strike, cluster.width) * cluster.value))
  const putCluster = -sum(profile.putClusters.map((cluster) => gaussian(strike, cluster.strike, cluster.width) * cluster.value))
  const localTexture = deterministicTexture(strike) * profile.textureScale
  const callGexUsd = roundUsd(Math.max(0, callCluster + Math.max(localTexture, 0)))
  const putGexUsd = roundUsd(Math.min(0, putCluster + Math.min(localTexture, 0)))
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
    zeroGamma: estimateZeroGamma(gammaBars),
  }
}

function buildStrikeGrid() {
  const strikes = new Set<number>()
  addRange(strikes, 40_000, 55_000, 5_000)
  addRange(strikes, 56_000, 70_000, 1_000)
  addRange(strikes, 70_500, 85_000, 500)
  addRange(strikes, 86_000, 100_000, 1_000)
  addRange(strikes, 105_000, 145_000, 5_000)

  return [...strikes].sort((a, b) => a - b)
}

function addRange(strikes: Set<number>, start: number, end: number, step: number) {
  for (let strike = start; strike <= end; strike += step) {
    strikes.add(strike)
  }
}

function estimateZeroGamma(rows: MockGexStrike[]) {
  const sorted = [...rows].sort((a, b) => a.strike - b.strike)

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]

    if (previous.netGexUsd === 0) {
      return previous.strike
    }

    if (Math.sign(previous.netGexUsd) !== Math.sign(current.netGexUsd)) {
      const distance = current.strike - previous.strike
      const interpolation = Math.abs(previous.netGexUsd) / (Math.abs(previous.netGexUsd) + Math.abs(current.netGexUsd))
      return Math.round(previous.strike + distance * interpolation)
    }
  }

  return sorted.reduce((closest, row) => {
    return Math.abs(row.netGexUsd) < Math.abs(closest.netGexUsd) ? row : closest
  }).strike
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
