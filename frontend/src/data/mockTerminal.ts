import { getMockGexSnapshot, getOpexExpiries, type GexExpiry } from '@/api/mockGexData'
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
  strike: number
  distanceFromSpotPercent: number
  gammaExposureUsd: number
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
}

export function getTerminalSnapshot(expiry: GexExpiry = 'ALL'): TerminalSnapshot {
  const gexSnapshot = getMockGexSnapshot(expiry)
  const allExpiry = getMockGexSnapshot('ALL')
  const frontExpiry = getMockGexSnapshot(getOpexExpiries()[0] ?? 'ALL')
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
      allExpiry: buildRankingRows(allExpiry.gammaBars),
      selectedExpiry: buildRankingRows(gexSnapshot.gammaBars),
      zeroDte: buildRankingRows(frontExpiry.gammaBars),
    },
  }
}

const marketSources: MarketSource[] = [
  { name: 'Index (Deribit)', value: 77_041, note: 'options settle', color: '#d35fe9' },
  { name: 'Perps (Hyperliquid)', value: 77_118, note: 'basis +77.00', color: '#27a7dc' },
]

export const terminalSnapshot = getTerminalSnapshot('ALL')

function buildRankingRows(rows: GammaBar[]): RankingRow[] {
  const spot = getMockGexSnapshot('ALL').spot

  return [...rows]
    .sort((a, b) => Math.abs(b.gammaExposureUsd) - Math.abs(a.gammaExposureUsd))
    .slice(0, 10)
    .map((row, index) => ({
      rank: index + 1,
      strike: row.strike,
      distanceFromSpotPercent: percentFromSpot(row.strike, spot),
      gammaExposureUsd: row.gammaExposureUsd,
    }))
}

function percentFromSpot(strike: number, spot: number) {
  return ((strike - spot) / spot) * 100
}
