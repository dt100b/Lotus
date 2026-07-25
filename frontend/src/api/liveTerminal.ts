import type {
  AdvancedMetric,
  BookStats,
  ExpiryContribution,
  ExpiryKind,
  ExpiryPositioningEvent,
  FlowHorizonAgreement,
  FlowRegime,
  GexHistoryPoint,
  GammaBar,
  LevelItem,
  MarketSource,
  RankingRow,
  Skew25d,
  TerminalSnapshot,
  VolCompare,
  VolSeriesPoint,
} from '@/data/mockTerminal'
import type { GexExpiry } from '@/api/mockGexData'
import { parseDeribitExpiry } from '@/api/deribitExpiries'

type BackendTerminalSnapshot = {
  as_of_utc: string
  symbol: 'BTC'
  expiry: GexExpiry
  expiries?: GexExpiry[]
  spot: number
  /** Live Deribit btc_usd; null when feed unavailable. */
  live_index?: number | null
  gamma_bars: BackendGammaBar[]
  /** ARCHIVED secondary include-OTC profile (optional; not used by live desk). */
  gamma_bars_include_otc?: BackendGammaBar[]
  include_otc_prints_available?: boolean
  ledger_policy_default?: string
  total_net_gex_usd: number
  total_call_gex_usd: number
  total_put_gex_usd: number
  max_positive_gamma_strike: number
  max_negative_gamma_strike: number
  /** Legacy alias of gamma_flip (null when no mass-valid cross). */
  zero_gamma?: number | null
  /** Real cumulative zero-cross Flip only; null when status is no_cross. */
  gamma_flip?: number | null
  gamma_flip_status?: 'ok' | 'no_cross'
  /** Locked empty-state copy when status is no_cross; null when ok. */
  gamma_flip_note?: string | null
  market_sources?: BackendMarketSource[]
  book_stats?: {
    net_gex_usd: number
    call_open_interest: number
    put_open_interest: number
    put_call_oi_ratio: number | null
    dvol: number | null
    rv_ratio?: number | null
    rv_trend?: 'Expanding' | 'Neutral' | 'Compressing' | null
    rv_short?: number | null
    rv_long?: number | null
  }
  levels: {
    all_expiry: BackendLevelItem[]
    zero_dte: BackendLevelItem[]
    weekly?: BackendLevelItem[]
    monthly?: BackendLevelItem[]
    quarterly?: BackendLevelItem[]
    /** Current API key for Gamma Flip / Max Pain / Expected Move. */
    reference?: BackendAdvancedMetric[]
    /** Legacy key — still accepted so a stale API process does not hard-crash the UI. */
    advanced?: BackendAdvancedMetric[]
  }
  rankings: {
    all_expiry: BackendRankingRow[]
    selected_expiry: BackendRankingRow[]
    zero_dte: BackendRankingRow[]
  }
  expiry_events: BackendExpiryEvent[]
  /** Secondary Regime analytics (Horizon polarity + DVOL/RV vol compare). */
  flow_regime?: BackendFlowRegime
  /** Sibling when flow_regime is absent from materialize. */
  vol_compare?: BackendVolCompare
}

type BackendVolSeriesPoint = { ts_ms?: number; value?: number }

type BackendVolCompare = {
  version?: string
  dvol_series?: BackendVolSeriesPoint[]
  rv_series?: BackendVolSeriesPoint[]
  spread_series?: BackendVolSeriesPoint[]
  error?: string | null
  meta?: {
    as_of_ms?: number
    window?: string
    units?: string
    dvol_source?: string
    rv_source?: string
    spread_definition?: string
    show_rv_default?: boolean
    show_spread_default?: boolean
    dvol_point_count?: number
    rv_point_count?: number
    spread_point_count?: number
    error?: string
  }
}

type BackendSkew25d = {
  formula?: string
  primary_tenor?: string | null
  levels?: {
    '1w'?: number | null
    '1m'?: number | null
    '3m'?: number | null
    '6m'?: number | null
  }
  /** Nearest-expiry front ATM (decimal vol) for term-structure chip. */
  front?: {
    status?: string
    atm_iv?: number | null
    dte_days?: number | null
    expiry_ts_ms?: number | null
  } | null
  series?: BackendVolSeriesPoint[]
  meta?: {
    as_of_ms?: number
    chart_tenor?: string | null
    chain_point_count?: number
    history_sample_count?: number
    front_definition?: string
    primary_tenor_preference?: string[]
    /** Per-tenor detail from pipeline.skew_25d (includes atm_iv as decimal). */
    detail?: Record<
      string,
      {
        status?: string
        atm_iv?: number | null
        value?: number | null
        dte_days?: number | null
        expiry_ts_ms?: number | null
      }
    >
  }
  error?: string | null
}

type BackendFlowRegime = {
  version?: string
  as_of_ms?: number
  spot?: number | null
  delta_gex_definition?: string
  history_sample_count?: number
  horizon?: {
    full_score?: number | null
    session_score?: number | null
    session_net_gex?: number | null
    agreement?: FlowHorizonAgreement | null
    read?: string | null
    session_available?: boolean
    session_anchor_ts_ms?: number | null
    session_status?: string | null
    session_reason?: string | null
  }
  vol_compare?: BackendVolCompare
  skew_25d?: BackendSkew25d
}

type BackendGammaBar = {
  strike: number
  gamma_exposure_usd: number
  call_gamma_exposure_usd?: number
  put_gamma_exposure_usd?: number
  net_gamma_exposure_usd?: number
}

type BackendMarketSource = {
  name: string
  value: number
  note: string
  color: string
}

type BackendLevelItem = {
  label: string
  strike: number
  distance_from_spot_percent?: number
  color: string
  net_gex?: number
  scope_label?: string
}

type BackendAdvancedMetric = {
  label: string
  value: string
  change?: string
  color: string
  scope?: 'book' | 'session'
  scope_label?: string
  /** Gamma Flip: "ok" | "no_cross". */
  status?: 'ok' | 'no_cross'
  /** Gamma Flip empty-state copy when status is no_cross. */
  note?: string
}

type BackendRankingRow = {
  rank: number
  previous_gamma_exposure_usd?: number
  previous_call_gamma_exposure_usd?: number
  previous_put_gamma_exposure_usd?: number
  strike: number
  distance_from_spot_percent: number
  gamma_exposure_usd: number
  call_gamma_exposure_usd: number
  put_gamma_exposure_usd: number
  open_interest: number
  call_open_interest: number
  put_open_interest: number
  previous_open_interest?: number
  previous_call_open_interest?: number
  previous_put_open_interest?: number
  gex_history: BackendGexHistoryPoint[]
  expiry_contributions: BackendExpiryContribution[]
}

type BackendGexHistoryPoint = {
  label: string
  net_gex_usd: number
  call_gex_usd: number
  put_gex_usd: number
}

type BackendExpiryContribution = {
  expiry: GexExpiry
  gamma_exposure_usd: number
  call_gamma_exposure_usd: number
  put_gamma_exposure_usd: number
  open_interest: number
  call_open_interest: number
  put_open_interest: number
}

type BackendExpiryEvent = {
  expiry: GexExpiry
  kind: ExpiryKind
  days_to_expiry: number
  hours_to_expiry: number
  expiring_open_interest: number
  expiring_notional_usd: number
  open_interest_share_percent: number
  abs_gamma_exposure_usd: number
  near_spot_open_interest: number
  near_spot_open_interest_share_percent: number
  near_spot_gamma_exposure_usd: number
  size_score: number
  concentration_score: number
  urgency_score: number
  importance_score: number
  top_strikes: BackendExpiryStrike[]
}

type BackendExpiryStrike = {
  strike: number
  distance_from_spot_percent: number
  gamma_exposure_usd: number
  call_gamma_exposure_usd: number
  put_gamma_exposure_usd: number
  open_interest: number
  call_open_interest: number
  put_open_interest: number
  open_interest_share_percent: number
}

const apiBaseUrl = import.meta.env.VITE_LOTUS_API_BASE_URL
  ?? (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')

/**
 * Live API keys expiries as ISO dates (YYYY-MM-DD). The mock calendar and some UI
 * labels use Deribit form (19JUL26) — normalize before the request.
 */
export function normalizeLiveExpiry(expiry: string): string {
  if (!expiry || expiry === 'ALL') return 'ALL'

  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(expiry)
  if (iso) return iso[1]

  const deribit = parseDeribitExpiry(expiry)
  if (deribit) {
    const year = deribit.getUTCFullYear()
    const month = String(deribit.getUTCMonth() + 1).padStart(2, '0')
    const day = String(deribit.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  return expiry
}

export async function getLiveTerminalSnapshot(expiry: GexExpiry = 'ALL'): Promise<TerminalSnapshot> {
  const requested = normalizeLiveExpiry(expiry)
  try {
    return await fetchTerminalSnapshot(requested)
  } catch (error) {
    // Stale pane/global expiry (rolled off the book) or calendar day with no listed options.
    if (requested !== 'ALL' && isSnapshotNotFound(error)) {
      return await fetchTerminalSnapshot('ALL')
    }
    throw error
  }
}

async function fetchTerminalSnapshot(expiry: string): Promise<TerminalSnapshot> {
  const url = new URL('/api/v1/terminal-snapshot', apiBaseUrl || window.location.origin)
  url.searchParams.set('expiry', expiry)
  const response = await fetch(url)

  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json() as { detail?: unknown }
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      // ignore non-JSON error bodies
    }
    const suffix = detail ? ` (${detail})` : ''
    throw new Error(`Terminal snapshot request failed: ${response.status}${suffix}`)
  }

  return toTerminalSnapshot(await response.json() as BackendTerminalSnapshot)
}

function isSnapshotNotFound(error: unknown): boolean {
  return error instanceof Error && /\b404\b/.test(error.message)
}

function toTerminalSnapshot(snapshot: BackendTerminalSnapshot): TerminalSnapshot {
  const levels = snapshot.levels ?? { all_expiry: [], zero_dte: [], reference: [] }
  const referenceMetrics = levels.reference ?? levels.advanced ?? []
  const rankings = snapshot.rankings ?? {
    all_expiry: [],
    selected_expiry: [],
    zero_dte: [],
  }

  const gammaBarsIncludeOtc = Array.isArray(snapshot.gamma_bars_include_otc)
    ? snapshot.gamma_bars_include_otc.map(toGammaBar)
    : undefined
  const includeOtcPrintsAvailable =
    Boolean(snapshot.include_otc_prints_available)
    || Boolean(gammaBarsIncludeOtc && gammaBarsIncludeOtc.length > 0)

  return {
    asOfUtc: snapshot.as_of_utc,
    symbol: snapshot.symbol,
    expiry: snapshot.expiry,
    expiries: snapshot.expiries ?? [],
    spot: snapshot.spot,
    liveIndex: resolveLiveIndex(snapshot),
    gammaBars: (snapshot.gamma_bars ?? []).map(toGammaBar),
    gammaBarsIncludeOtc,
    includeOtcPrintsAvailable,
    totalNetGexUsd: snapshot.total_net_gex_usd,
    totalCallGexUsd: snapshot.total_call_gex_usd,
    totalPutGexUsd: snapshot.total_put_gex_usd,
    maxPositiveGammaStrike: snapshot.max_positive_gamma_strike,
    maxNegativeGammaStrike: snapshot.max_negative_gamma_strike,
    ...(() => {
      const status = snapshot.gamma_flip_status
        ?? (snapshot.gamma_flip != null || snapshot.zero_gamma != null ? 'ok' : 'no_cross')
      const level =
        status === 'no_cross'
          ? null
          : finiteOrNull(snapshot.gamma_flip ?? snapshot.zero_gamma)
      return {
        zeroGamma: level,
        gammaFlip: level,
        gammaFlipStatus: status as 'ok' | 'no_cross',
        gammaFlipNote:
          status === 'no_cross'
            ? (snapshot.gamma_flip_note
              ?? referenceMetrics.find((m) => m.label.includes('Gamma Flip') || m.label === 'Flip')?.note
              ?? null)
            : null,
      }
    })(),
    marketSources: (snapshot.market_sources ?? []).map(toMarketSource),
    bookStats: snapshot.book_stats ? toBookStats(snapshot.book_stats) : undefined,
    flowRegime: snapshot.flow_regime ? toFlowRegime(snapshot.flow_regime) : undefined,
    volCompare: snapshot.vol_compare
      ? toVolCompare(snapshot.vol_compare)
      : snapshot.flow_regime?.vol_compare
        ? toVolCompare(snapshot.flow_regime.vol_compare)
        : undefined,
    levels: {
      allExpiry: (levels.all_expiry ?? []).map(toLevelItem),
      zeroDte: (levels.zero_dte ?? []).map(toLevelItem),
      weekly: (levels.weekly ?? []).map(toLevelItem),
      monthly: (levels.monthly ?? []).map(toLevelItem),
      quarterly: (levels.quarterly ?? []).map(toLevelItem),
      reference: referenceMetrics.map(toAdvancedMetric),
    },
    rankings: {
      allExpiry: (rankings.all_expiry ?? []).map(toRankingRow),
      selectedExpiry: (rankings.selected_expiry ?? []).map(toRankingRow),
      zeroDte: (rankings.zero_dte ?? []).map(toRankingRow),
    },
    expiryEvents: (snapshot.expiry_events ?? []).map(toExpiryEvent),
  }
}

function toGammaBar(row: BackendGammaBar): GammaBar {
  return {
    strike: row.strike,
    gammaExposureUsd: row.gamma_exposure_usd,
    callGammaExposureUsd: row.call_gamma_exposure_usd,
    putGammaExposureUsd: row.put_gamma_exposure_usd,
    netGammaExposureUsd: row.net_gamma_exposure_usd,
  }
}

function toMarketSource(source: BackendMarketSource): MarketSource {
  return source
}

function toBookStats(stats: NonNullable<BackendTerminalSnapshot['book_stats']>): BookStats {
  return {
    netGexUsd: stats.net_gex_usd,
    callOpenInterest: stats.call_open_interest,
    putOpenInterest: stats.put_open_interest,
    putCallOiRatio: stats.put_call_oi_ratio,
    dvol: stats.dvol,
    rvRatio: stats.rv_ratio ?? null,
    rvTrend: stats.rv_trend ?? null,
    rvShort: stats.rv_short ?? null,
    rvLong: stats.rv_long ?? null,
  }
}

const EMPTY_VOL_COMPARE: VolCompare = {
  dvolSeries: [],
  rvSeries: [],
  spreadSeries: [],
  meta: {
    units: 'percent',
    window: '7d',
    showRvDefault: true,
    showSpreadDefault: true,
  },
}

function toVolSeries(raw?: BackendVolSeriesPoint[] | null): VolSeriesPoint[] {
  if (!raw?.length) return []
  return raw
    .map((p) => {
      const tsMs = Number(p.ts_ms)
      const value = Number(p.value)
      if (!Number.isFinite(tsMs) || tsMs <= 0 || !Number.isFinite(value)) return null
      return { tsMs, value }
    })
    .filter((p): p is VolSeriesPoint => p !== null)
}

function toVolCompare(raw?: BackendVolCompare | null): VolCompare {
  if (!raw) return EMPTY_VOL_COMPARE
  const dvolSeries = toVolSeries(raw.dvol_series)
  const rvSeries = toVolSeries(raw.rv_series)
  const spreadSeries = toVolSeries(raw.spread_series)
  return {
    version: raw.version,
    dvolSeries,
    rvSeries,
    spreadSeries,
    error: raw.error ?? raw.meta?.error ?? null,
    meta: {
      asOfMs: raw.meta?.as_of_ms,
      window: raw.meta?.window ?? '7d',
      units: raw.meta?.units ?? 'percent',
      dvolSource: raw.meta?.dvol_source,
      rvSource: raw.meta?.rv_source,
      spreadDefinition: raw.meta?.spread_definition,
      showRvDefault: raw.meta?.show_rv_default ?? true,
      showSpreadDefault: raw.meta?.show_spread_default ?? true,
      dvolPointCount: raw.meta?.dvol_point_count ?? dvolSeries.length,
      rvPointCount: raw.meta?.rv_point_count ?? rvSeries.length,
      spreadPointCount: raw.meta?.spread_point_count ?? spreadSeries.length,
      error: raw.meta?.error,
    },
  }
}

function toFlowRegime(raw: BackendFlowRegime): FlowRegime {
  return {
    version: raw.version,
    asOfMs: raw.as_of_ms,
    spot: raw.spot ?? null,
    deltaGexDefinition: raw.delta_gex_definition,
    historySampleCount: raw.history_sample_count,
    horizon: {
      fullScore: raw.horizon?.full_score ?? null,
      sessionScore: raw.horizon?.session_score ?? null,
      sessionNetGex: raw.horizon?.session_net_gex ?? null,
      agreement: raw.horizon?.agreement ?? null,
      read: raw.horizon?.read ?? null,
      sessionAvailable: Boolean(raw.horizon?.session_available),
      sessionAnchorTsMs: raw.horizon?.session_anchor_ts_ms ?? null,
      sessionStatus: raw.horizon?.session_status ?? null,
      sessionReason: raw.horizon?.session_reason ?? null,
    },
    volCompare: raw.vol_compare ? toVolCompare(raw.vol_compare) : undefined,
    skew25d: raw.skew_25d ? toSkew25d(raw.skew_25d) : undefined,
  }
}

/**
 * Map pipeline skew_25d → FE display shape.
 * ATM IV in meta.detail / front is decimal vol; convert to percent for term chip.
 * Levels stay as normalized skew (decimal, e.g. 0.064). Regime chip multiplies by 100
 * for Glassnode-style percent readout only — storage/mapping is unchanged.
 */
function toSkew25d(raw: BackendSkew25d): Skew25d {
  const levels = raw.levels ?? {}
  const detail = raw.meta?.detail ?? {}
  const atmFromDetail = (tenor: string): number | null => {
    const entry = detail[tenor]
    if (!entry || entry.status !== 'ok') return null
    return decimalVolToPercent(entry.atm_iv)
  }

  const frontRaw = raw.front
  const frontAtm =
    frontRaw && frontRaw.status === 'ok'
      ? {
          atmIvPercent: decimalVolToPercent(frontRaw.atm_iv),
          dteDays: finiteOrNull(frontRaw.dte_days),
          expiryTsMs:
            frontRaw.expiry_ts_ms != null && Number.isFinite(Number(frontRaw.expiry_ts_ms))
              ? Number(frontRaw.expiry_ts_ms)
              : null,
          status: frontRaw.status ?? null,
        }
      : frontRaw
        ? {
            atmIvPercent: null,
            dteDays: finiteOrNull(frontRaw.dte_days),
            expiryTsMs:
              frontRaw.expiry_ts_ms != null && Number.isFinite(Number(frontRaw.expiry_ts_ms))
                ? Number(frontRaw.expiry_ts_ms)
                : null,
            status: frontRaw.status ?? null,
          }
        : null

  return {
    formula: raw.formula,
    primaryTenor: raw.primary_tenor ?? raw.meta?.chart_tenor ?? null,
    levels: {
      // Normalized skew — pass through as-is (do NOT /100 or *100).
      '1w': finiteOrNull(levels['1w']),
      '1m': finiteOrNull(levels['1m']),
      '3m': finiteOrNull(levels['3m']),
      ...(levels['6m'] != null ? { '6m': finiteOrNull(levels['6m']) } : {}),
    },
    series: toVolSeries(raw.series),
    atmIvPercent: {
      '1w': atmFromDetail('1w'),
      '1m': atmFromDetail('1m'),
      '3m': atmFromDetail('3m'),
    },
    frontAtm,
    meta: {
      asOfMs: raw.meta?.as_of_ms,
      chartTenor: raw.meta?.chart_tenor ?? raw.primary_tenor ?? null,
      chainPointCount: raw.meta?.chain_point_count,
      historySampleCount: raw.meta?.history_sample_count,
    },
    error: raw.error ?? null,
  }
}

/** Backend ATM is decimal vol (0.48); percent-like values (>3) left as-is. */
function decimalVolToPercent(raw: number | null | undefined): number | null {
  const atm = Number(raw)
  if (!Number.isFinite(atm) || atm <= 0) return null
  return atm > 3 ? atm : atm * 100
}

function finiteOrNull(value: number | null | undefined): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Prefer dedicated live_index; fall back to Price panel Index (Deribit) source. */
function resolveLiveIndex(snapshot: BackendTerminalSnapshot): number | null {
  const direct = finiteOrNull(snapshot.live_index)
  if (direct != null && direct > 0) return direct

  for (const source of snapshot.market_sources ?? []) {
    if (source.name === 'Index (Deribit)') {
      const value = finiteOrNull(source.value)
      if (value != null && value > 0) return value
    }
  }
  return null
}

function toLevelItem(item: BackendLevelItem): LevelItem {
  return {
    label: item.label,
    strike: item.strike,
    distanceFromSpotPercent: item.distance_from_spot_percent,
    color: item.color,
    netGex: item.net_gex,
    scopeLabel: item.scope_label,
  }
}

function toAdvancedMetric(metric: BackendAdvancedMetric): AdvancedMetric {
  return {
    label: metric.label,
    value: metric.value,
    change: metric.change,
    color: metric.color,
    scope: metric.scope,
    scopeLabel: metric.scope_label,
    status: metric.status,
    note: metric.note,
  }
}

function toRankingRow(row: BackendRankingRow): RankingRow {
  return {
    rank: row.rank,
    previousGammaExposureUsd: row.previous_gamma_exposure_usd,
    previousCallGammaExposureUsd: row.previous_call_gamma_exposure_usd,
    previousPutGammaExposureUsd: row.previous_put_gamma_exposure_usd,
    strike: row.strike,
    distanceFromSpotPercent: row.distance_from_spot_percent,
    gammaExposureUsd: row.gamma_exposure_usd,
    callGammaExposureUsd: row.call_gamma_exposure_usd,
    putGammaExposureUsd: row.put_gamma_exposure_usd,
    openInterest: row.open_interest,
    callOpenInterest: row.call_open_interest,
    putOpenInterest: row.put_open_interest,
    previousOpenInterest: row.previous_open_interest,
    previousCallOpenInterest: row.previous_call_open_interest,
    previousPutOpenInterest: row.previous_put_open_interest,
    gexHistory: row.gex_history.map(toGexHistoryPoint),
    expiryContributions: row.expiry_contributions.map(toExpiryContribution),
  }
}

function toGexHistoryPoint(point: BackendGexHistoryPoint): GexHistoryPoint {
  return {
    label: point.label,
    netGexUsd: point.net_gex_usd,
    callGexUsd: point.call_gex_usd,
    putGexUsd: point.put_gex_usd,
  }
}

function toExpiryContribution(contribution: BackendExpiryContribution): ExpiryContribution {
  return {
    expiry: contribution.expiry,
    gammaExposureUsd: contribution.gamma_exposure_usd,
    callGammaExposureUsd: contribution.call_gamma_exposure_usd,
    putGammaExposureUsd: contribution.put_gamma_exposure_usd,
    openInterest: contribution.open_interest,
    callOpenInterest: contribution.call_open_interest,
    putOpenInterest: contribution.put_open_interest,
  }
}

function toExpiryEvent(event: BackendExpiryEvent): ExpiryPositioningEvent {
  return {
    expiry: event.expiry,
    kind: event.kind,
    daysToExpiry: event.days_to_expiry,
    hoursToExpiry: event.hours_to_expiry,
    expiringOpenInterest: event.expiring_open_interest,
    expiringNotionalUsd: event.expiring_notional_usd,
    openInterestSharePercent: event.open_interest_share_percent,
    absGammaExposureUsd: event.abs_gamma_exposure_usd,
    nearSpotOpenInterest: event.near_spot_open_interest,
    nearSpotOpenInterestSharePercent: event.near_spot_open_interest_share_percent,
    nearSpotGammaExposureUsd: event.near_spot_gamma_exposure_usd,
    sizeScore: event.size_score,
    concentrationScore: event.concentration_score,
    urgencyScore: event.urgency_score,
    importanceScore: event.importance_score,
    topStrikes: event.top_strikes.map((strike) => ({
      strike: strike.strike,
      distanceFromSpotPercent: strike.distance_from_spot_percent,
      gammaExposureUsd: strike.gamma_exposure_usd,
      callGammaExposureUsd: strike.call_gamma_exposure_usd,
      putGammaExposureUsd: strike.put_gamma_exposure_usd,
      openInterest: strike.open_interest,
      callOpenInterest: strike.call_open_interest,
      putOpenInterest: strike.put_open_interest,
      openInterestSharePercent: strike.open_interest_share_percent,
    })),
  }
}
