import { getMockGexSnapshot, opexExpiries, type GexExpiry } from '@/api/mockGexData'
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
  changePercent?: number
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
  changePercent: number
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
  const frontExpiry = getMockGexSnapshot(opexExpiries[0])
  const spot = allExpiry.spot

  return {
    ...gexSnapshot,
    marketSources,
    levels: {
      allExpiry: [
        { label: 'HVL', strike: 80_000, changePercent: percentFromSpot(80_000, spot), color: '#d0bc62' },
        { label: 'Call Resistance', strike: 81_500, changePercent: percentFromSpot(81_500, spot), color: '#94c970' },
        { label: 'Put Support', strike: 68_000, changePercent: percentFromSpot(68_000, spot), color: '#ee5f66' },
      ],
      zeroDte: [
        { label: '0DTE HVL', strike: frontExpiry.maxPositiveGammaStrike, changePercent: percentFromSpot(frontExpiry.maxPositiveGammaStrike, spot), color: '#86a9c7' },
        { label: '0DTE Call', strike: 80_000, changePercent: percentFromSpot(80_000, spot), color: '#94c970' },
        { label: '0DTE Put', strike: frontExpiry.maxNegativeGammaStrike, changePercent: percentFromSpot(frontExpiry.maxNegativeGammaStrike, spot), color: '#ee5f66' },
      ],
      advanced: [
        { label: 'Zero Gamma', value: '$76,132', color: '#4f95d8' },
        { label: 'Max Pain', value: '$77,000', change: formatSignedPercent(percentFromSpot(77_000, spot)), color: '#d35fe9' },
        {
          label: 'Expected Move',
          value: '$73,500-$82,000',
          color: '#9a6cff',
        },
        { label: 'Gamma Flip Zones', value: '$76,132', color: '#27a7dc' },
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
      changePercent: ((row.strike - spot) / spot) * 100,
      gammaExposureUsd: row.gammaExposureUsd,
    }))
}

function percentFromSpot(strike: number, spot: number) {
  return ((strike - spot) / spot) * 100
}
