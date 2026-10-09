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
  SkewTenor,
  TerminalSnapshot,
  VolCompare,
  VolSeriesPoint,
  VolSurface,
} from '@/data/mockTerminal'
import type { GexExpiry } from '@/api/mockGexData'
import { parseDeribitExpiry } from '@/api/deribitExpiries'
import { isScheduledCaptureValid, isAtmCurveCurrent, isSurfaceCurrent } from '@/lib/surfaceInspection'

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
  /** Legacy alias of hvl / gamma_flip (null when no mass-valid cross). */
  zero_gamma?: number | null
  /** HVL aliases: real cumulative zero-cross only; null when status is no_cross. */
  hvl?: number | null
  hvl_status?: 'ok' | 'no_cross'
  hvl_note?: string | null
  hvl_expiry?: string | null
  hvl_by_expiry?: Record<string, { level?: number | null; status?: string; note?: string | null }>
  hvl_book?: { level?: number | null; status?: string; note?: string | null }
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
    /** 5-way RV momentum; legacy Neutral/Compressing still accepted. */
    rv_trend?:
      | 'Accelerating'
      | 'Expanding'
      | 'Stable'
      | 'Contracting'
      | 'Collapsing'
      | 'Neutral'
      | 'Compressing'
      | null
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

type BackendVolSeriesPoint = { ts_ms?: number; value?: number; gap_before?: boolean }

type BackendVolCompare = {
  version?: string
  dvol_series?: BackendVolSeriesPoint[]
  /** Primary RV30 series. */
  rv_series?: BackendVolSeriesPoint[]
  /** Rolling 24h RV for the RV-trend view. */
  rv1_series?: BackendVolSeriesPoint[]
  /** Optional secondary RV7 overlay. */
  rv7_series?: BackendVolSeriesPoint[]
  spread_series?: BackendVolSeriesPoint[]
  error?: string | null
  meta?: {
    as_of_ms?: number
    window?: string
    units?: string
    dvol_source?: string
    rv_source?: string
    rv30_source?: string
    rv1_source?: string
    rv7_source?: string
    spread_definition?: string
    primary_pair?: string
    chart_title?: string
    show_rv_default?: boolean
    show_spread_default?: boolean
    dvol_point_count?: number
    rv_point_count?: number
    rv1_point_count?: number
    rv7_point_count?: number
    spread_point_count?: number
    error?: string
  }
}

type BackendTermAtm = {
  status?: string
  method?: string | null
  atm_iv?: number | null
  dte_days?: number | null
  target_days?: number | null
  expiry_ts_ms?: number | null
  lower_expiry_ts_ms?: number | null
  lower_dte_days?: number | null
  upper_expiry_ts_ms?: number | null
  upper_dte_days?: number | null
  interpolation_weight?: number | null
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
  /** Exact constant-maturity ATM curve (decimal vol). */
  term?: Partial<Record<'1d' | SkewTenor, BackendTermAtm>>
  /** Backward-compatible alias for term.1d. */
  front?: BackendTermAtm | null
  series?: BackendVolSeriesPoint[]
  series_by_tenor?: Partial<Record<SkewTenor, BackendVolSeriesPoint[]>>
  meta?: {
    as_of_ms?: number
    chart_tenor?: string | null
    chain_point_count?: number
    history_sample_count?: number
    front_definition?: string
    primary_tenor_preference?: string[]
    /** Per-tenor detail from pipeline.skew_25d (includes atm_iv as decimal). */
    detail?: Record<string, BackendTermAtm & { value?: number | null }>
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
  vol_surface?: BackendVolSurface
  atm_term_curve?: BackendVolSurface
  skew_surface?: BackendVolSurface
}

type BackendVolSurfaceTenor = {
  atm_bid_iv_percent?: number | null
  atm_ask_iv_percent?: number | null
  atm_mid_iv_percent?: number | null
  midpoint_validation_reasons?: string[]
  tenor?: string
  status?: string | null
  atm_iv_percent?: number | null
  skew_25_normalized?: number | null
  skew_10_normalized?: number | null
  tail_gap_vol_points?: number | null
  rr_25_vol_points?: number | null
  metric_reasons?: Record<string,string[]>
  calendar_ok?: boolean | null
  validation_reasons?: string[]
  method?: string | null
  lower_expiry_ts_ms?: number | null
  upper_expiry_ts_ms?: number | null
  lower_dte_days?: number | null
  upper_dte_days?: number | null
}

type BackendVolSurface = {
  refresh_status?: { state?: string }
  capture_validated?: boolean
  next_capture_ms?: number
  capture_due_ms?: number
  lookbacks?: Array<{ days: number; as_of_ms: number; term_structure: BackendVolSurfaceTenor[] }>
  version?: string
  as_of_ms?: number
  valid_until_ms?: number
  history?: Record<string, Record<string, BackendVolSeriesPoint[]>>
  term_structure?: BackendVolSurfaceTenor[]
  listed_expiries?: Array<{
    expiry_ts_ms?: number
    dte_days?: number
    status?: string | null
    atm_iv_percent?: number | null
    forward_usd?: number | null
    lower_strike?: number | null
    upper_strike?: number | null
    validation_reasons?: string[]
  }>
  atm_vs_rv?: {
    atm_iv_percent?: number | null
    rv_percent?: number | null
    spread_percent?: number | null
    rv_estimator?: string | null
  }
}

type BackendGammaBar = {
  strike: number
  gamma_exposure_usd: number
  call_gamma_exposure_usd?: number
  put_gamma_exposure_usd?: number
  net_gamma_exposure_usd?: number
  delta_exposure_usd?: number
  call_delta_exposure_usd?: number
  put_delta_exposure_usd?: number
  net_delta_exposure_usd?: number
  open_interest?: number
  call_open_interest?: number
  put_open_interest?: number
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
      const status = snapshot.hvl_status
        ?? snapshot.gamma_flip_status
        ?? (snapshot.hvl != null || snapshot.gamma_flip != null || snapshot.zero_gamma != null
          ? 'ok'
          : 'no_cross')
      const level =
        status === 'no_cross'
          ? null
          : finiteOrNull(snapshot.hvl ?? snapshot.gamma_flip ?? snapshot.zero_gamma)
      return {
        zeroGamma: level,
        gammaFlip: level,
        gammaFlipStatus: status as 'ok' | 'no_cross',
        gammaFlipNote:
          status === 'no_cross'
            ? (snapshot.hvl_note
              ?? snapshot.gamma_flip_note
              ?? referenceMetrics.find((m) =>
                m.label === 'HVL'
                || m.label.includes('Zero Gamma')
                || m.label.includes('Gamma Flip')
                || m.label === 'Flip'
                || m.label === 'ZG'
              )?.note
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
    deltaExposureUsd: row.delta_exposure_usd,
    callDeltaExposureUsd: row.call_delta_exposure_usd,
    putDeltaExposureUsd: row.put_delta_exposure_usd,
    netDeltaExposureUsd: row.net_delta_exposure_usd,
    openInterest: row.open_interest,
    callOpenInterest: row.call_open_interest,
    putOpenInterest: row.put_open_interest,
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
    window: '365d',
    chartTitle: 'IV vs RV',
    primaryPair: 'DVOL (30d) vs RV30',
    showRvDefault: true,
    showSpreadDefault: true,
  },
}

function toVolSeries(raw?: BackendVolSeriesPoint[] | null): VolSeriesPoint[] {
  if (!raw?.length) return []
  return raw
    .map((p) => {
      if (p.value == null) return null
      const tsMs = Number(p.ts_ms)
      const value = Number(p.value)
      if (!Number.isFinite(tsMs) || tsMs <= 0 || !Number.isFinite(value)) return null
      return { tsMs, value, ...(p.gap_before ? {gapBefore:true} : {}) }
    })
    .filter((p): p is VolSeriesPoint => p !== null)
}

function toVolCompare(raw?: BackendVolCompare | null): VolCompare {
  if (!raw) return EMPTY_VOL_COMPARE
  const dvolSeries = toVolSeries(raw.dvol_series)
  const rvSeries = toVolSeries(raw.rv_series)
  const rv1Series = toVolSeries(raw.rv1_series)
  const rv7Series = toVolSeries(raw.rv7_series)
  const spreadSeries = toVolSeries(raw.spread_series)
  return {
    version: raw.version,
    dvolSeries,
    rvSeries,
    ...(rv1Series.length > 0 ? { rv1Series } : {}),
    ...(rv7Series.length > 0 ? { rv7Series } : {}),
    spreadSeries,
    error: raw.error ?? raw.meta?.error ?? null,
    meta: {
      asOfMs: raw.meta?.as_of_ms,
      window: raw.meta?.window ?? '365d',
      units: raw.meta?.units ?? 'percent',
      dvolSource: raw.meta?.dvol_source,
      rvSource: raw.meta?.rv_source ?? raw.meta?.rv30_source,
      rv30Source: raw.meta?.rv30_source ?? raw.meta?.rv_source,
      rv1Source: raw.meta?.rv1_source,
      rv7Source: raw.meta?.rv7_source,
      spreadDefinition: raw.meta?.spread_definition ?? 'DVOL − RV30 (percent points)',
      primaryPair: raw.meta?.primary_pair ?? 'DVOL (30d) vs RV30',
      chartTitle: 'IV vs RV',
      showRvDefault: raw.meta?.show_rv_default ?? true,
      showSpreadDefault: raw.meta?.show_spread_default ?? true,
      dvolPointCount: raw.meta?.dvol_point_count ?? dvolSeries.length,
      rvPointCount: raw.meta?.rv_point_count ?? rvSeries.length,
      rv1PointCount: raw.meta?.rv1_point_count ?? rv1Series.length,
      rv7PointCount: raw.meta?.rv7_point_count ?? rv7Series.length,
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
    volSurface: raw.vol_surface ? toVolSurface(raw.vol_surface) : undefined,
    atmTermCurve: raw.atm_term_curve ? toVolSurface(raw.atm_term_curve, 'atm_term_curve.v1') : undefined,
    skewSurface: raw.skew_surface ? toVolSurface(raw.skew_surface, 'local_delta_skew.v1') : undefined,
  }
}

function toVolSurface(raw: BackendVolSurface, expectedVersion = 'desk_vol_surface.v2'): VolSurface {
  const captured = ['atm_term_curve.v1','local_delta_skew.v1'].includes(expectedVersion) && isScheduledCaptureValid(
    expectedVersion,raw.version,raw.as_of_ms,raw.valid_until_ms,raw.capture_validated,raw.next_capture_ms,raw.capture_due_ms)
  const current = expectedVersion === 'atm_term_curve.v1'
    ? captured || isAtmCurveCurrent(raw.version,raw.as_of_ms,raw.valid_until_ms)
    : expectedVersion === 'local_delta_skew.v1' ? captured && Date.now() <= raw.capture_due_ms! && raw.refresh_status?.state !== 'failed'
    : isSurfaceCurrent(raw.version,raw.as_of_ms)
  const tenors = (raw.term_structure ?? [])
    .filter((row) => typeof row.tenor === 'string' && row.tenor.length > 0)
    .map((row) => ({
      tenor: row.tenor as string,
      status: row.status ?? null,
      atmIvPercent: current && row.status === 'ok' && row.calendar_ok !== false ? finiteOrNull(row.atm_iv_percent) : null,
      bidIvPercent: current && row.status === 'ok' ? finiteOrNull(row.atm_bid_iv_percent) : null,
      askIvPercent: current && row.status === 'ok' ? finiteOrNull(row.atm_ask_iv_percent) : null,
      midIvPercent: current && row.status === 'ok' ? finiteOrNull(row.atm_mid_iv_percent) : null,
      midpointReasons: row.midpoint_validation_reasons ?? [],
      skew25Normalized: current && row.status === 'ok' && row.calendar_ok !== false ? finiteOrNull(row.skew_25_normalized) : null,
      skew10Normalized: current && !row.metric_reasons?.skew_10?.length ? finiteOrNull(row.skew_10_normalized) : null,
      tailGapVolPoints: current && !row.metric_reasons?.tail_gap?.length ? finiteOrNull(row.tail_gap_vol_points) : null,
      rr25VolPoints: current ? finiteOrNull(row.rr_25_vol_points) : null,
      metricReasons: row.metric_reasons,
      calendarOk: row.calendar_ok ?? null,
      reasons: !current ? [expectedVersion === 'atm_term_curve.v1' ? 'atm_curve_stale' : 'surface_stale_or_legacy'] : row.validation_reasons ?? [],
      method: row.method ?? null,
      lowerExpiryTsMs: row.lower_expiry_ts_ms ?? null,
      upperExpiryTsMs: row.upper_expiry_ts_ms ?? null,
      lowerDteDays: row.lower_dte_days ?? null,
      upperDteDays: row.upper_dte_days ?? null,
    }))
  const compared = raw.atm_vs_rv
  return {
    version: raw.version,
    refreshState: raw.refresh_status?.state,
    asOfMs: raw.as_of_ms,
    captureDueMs: captured ? raw.capture_due_ms : undefined,
    lookbacks: raw.version === 'atm_term_curve.v1' ? (raw.lookbacks ?? []).filter(row =>
      Number.isInteger(row.days) && row.days >= 1 && row.days <= 365 && Number.isFinite(row.as_of_ms)
    ).map(snapshot => ({ days: snapshot.days, asOfMs: snapshot.as_of_ms,
      tenors: snapshot.term_structure.map(row => ({
        tenor: row.tenor ?? '', status: row.status ?? null, calendarOk: row.calendar_ok,
        atmIvPercent: row.status === 'ok' && row.calendar_ok !== false ? finiteOrNull(row.atm_iv_percent) : null,
        skew25Normalized: null,
      })),
    })) : [],
    history: Object.fromEntries(['atm', 'skew_25', 'skew_10', 'tail_gap'].map((name) => [name,
      Object.fromEntries(Object.entries(raw.version === expectedVersion ? raw.history?.[name] ?? {} : {}).map(([tenor, values]) => [tenor, toVolSeries(values)])),
    ])) as VolSurface['history'],
    tenors,
    listedExpiries: (raw.listed_expiries ?? []).flatMap((row) => {
      const expiryTsMs = positiveTimestampOrNull(row.expiry_ts_ms)
      const dteDays = finiteOrNull(row.dte_days)
      if (expiryTsMs == null || dteDays == null || dteDays < 0) return []
      return [{
        expiryTsMs, dteDays, status: row.status ?? null,
        atmIvPercent: current && row.status === 'ok' ? finiteOrNull(row.atm_iv_percent) : null,
        forwardUsd: finiteOrNull(row.forward_usd),
        lowerStrike: finiteOrNull(row.lower_strike), upperStrike: finiteOrNull(row.upper_strike),
        reasons: !current ? [expectedVersion === 'atm_term_curve.v1' ? 'atm_curve_stale' : 'surface_stale_or_legacy'] : row.validation_reasons ?? [],
      }]
    }).sort((a,b) => a.expiryTsMs-b.expiryTsMs),
    atmVsRv: compared && current
      ? {
          atmIvPercent: finiteOrNull(compared.atm_iv_percent),
          rvPercent: finiteOrNull(compared.rv_percent),
          spreadPercent: finiteOrNull(compared.spread_percent),
          rvEstimator: compared.rv_estimator ?? null,
        }
      : undefined,
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
  const hasConstantMaturityTerm = raw.term != null
  const skewTenors: SkewTenor[] = ['1w', '1m', '3m', '6m']
  const atmFromDetail = (tenor: string): number | null => {
    const entry = hasConstantMaturityTerm
      ? raw.term?.[tenor as SkewTenor]
      : detail[tenor]
    if (!entry || entry.status !== 'ok') return null
    return decimalVolToPercent(entry.atm_iv)
  }

  const frontRaw = raw.term?.['1d'] ?? raw.front
  const frontAtm =
    frontRaw && frontRaw.status === 'ok'
      ? {
          atmIvPercent: decimalVolToPercent(frontRaw.atm_iv),
          dteDays: finiteOrNull(frontRaw.dte_days),
          expiryTsMs:
            frontRaw.expiry_ts_ms != null && Number.isFinite(Number(frontRaw.expiry_ts_ms))
              ? Number(frontRaw.expiry_ts_ms)
              : null,
          targetDays: finiteOrNull(frontRaw.target_days),
          method: frontRaw.method ?? null,
          lowerExpiryTsMs: positiveTimestampOrNull(frontRaw.lower_expiry_ts_ms),
          lowerDteDays: finiteOrNull(frontRaw.lower_dte_days),
          upperExpiryTsMs: positiveTimestampOrNull(frontRaw.upper_expiry_ts_ms),
          upperDteDays: finiteOrNull(frontRaw.upper_dte_days),
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
            targetDays: finiteOrNull(frontRaw.target_days),
            method: frontRaw.method ?? null,
            lowerExpiryTsMs: positiveTimestampOrNull(frontRaw.lower_expiry_ts_ms),
            lowerDteDays: finiteOrNull(frontRaw.lower_dte_days),
            upperExpiryTsMs: positiveTimestampOrNull(frontRaw.upper_expiry_ts_ms),
            upperDteDays: finiteOrNull(frontRaw.upper_dte_days),
            status: frontRaw.status ?? null,
          }
        : null

  const primaryTenor = raw.primary_tenor ?? raw.meta?.chart_tenor ?? null
  const legacySeries = toVolSeries(raw.series)
  const seriesByTenor = Object.fromEntries(
    skewTenors.map((tenor) => {
      const dedicated = toVolSeries(raw.series_by_tenor?.[tenor])
      const fallback = dedicated.length === 0 && tenor === primaryTenor ? legacySeries : dedicated
      return [tenor, fallback]
    }),
  ) as Record<SkewTenor, VolSeriesPoint[]>
  const termDetails = Object.fromEntries(
    skewTenors.map((tenor) => {
      const entry = hasConstantMaturityTerm ? raw.term?.[tenor] : detail[tenor]
      const expiry = Number(entry?.expiry_ts_ms)
      return [tenor, {
        atmIvPercent: entry?.status === 'ok' ? decimalVolToPercent(entry.atm_iv) : null,
        dteDays: finiteOrNull(entry?.dte_days),
        expiryTsMs: Number.isFinite(expiry) && expiry > 0 ? expiry : null,
        targetDays: finiteOrNull(entry?.target_days),
        method: entry?.method ?? null,
        lowerExpiryTsMs: positiveTimestampOrNull(entry?.lower_expiry_ts_ms),
        lowerDteDays: finiteOrNull(entry?.lower_dte_days),
        upperExpiryTsMs: positiveTimestampOrNull(entry?.upper_expiry_ts_ms),
        upperDteDays: finiteOrNull(entry?.upper_dte_days),
        status: entry?.status ?? null,
      }]
    }),
  ) as NonNullable<Skew25d['termDetails']>

  return {
    formula: raw.formula,
    primaryTenor,
    levels: {
      // Normalized skew — pass through as-is (do NOT /100 or *100).
      '1w': finiteOrNull(levels['1w']),
      '1m': finiteOrNull(levels['1m']),
      '3m': finiteOrNull(levels['3m']),
      '6m': finiteOrNull(levels['6m']),
    },
    series: legacySeries,
    seriesByTenor,
    atmIvPercent: {
      '1w': atmFromDetail('1w'),
      '1m': atmFromDetail('1m'),
      '3m': atmFromDetail('3m'),
      '6m': atmFromDetail('6m'),
    },
    termDetails,
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

function positiveTimestampOrNull(value: number | null | undefined): number | null {
  const timestamp = finiteOrNull(value)
  return timestamp != null && timestamp > 0 ? timestamp : null
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
