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
  /** Signed net GEX at the level strike when provided by the backend. */
  netGex?: number
  /** Expiry tag for tenor-scoped groups (weekly / monthly / quarterly). */
  scopeLabel?: string
}

/** Reference metrics (Gamma Flip, Max Pain, Expected Move). Formerly AdvancedMetric. */
export type AdvancedMetric = {
  label: string
  value: string
  change?: string
  color: string
  /** book = full listed surface; session = front expiry */
  scope?: 'book' | 'session'
  /** Expiry tag for session-scoped metrics (or ALL for book). */
  scopeLabel?: string
  /** Gamma Flip only: "ok" when a real cross exists, "no_cross" when unavailable. */
  status?: 'ok' | 'no_cross'
  /** Locked empty-state copy when status is no_cross (one-sided short/long/neutral). */
  note?: string
}

export type GammaFlipStatus = 'ok' | 'no_cross'

export type ReferenceMetric = AdvancedMetric

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

/** Full-surface (ALL) stats for the Regime desk footer. */
export type BookStats = {
  netGexUsd: number
  callOpenInterest: number
  putOpenInterest: number
  putCallOiRatio: number | null
  dvol: number | null
  /** short_rv / long_rv (1h closes); null when offline. */
  rvRatio?: number | null
  /** Expanding | Neutral | Compressing — light Regime confirmation only. */
  rvTrend?: 'Expanding' | 'Neutral' | 'Compressing' | null
  /** Annualized short-window realized vol (%). */
  rvShort?: number | null
  /** Annualized longer-window realized vol (%). */
  rvLong?: number | null
}

export type FlowHorizonAgreement = 'Aligned' | 'Mixed' | 'Fighting'

/**
 * Vol-compare series point (DVOL / RV / spread). Values are percent vol.
 */
export type VolSeriesPoint = {
  tsMs: number
  value: number
}

/**
 * Deribit DVOL vs Hyperliquid rolling RV for Regime lower zone.
 * Units: percent annualized vol. spread = DVOL − RV (percent points).
 * Does not alter main Dealer Γ / Flip / Net GEX / RV Trend scoring.
 */
export type VolCompare = {
  version?: string
  dvolSeries: VolSeriesPoint[]
  rvSeries: VolSeriesPoint[]
  spreadSeries: VolSeriesPoint[]
  meta?: {
    asOfMs?: number
    window?: string
    units?: 'percent' | string
    dvolSource?: string
    rvSource?: string
    spreadDefinition?: string
    showRvDefault?: boolean
    showSpreadDefault?: boolean
    dvolPointCount?: number
    rvPointCount?: number
    spreadPointCount?: number
    error?: string
  }
  error?: string | null
}

/**
 * 25Δ normalized skew for display-only Regime chips (Tail risk / term ATM).
 * Formula: (IV_25Δ_put − IV_25Δ_call) / ATM_IV. Positive = puts richer.
 * Does not alter Dealer Γ / Flip / Net GEX / RV Trend / Context scoring inputs.
 */
export type Skew25d = {
  formula?: string
  primaryTenor?: string | null
  /**
   * Normalized skew by tenor (decimal, e.g. 0.064 = +6.4% Glassnode-style).
   * Primary chip: 1m → 1w → 3m. Display multiplies by 100 for percent readout.
   */
  levels: {
    '1w': number | null
    '1m': number | null
    '3m': number | null
    '6m'?: number | null
  }
  series?: VolSeriesPoint[]
  /**
   * Per-tenor ATM IV in **percent** vol (converted from backend decimal).
   * Long-leg fallback for term structure when DVOL missing (1m).
   */
  atmIvPercent?: {
    '1w': number | null
    '1m': number | null
    '3m'?: number | null
  }
  /**
   * Front term leg: ATM IV on nearest listed expiry with DTE ≥ MIN_DTE (~0.35d).
   * Percent vol. Not the closest-to-7d tenor match.
   */
  frontAtm?: {
    atmIvPercent: number | null
    dteDays: number | null
    expiryTsMs: number | null
    status?: string | null
  } | null
  meta?: {
    asOfMs?: number
    chartTenor?: string | null
    chainPointCount?: number
    historySampleCount?: number
  }
  error?: string | null
}

/**
 * Secondary Regime analytics (Horizon polarity + DVOL/RV vol compare + 25Δ skew).
 * Does not alter main Dealer Γ / Flip / Net GEX / RV Trend.
 */
export type FlowRegime = {
  version?: string
  asOfMs?: number
  spot?: number | null
  deltaGexDefinition?: string
  historySampleCount?: number
  horizon: {
    fullScore: number | null
    sessionScore: number | null
    sessionNetGex: number | null
    agreement: FlowHorizonAgreement | null
    read: string | null
    sessionAvailable: boolean
    sessionAnchorTsMs: number | null
    /** ok | empty | pre_open | unavailable | error */
    sessionStatus?: string | null
    sessionReason?: string | null
  }
  /** DVOL time series + optional RV overlay + DVOL−RV spread. */
  volCompare?: VolCompare
  /** 25Δ normalized skew (display chips only). */
  skew25d?: Skew25d
}

export type TerminalSnapshot = {
  asOfUtc: string
  symbol: 'BTC'
  expiry: GexExpiry
  expiries?: GexExpiry[]
  /**
   * Materialize GEX spot (median option underlying). Used for Flip window /
   * Expected Move methodology — not the chart spot line when liveIndex is set.
   */
  spot: number
  /**
   * Live Deribit btc_usd settlement index (same feed as Price panel Index).
   * null/undefined when unavailable → charts/DIST fall back to ``spot``.
   */
  liveIndex?: number | null
  /** Production net GEX by strike (blocks + combos excluded). */
  gammaBars: GammaBar[]
  /**
   * ARCHIVED: secondary include-OTC bars (not used by the live desk).
   * See project/docs/archived_include_otc_prints.md
   */
  gammaBarsIncludeOtc?: GammaBar[]
  /** ARCHIVED: true when backend attached include-OTC profile. */
  includeOtcPrintsAvailable?: boolean
  totalNetGexUsd: number
  totalCallGexUsd: number
  totalPutGexUsd: number
  maxPositiveGammaStrike: number
  maxNegativeGammaStrike: number
  /**
   * Gamma Flip level (legacy alias of gammaFlip).
   * null when gammaFlipStatus === 'no_cross' — never a flattest-bar fake Flip.
   */
  zeroGamma: number | null
  /** Explicit Flip level from mass-valid cumulative zero-cross; null if none. */
  gammaFlip: number | null
  gammaFlipStatus: GammaFlipStatus
  /**
   * Locked empty-state copy when gammaFlipStatus === 'no_cross'
   * (e.g. "No local flip · GEX one-sided (short)"). Null/undefined when ok.
   */
  gammaFlipNote?: string | null
  marketSources: MarketSource[]
  bookStats?: BookStats
  /** Secondary Regime analytics (Horizon polarity + DVOL/RV vol compare). */
  flowRegime?: FlowRegime
  /** Sibling when materialize omitted flow_regime (API injects vol_compare live). */
  volCompare?: VolCompare
  levels: {
    allExpiry: LevelItem[]
    zeroDte: LevelItem[]
    /** Nearest weekly expiry Positive/Negative Gamma peaks. */
    weekly: LevelItem[]
    /** Nearest monthly (non-quarter last-Friday) peaks. */
    monthly: LevelItem[]
    /** Nearest quarterly last-Friday peaks. */
    quarterly: LevelItem[]
    /** Reference metrics (Gamma Flip, Max Pain, Expected Move). */
    reference: ReferenceMetric[]
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

  const callOi = allExpiry.gammaBars.reduce(
    (total, row) => total + estimateOpenInterest(row.strike, 'call', row.callGammaExposureUsd ?? 0),
    0,
  )
  const putOi = allExpiry.gammaBars.reduce(
    (total, row) => total + estimateOpenInterest(row.strike, 'put', row.putGammaExposureUsd ?? 0),
    0,
  )

  return {
    ...gexSnapshot,
    // Mock: live index equals GEX spot (no lag).
    liveIndex: spot,
    expiries,
    marketSources,
    bookStats: {
      netGexUsd: allExpiry.totalNetGexUsd,
      callOpenInterest: callOi,
      putOpenInterest: putOi,
      putCallOiRatio: callOi > 0 ? putOi / callOi : null,
      dvol: 48.6,
      rvRatio: 1.05,
      rvTrend: 'Neutral',
      rvShort: 42.0,
      rvLong: 40.0,
    },
    flowRegime: buildMockFlowRegime(allExpiry.totalNetGexUsd),
    levels: {
      allExpiry: [
        { label: 'Positive Gamma', strike: 81_500, distanceFromSpotPercent: percentFromSpot(81_500, spot), color: levelColors.positiveGamma },
        { label: 'Negative Gamma', strike: 68_000, distanceFromSpotPercent: percentFromSpot(68_000, spot), color: levelColors.negativeGamma },
      ],
      zeroDte: [
        { label: '0DTE Positive Gamma', strike: frontExpiry.maxPositiveGammaStrike, distanceFromSpotPercent: percentFromSpot(frontExpiry.maxPositiveGammaStrike, spot), color: levelColors.positiveGamma },
        { label: '0DTE Negative Gamma', strike: frontExpiry.maxNegativeGammaStrike, distanceFromSpotPercent: percentFromSpot(frontExpiry.maxNegativeGammaStrike, spot), color: levelColors.negativeGamma },
      ],
      ...buildMockTenorLevels(datedSnapshots, spot),
      reference: [
        (() => {
          // Same estimator as mock GEX / backend — no hardcoded far Flip.
          const flip = allExpiry.gammaFlip
          const status = allExpiry.gammaFlipStatus
          return {
            label: 'Gamma Flip' as const,
            value: flip != null ? `$${Math.round(flip).toLocaleString('en-US')}` : '—',
            change:
              flip != null ? formatSignedPercent(percentFromSpot(flip, spot)) : undefined,
            color: levelColors.gammaFlip,
            scope: 'book' as const,
            scopeLabel: 'ALL',
            status,
            note: status === 'no_cross' ? (allExpiry.gammaFlipNote ?? undefined) : undefined,
          }
        })(),
        {
          label: 'Max Pain',
          value: '$77,000',
          change: formatSignedPercent(percentFromSpot(77_000, spot)),
          color: '#d35fe9',
          scope: 'session',
          scopeLabel: frontExpiryId === 'ALL' ? undefined : frontExpiryId,
        },
        {
          label: 'Expected Move',
          value: '$73,500-$82,000',
          color: levelColors.expectedMove,
          scope: 'session',
          scopeLabel: frontExpiryId === 'ALL' ? undefined : frontExpiryId,
        },
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
  { name: 'Index (Deribit)', value: 77_041, note: 'settlement index', color: '#d35fe9' },
  { name: 'Perps (Hyperliquid)', value: 77_118, note: 'basis +77.00', color: '#27a7dc' },
]

/** Offline mock for Regime secondary modes (Horizon + DVOL/RV vol compare). */
function buildMockFlowRegime(netGexUsd: number): FlowRegime {
  const now = Date.now()
  const stepMs = 60 * 60_000
  const dvolSeries = Array.from({ length: 168 }, (_, i) => {
    const t = now - (167 - i) * stepMs
    const wave = Math.sin(i / 18) * 1.8 + Math.cos(i / 31) * 0.9
    return { tsMs: t, value: 42 + wave + (netGexUsd >= 0 ? 0 : 1.5) }
  })
  const rvSeries = dvolSeries.map((p, i) => ({
    tsMs: p.tsMs,
    value: p.value - 4.5 + Math.sin(i / 12) * 1.2,
  }))
  const spreadSeries = dvolSeries.map((p, i) => ({
    tsMs: p.tsMs,
    value: p.value - (rvSeries[i]?.value ?? p.value),
  }))

  return {
    version: 'flow_regime.v1',
    horizon: {
      fullScore: netGexUsd >= 0 ? 0.22 : -0.22,
      sessionScore: netGexUsd >= 0 ? 0.18 : 0.15,
      sessionNetGex: netGexUsd * 0.15,
      agreement: netGexUsd >= 0 ? 'Aligned' : 'Fighting',
      read: netGexUsd >= 0 ? null : 'Session long while full book short',
      sessionAvailable: true,
      sessionAnchorTsMs: Date.now() - 6 * 3600_000,
      sessionStatus: 'ok',
      sessionReason: null,
    },
    volCompare: {
      version: 'vol_compare.v1',
      dvolSeries,
      rvSeries,
      spreadSeries,
      meta: {
        asOfMs: now,
        window: '7d',
        units: 'percent',
        dvolSource: 'mock deribit dvol',
        rvSource: 'mock hyperliquid rolling 7d rv',
        spreadDefinition: 'DVOL − RV (percent points)',
        showRvDefault: true,
        showSpreadDefault: true,
        dvolPointCount: dvolSeries.length,
        rvPointCount: rvSeries.length,
        spreadPointCount: spreadSeries.length,
      },
    },
    // Display-only Tail / term chips — not used in Dealer Γ or Context math.
    skew25d: {
      formula: '(IV_25d_put - IV_25d_call) / ATM_IV',
      primaryTenor: '1m',
      levels: {
        '1w': 0.055,
        '1m': 0.072,
        '3m': 0.068,
      },
      series: Array.from({ length: 48 }, (_, i) => ({
        tsMs: now - (47 - i) * stepMs,
        value: 0.06 + Math.sin(i / 9) * 0.02,
      })),
      atmIvPercent: {
        '1w': 44.5,
        '1m': 47.8,
        '3m': 49.2,
      },
      frontAtm: {
        atmIvPercent: 42.1,
        dteDays: 0.9,
        expiryTsMs: now + 0.9 * 86_400_000,
        status: 'ok',
      },
      meta: {
        asOfMs: now,
        chartTenor: '1m',
        chainPointCount: 240,
        historySampleCount: 48,
      },
    },
  }
}

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

/** Nearest upcoming weekly / monthly / quarterly peak levels for the mock desk. */
function buildMockTenorLevels(
  datedSnapshots: MockGexSnapshot[],
  spot: number,
): Pick<TerminalSnapshot['levels'], 'weekly' | 'monthly' | 'quarterly'> {
  const pick = (kind: ExpiryKind): LevelItem[] => {
    const candidates = datedSnapshots
      .filter((snapshot) => snapshot.expiry !== 'ALL' && getExpiryKind(snapshot.expiry) === kind)
      .map((snapshot) => {
        const { hoursToExpiry } = getExpiryTime(snapshot.expiry)
        return { snapshot, hoursToExpiry }
      })
      .filter((entry) => entry.hoursToExpiry > 0)
      .sort((a, b) => a.hoursToExpiry - b.hoursToExpiry)

    const nearest = candidates[0]?.snapshot
    if (!nearest) return []

    return [
      {
        label: 'Positive Gamma',
        strike: nearest.maxPositiveGammaStrike,
        distanceFromSpotPercent: percentFromSpot(nearest.maxPositiveGammaStrike, spot),
        color: levelColors.positiveGamma,
        scopeLabel: nearest.expiry,
      },
      {
        label: 'Negative Gamma',
        strike: nearest.maxNegativeGammaStrike,
        distanceFromSpotPercent: percentFromSpot(nearest.maxNegativeGammaStrike, spot),
        color: levelColors.negativeGamma,
        scopeLabel: nearest.expiry,
      },
    ]
  }

  return {
    weekly: pick('weekly'),
    monthly: pick('monthly'),
    quarterly: pick('quarterly'),
  }
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

/** Distance convention (Levels + rankings): (level − spot) / spot × 100. */
function percentFromSpot(strike: number, spot: number) {
  return ((strike - spot) / spot) * 100
}

/**
 * Trading UI spot: live Deribit btc_usd when present, else materialize GEX spot.
 * Chart spot lines, Regime corridor marker, and DIST % recompute use this.
 * GEX bar heights / Flip level stay on snapshot methodology (not revalued here).
 */
export function getDisplaySpot(
  snapshot: Pick<TerminalSnapshot, 'spot' | 'liveIndex'>,
): number {
  const live = snapshot.liveIndex
  if (live != null && Number.isFinite(live) && live > 0) {
    return live
  }
  return snapshot.spot
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
