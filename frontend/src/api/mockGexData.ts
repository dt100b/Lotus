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
  callCenter: number
  callWidth: number
  callPeak: number
  putCenter: number
  putWidth: number
  putPeak: number
  wingScale: number
}

const spot = 75_860
const asOfUtc = '12:42:08 UTC'
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
  const tenor = Math.log1p(tenorDays) / Math.log1p(expiryTenorDays['26MAR27'])
  const frontWeekWeight = Math.max(0, 1 - tenorDays / 7)
  const monthlyWeight = expiry.endsWith('MAY26') || expiry.endsWith('JUN26') || expiry.endsWith('JUL26')
    ? 0.08
    : 0

  return {
    callCenter: roundStrike(80_500 + tenor * 14_500 + monthlyWeight * 2_000),
    callWidth: 2_150 + tenor * 12_000,
    callPeak: 21_500_000 - tenor * 12_000_000 + frontWeekWeight * 3_500_000,
    putCenter: roundStrike(71_500 - tenor * 16_500 - monthlyWeight * 1_500),
    putWidth: 3_100 + tenor * 8_800,
    putPeak: 19_000_000 - tenor * 8_600_000 + frontWeekWeight * 2_200_000,
    wingScale: 1_100_000 + tenor * 2_700_000,
  }
}

function buildStrike(strike: number, profile: ExpiryProfile): MockGexStrike {
  const callCluster = gaussian(strike, profile.callCenter, profile.callWidth) * profile.callPeak
  const putCluster = -gaussian(strike, profile.putCenter, profile.putWidth) * profile.putPeak
  const callWing = farOtmCallWing(strike, profile)
  const putWing = farOtmPutWing(strike, profile)
  const localTexture = deterministicTexture(strike) * profile.wingScale
  const callGexUsd = roundUsd(Math.max(0, callCluster + callWing + Math.max(localTexture, 0)))
  const putGexUsd = roundUsd(Math.min(0, putCluster + putWing + Math.min(localTexture, 0)))
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

function farOtmCallWing(strike: number, profile: ExpiryProfile) {
  const distance = Math.max(0, strike - spot)
  return gaussian(strike, 115_000, 22_000) * profile.wingScale * 0.82 + distance / 70_000 * profile.wingScale * 0.24
}

function farOtmPutWing(strike: number, profile: ExpiryProfile) {
  const distance = Math.max(0, spot - strike)
  return -(gaussian(strike, 45_000, 18_000) * profile.wingScale * 0.76 + distance / 55_000 * profile.wingScale * 0.2)
}

function deterministicTexture(strike: number) {
  return (Math.sin(strike / 1_900) * 0.38 + Math.cos(strike / 3_700) * 0.24) * 0.5
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
