import { getMockGexSnapshot, getMockGexSnapshots, getOpexExpiries, type GexExpiry, type MockGexSnapshot } from '@/api/mockGexData'
import { getDeribitExpiryMs, parseDeribitExpiry } from '@/api/deribitExpiries'
import { levelColors } from '@/data/levelColors'
import { formatSignedPercent } from '@/lib/formatters'

export type GammaBar = {
  strike: number
  gammaExposureUsd: number
  callGammaExposureUsd?: number
  putGammaExposureUsd?: number
  netGammaExposureUsd?: number
}

export type MarketSource = {
  name: string
  value: number
  note: string
  color: string
}

export type LevelItem = {
  label: string
  strike: number
  distanceFromSpotPercent?: number
  color: string
}

export type AdvancedMetric = {
  label: string
  value: string
  change?: string
  color: string
}

export type RankingRow = {
  rank: number
  previousGammaExposureUsd?: number
  previousCallGammaExposureUsd?: number
  previousPutGammaExposureUsd?: number
  strike: number
  distanceFromSpotPercent: number
  gammaExposureUsd: number
  callGammaExposureUsd: number
  putGammaExposureUsd: number
  openInterest: number
  callOpenInterest: number
  putOpenInterest: number
  previousOpenInterest?: number
  previousCallOpenInterest?: number
  previousPutOpenInterest?: number
  gexHistory: GexHistoryPoint[]
  expiryContributions: ExpiryContribution[]
}

export type ExpiryContribution = {
  expiry: GexExpiry
  gammaExposureUsd: number
  callGammaExposureUsd: number
  putGammaExposureUsd: number
  openInterest: number
  callOpenInterest: number
  putOpenInterest: number
}

export type ExpiryKind = 'daily' | 'weekly' | 'monthly' | 'quarterly'

export type ExpiryStrikeConcentration = {
  strike: number
  distanceFromSpotPercent: number
  gammaExposureUsd: number
  callGammaExposureUsd: number
  putGammaExposureUsd: number
  openInterest: number
  callOpenInterest: number
  putOpenInterest: number
  openInterestSharePercent: number
}

export type ExpiryPositioningEvent = {
  expiry: GexExpiry
  kind: ExpiryKind
  daysToExpiry: number
  hoursToExpiry: number
  expiringOpenInterest: number
  expiringNotionalUsd: number
  openInterestSharePercent: number
  absGammaExposureUsd: number
  nearSpotOpenInterest: number
  nearSpotOpenInterestSharePercent: number
  nearSpotGammaExposureUsd: number
  sizeScore: number
  concentrationScore: number
  urgencyScore: number
  importanceScore: number
  topStrikes: ExpiryStrikeConcentration[]
}

export type GexHistoryPoint = {
  label: string
  netGexUsd: number
  callGexUsd: number
  putGexUsd: number
}

export type TerminalSnapshot = {
  asOfUtc: string
  symbol: 'BTC'
  expiry: GexExpiry
  spot: number
  gammaBars: GammaBar[]
  totalNetGexUsd: number
  totalCallGexUsd: number
  totalPutGexUsd: number
  maxPositiveGammaStrike: number
  maxNegativeGammaStrike: number
  zeroGamma: number
  marketSources: MarketSource[]
  levels: {
    allExpiry: LevelItem[]
    zeroDte: LevelItem[]
    advanced: AdvancedMetric[]
  }
  rankings: {
    allExpiry: RankingRow[]
    selectedExpiry: RankingRow[]
    zeroDte: RankingRow[]
  }
  expiryEvents: ExpiryPositioningEvent[]
}

export function getTerminalSnapshot(expiry: GexExpiry = 'ALL'): TerminalSnapshot {
  const snapshots = getMockGexSnapshots()
  const expiries = getOpexExpiries()
  const gexSnapshot = snapshots[expiry] ?? getMockGexSnapshot(expiry)
  const allExpiry = snapshots.ALL
  const frontExpiryId = expiries[0] ?? 'ALL'
  const frontExpiry = snapshots[frontExpiryId] ?? allExpiry
  const datedSnapshots = expiries
    .map((listedExpiry) => snapshots[listedExpiry])
    .filter((snapshot): snapshot is MockGexSnapshot => Boolean(snapshot))
  const spot = allExpiry.spot

  return {
    ...gexSnapshot,
    marketSources,
    levels: {
      allExpiry: [
        { label: 'HVL', strike: 80_000, distanceFromSpotPercent: percentFromSpot(80_000, spot), color: '#d0bc62' },
        { label: 'Call Resistance', strike: 81_500, distanceFromSpotPercent: percentFromSpot(81_500, spot), color: '#94c970' },
        { label: 'Put Support', strike: 68_000, distanceFromSpotPercent: percentFromSpot(68_000, spot), color: '#ee5f66' },
      ],
      zeroDte: [
        { label: '0DTE HVL', strike: frontExpiry.maxPositiveGammaStrike, distanceFromSpotPercent: percentFromSpot(frontExpiry.maxPositiveGammaStrike, spot), color: '#86a9c7' },
        { label: '0DTE Call', strike: 80_000, distanceFromSpotPercent: percentFromSpot(80_000, spot), color: levelColors.zeroDteCall },
        { label: '0DTE Put', strike: frontExpiry.maxNegativeGammaStrike, distanceFromSpotPercent: percentFromSpot(frontExpiry.maxNegativeGammaStrike, spot), color: levelColors.zeroDtePut },
      ],
      advanced: [
        { label: 'Zero Gamma', value: '$76,132', color: levelColors.zeroGamma },
        { label: 'Max Pain', value: '$77,000', change: formatSignedPercent(percentFromSpot(77_000, spot)), color: '#d35fe9' },
        {
          label: 'Expected Move',
          value: '$73,500-$82,000',
          color: levelColors.expectedMove,
        },
        { label: 'Gamma Flip Zones', value: '$76,132', color: levelColors.gammaFlip },
      ],
    },
    rankings: {
      allExpiry: buildRankingRows(allExpiry.gammaBars, spot, datedSnapshots),
      selectedExpiry: buildRankingRows(gexSnapshot.gammaBars, spot, [gexSnapshot]),
      zeroDte: buildRankingRows(frontExpiry.gammaBars, spot, [frontExpiry]),
    },
    expiryEvents: buildExpiryEvents(datedSnapshots, spot),
  }
}

const marketSources: MarketSource[] = [
  { name: 'Index (Deribit)', value: 77_041, note: 'options settle', color: '#d35fe9' },
  { name: 'Perps (Hyperliquid)', value: 77_118, note: 'basis +77.00', color: '#27a7dc' },
]

export const terminalSnapshot = getTerminalSnapshot('ALL')

function buildRankingRows(
  rows: GammaBar[],
  spot: number,
  contributionSnapshots: MockGexSnapshot[],
): RankingRow[] {
  return rankRows(rows)
    .slice(0, 10)
    .map((row) => {
      const callGammaExposureUsd = row.callGammaExposureUsd ?? 0
      const putGammaExposureUsd = row.putGammaExposureUsd ?? 0
      const gexHistory = buildGexHistory(row)
      const previousPoint = gexHistory.at(-2)
      const callOpenInterest = estimateOpenInterest(row.strike, 'call', callGammaExposureUsd)
      const putOpenInterest = estimateOpenInterest(row.strike, 'put', putGammaExposureUsd)
      const previousCallOpenInterest = getPreviousOpenInterest(callOpenInterest, row.strike, 'call')
      const previousPutOpenInterest = getPreviousOpenInterest(putOpenInterest, row.strike, 'put')

      return {
        rank: row.rank,
        previousGammaExposureUsd: previousPoint?.netGexUsd,
        previousCallGammaExposureUsd: previousPoint?.callGexUsd,
        previousPutGammaExposureUsd: previousPoint?.putGexUsd,
        strike: row.strike,
        distanceFromSpotPercent: percentFromSpot(row.strike, spot),
        gammaExposureUsd: row.gammaExposureUsd,
        callGammaExposureUsd,
        putGammaExposureUsd,
        openInterest: callOpenInterest + putOpenInterest,
        callOpenInterest,
        putOpenInterest,
        previousOpenInterest: previousCallOpenInterest + previousPutOpenInterest,
        previousCallOpenInterest,
        previousPutOpenInterest,
        gexHistory,
        expiryContributions: buildExpiryContributions(row.strike, contributionSnapshots),
      }
    })
}

function rankRows(rows: GammaBar[]) {
  return [...rows]
    .sort((a, b) => Math.abs(b.gammaExposureUsd) - Math.abs(a.gammaExposureUsd))
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }))
}

function buildExpiryContributions(strike: number, snapshots: MockGexSnapshot[]): ExpiryContribution[] {
  return snapshots
    .map((snapshot) => {
      const row = snapshot.gammaBars.find((gammaBar) => gammaBar.strike === strike)

      return {
        expiry: snapshot.expiry,
        gammaExposureUsd: row?.gammaExposureUsd ?? 0,
        callGammaExposureUsd: row?.callGammaExposureUsd ?? 0,
        putGammaExposureUsd: row?.putGammaExposureUsd ?? 0,
        openInterest: estimateOpenInterest(strike, 'call', row?.callGammaExposureUsd ?? 0)
          + estimateOpenInterest(strike, 'put', row?.putGammaExposureUsd ?? 0),
        callOpenInterest: estimateOpenInterest(strike, 'call', row?.callGammaExposureUsd ?? 0),
        putOpenInterest: estimateOpenInterest(strike, 'put', row?.putGammaExposureUsd ?? 0),
      }
    })
    .filter((contribution) => contribution.gammaExposureUsd !== 0)
    .sort((a, b) => Math.abs(b.gammaExposureUsd) - Math.abs(a.gammaExposureUsd))
}

function buildExpiryEvents(snapshots: MockGexSnapshot[], spot: number): ExpiryPositioningEvent[] {
  const unscoredEvents = snapshots.map((snapshot) => {
    const strikeRows = snapshot.gammaBars
      .map((row) => {
        const callGammaExposureUsd = row.callGammaExposureUsd ?? 0
        const putGammaExposureUsd = row.putGammaExposureUsd ?? 0
        const callOpenInterest = estimateOpenInterest(row.strike, 'call', callGammaExposureUsd)
        const putOpenInterest = estimateOpenInterest(row.strike, 'put', putGammaExposureUsd)
        const openInterest = callOpenInterest + putOpenInterest
        const distanceFromSpotPercent = percentFromSpot(row.strike, spot)

        return {
          strike: row.strike,
          distanceFromSpotPercent,
          gammaExposureUsd: row.gammaExposureUsd,
          callGammaExposureUsd,
          putGammaExposureUsd,
          openInterest,
          callOpenInterest,
          putOpenInterest,
          openInterestSharePercent: 0,
        }
      })
      .filter((row) => row.openInterest > 0)
    const expiringOpenInterest = sum(strikeRows.map((row) => row.openInterest))
    const nearSpotRows = strikeRows.filter((row) => Math.abs(row.distanceFromSpotPercent) <= 2.5)
    const nearSpotOpenInterest = sum(nearSpotRows.map((row) => row.openInterest))
    const nearSpotGammaExposureUsd = roundUsd(sum(nearSpotRows.map((row) => Math.abs(row.gammaExposureUsd))))
    const absGammaExposureUsd = roundUsd(sum(strikeRows.map((row) => Math.abs(row.gammaExposureUsd))))
    const { daysToExpiry, hoursToExpiry } = getExpiryTime(snapshot.expiry)

    return {
      expiry: snapshot.expiry,
      kind: getExpiryKind(snapshot.expiry),
      daysToExpiry,
      hoursToExpiry,
      expiringOpenInterest,
      expiringNotionalUsd: Math.round(expiringOpenInterest * spot),
      openInterestSharePercent: 0,
      absGammaExposureUsd,
      nearSpotOpenInterest,
      nearSpotOpenInterestSharePercent: expiringOpenInterest === 0 ? 0 : (nearSpotOpenInterest / expiringOpenInterest) * 100,
      nearSpotGammaExposureUsd,
      sizeScore: 0,
      concentrationScore: 0,
      urgencyScore: getUrgencyScore(daysToExpiry),
      importanceScore: 0,
      topStrikes: strikeRows
        .map((row) => ({
          ...row,
          openInterestSharePercent: expiringOpenInterest === 0 ? 0 : (row.openInterest / expiringOpenInterest) * 100,
        }))
        .sort((a, b) => getStrikeConcentrationScore(b) - getStrikeConcentrationScore(a))
        .slice(0, 4),
    }
  })
  const totalOpenInterest = sum(unscoredEvents.map((event) => event.expiringOpenInterest))
  const maxOpenInterestShare = Math.max(
    ...unscoredEvents.map((event) => (totalOpenInterest === 0 ? 0 : event.expiringOpenInterest / totalOpenInterest)),
    0,
  )

  return unscoredEvents
    .map((event) => {
      const openInterestShare = totalOpenInterest === 0 ? 0 : event.expiringOpenInterest / totalOpenInterest
      const sizeScore = maxOpenInterestShare === 0 ? 0 : (openInterestShare / maxOpenInterestShare) * 100
      const concentrationScore = event.nearSpotOpenInterestSharePercent
      const importanceScore = (sizeScore * 0.4) + (concentrationScore * 0.35) + (event.urgencyScore * 0.25)

      return {
        ...event,
        openInterestSharePercent: openInterestShare * 100,
        sizeScore,
        concentrationScore,
        importanceScore,
      }
    })
    .sort((a, b) => b.importanceScore - a.importanceScore)
}

function getStrikeConcentrationScore(row: ExpiryStrikeConcentration) {
  const proximityBoost = 1 / (1 + Math.abs(row.distanceFromSpotPercent))

  return row.openInterest * (1 + proximityBoost)
}

function getExpiryTime(expiry: GexExpiry) {
  const expiryMs = expiry === 'ALL' ? null : getDeribitExpiryMs(expiry)
  if (expiryMs === null) {
    return { daysToExpiry: 0, hoursToExpiry: 0 }
  }

  const hoursToExpiry = Math.max(0, (expiryMs - Date.now()) / 3_600_000)

  return {
    daysToExpiry: hoursToExpiry / 24,
    hoursToExpiry,
  }
}

function getUrgencyScore(daysToExpiry: number) {
  return clamp((1 - (daysToExpiry / 45)) * 100, 0, 100)
}

function getExpiryKind(expiry: GexExpiry): ExpiryKind {
  const date = expiry === 'ALL' ? null : parseDeribitExpiry(expiry)
  if (!date) return 'daily'

  if (isLastFridayOfMonth(date)) {
    return [2, 5, 8, 11].includes(date.getUTCMonth()) ? 'quarterly' : 'monthly'
  }

  return date.getUTCDay() === 5 ? 'weekly' : 'daily'
}

function isLastFridayOfMonth(date: Date) {
  if (date.getUTCDay() !== 5) return false

  const nextFriday = new Date(date.getTime() + 7 * 86_400_000)

  return nextFriday.getUTCMonth() !== date.getUTCMonth()
}

function buildGexHistory(row: GammaBar): GexHistoryPoint[] {
  const labels = ['6D', '5D', '4D', '3D', '2D', '1D', 'Today']
  const callGammaExposureUsd = row.callGammaExposureUsd ?? 0
  const putGammaExposureUsd = row.putGammaExposureUsd ?? 0
  const previousCall = callGammaExposureUsd * getPreviousGammaMultiplier(row.strike, 'call')
  const previousPut = putGammaExposureUsd * getPreviousGammaMultiplier(row.strike, 'put')
  const previousNet = previousCall + previousPut

  return labels.map((label, index) => {
    if (index === labels.length - 1) {
      return {
        label,
        netGexUsd: row.gammaExposureUsd,
        callGexUsd: callGammaExposureUsd,
        putGexUsd: putGammaExposureUsd,
      }
    }

    if (index === labels.length - 2) {
      return {
        label,
        netGexUsd: roundUsd(previousNet),
        callGexUsd: roundUsd(previousCall),
        putGexUsd: roundUsd(previousPut),
      }
    }

    const blend = index / (labels.length - 2)
    const wave = 0.92 + Math.sin(row.strike / 760 + index * 0.9) * 0.08
    const call = (previousCall * (1 - blend) + callGammaExposureUsd * blend) * wave
    const put = (previousPut * (1 - blend) + putGammaExposureUsd * blend) * (1.02 - (wave - 0.92))

    return {
      label,
      netGexUsd: roundUsd(call + put),
      callGexUsd: roundUsd(call),
      putGexUsd: roundUsd(put),
    }
  })
}

function getPreviousGammaMultiplier(strike: number, side: 'call' | 'put') {
  const phase = side === 'call' ? 875 : 935

  return 0.82 + ((Math.sin(strike / phase) + 1) / 2) * 0.42
}

function estimateOpenInterest(strike: number, side: 'call' | 'put', gammaExposureUsd: number) {
  const base = side === 'call' ? 340 : 285
  const texture = ((Math.sin(strike / (side === 'call' ? 690 : 810)) + 1) / 2) * 280
  const exposureWeight = Math.abs(gammaExposureUsd) / 1_000_000 * (side === 'call' ? 118 : 104)

  return Math.round((base + texture + exposureWeight) / 10) * 10
}

function getPreviousOpenInterest(openInterest: number, strike: number, side: 'call' | 'put') {
  const phase = side === 'call' ? 980 : 1_120
  const multiplier = 0.9 + ((Math.cos(strike / phase) + 1) / 2) * 0.18

  return Math.round((openInterest * multiplier) / 10) * 10
}

function roundUsd(value: number) {
  return Math.round(value / 10_000) * 10_000
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function percentFromSpot(strike: number, spot: number) {
  return ((strike - spot) / spot) * 100
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
