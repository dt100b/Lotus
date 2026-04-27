import { getMockGexSnapshot, opexExpiries, type GexExpiry } from '@/api/mockGexData'

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
    zeroDte: RankingRow[]
  }
}

export function getTerminalSnapshot(expiry: GexExpiry = 'ALL'): TerminalSnapshot {
  const gexSnapshot = getMockGexSnapshot(expiry)
  const allExpiry = getMockGexSnapshot('ALL')
  const frontExpiry = getMockGexSnapshot(opexExpiries[0])

  return {
    ...gexSnapshot,
    marketSources,
    levels: {
      allExpiry: [
        { label: 'HVL', strike: allExpiry.maxPositiveGammaStrike, changePercent: 0.65, color: '#ffb338' },
        { label: 'Call Resistance', strike: allExpiry.maxPositiveGammaStrike, changePercent: 4.57, color: '#ff3333' },
        { label: 'Put Support', strike: allExpiry.maxNegativeGammaStrike, changePercent: -0.64, color: '#b8c34f' },
      ],
      zeroDte: [
        { label: '0DTE HVL', strike: frontExpiry.maxPositiveGammaStrike, changePercent: 0.65, color: '#ffb338' },
        { label: '0DTE Call', strike: frontExpiry.maxPositiveGammaStrike, changePercent: 4.57, color: '#ff3333' },
        { label: '0DTE Put', strike: frontExpiry.maxNegativeGammaStrike, changePercent: -0.64, color: '#b8c34f' },
      ],
      advanced: [
        { label: 'Zero Gamma', value: `$${formatStrikeLikeNumber(gexSnapshot.zeroGamma)}`, color: '#4f95d8' },
        { label: 'Max Pain', value: `$${formatStrikeLikeNumber(gexSnapshot.maxNegativeGammaStrike)}`, change: '-3.27%', color: '#d35fe9' },
        {
          label: 'Expected Move',
          value: `$${formatStrikeLikeNumber(Math.round(gexSnapshot.spot * 0.972))}-$${formatStrikeLikeNumber(Math.round(gexSnapshot.spot * 1.044))}`,
          color: '#9a6cff',
        },
        { label: 'Gamma Flip Zones', value: `$${formatStrikeLikeNumber(gexSnapshot.zeroGamma)}`, color: '#27a7dc' },
      ],
    },
    rankings: {
      allExpiry: buildRankingRows(allExpiry.gammaBars),
      zeroDte: buildRankingRows(frontExpiry.gammaBars),
    },
  }
}

const marketSources: MarketSource[] = [
  { name: 'Index (Deribit)', value: 75_502, note: 'options settle', color: '#d35fe9' },
  { name: 'Perps (Hyperliquid)', value: 75_860, note: 'basis +642.15', color: '#27a7dc' },
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

function formatStrikeLikeNumber(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}
