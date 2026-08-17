import { normalizeLiveExpiry } from '@/api/liveTerminal'
import type {
  DensityDiagnostic,
  ForwardSourceQuality,
  SurfaceDisplayState,
} from '@/data/optionsSurfaceDisplay'
import { DIAGNOSTIC_DENSITY_LABEL } from '@/data/optionsSurfaceDisplay'

export type IvSignalDirection = 'LONG' | 'SHORT' | 'NO_TRADE'
export type IvSignalCurveQualityLevel = 'HIGH' | 'CAUTION' | 'LOW'
export type IvSignalFeedStatus = 'READY' | 'WARMING' | 'DEGRADED' | 'DISCONNECTED'

export type IvSignalScanParameters = {
  tailThreshold: number
  bandWidth: number
  signalDelta: number
}

export type IvSignalDensityPoint = {
  strike: number
  raw: number
  smoothed: number
}

export type IvSignalIvCurvePoint = {
  strike: number
  iv: number
  ivPercent: number
  source: string
  optionSide: 'call' | 'put' | 'merged' | 'synthetic' | 'unknown'
  synthetic: boolean
  quoteAgeSeconds: number | null
}

export type IvSignalSmileClassification = 'preferred' | 'fallback' | 'synthetic'

export type IvSignalSmilePoint = {
  strike: number
  iv: number
  ivPercent: number
  logMoneyness: number
  delta: number | null
  optionSide: IvSignalIvCurvePoint['optionSide']
  classification: IvSignalSmileClassification
  source: string
  synthetic: boolean
  bidIv: number | null
  askIv: number | null
  markIv: number | null
  quoteAgeSeconds?: number | null
}

export type IvSignalSmileFitPoint = {
  strike: number
  iv: number
  ivPercent: number
  logMoneyness: number
  delta: number | null
}

export type IvSignalSmile = {
  points: IvSignalSmilePoint[]
  fit: IvSignalSmileFitPoint[]
  metrics: {
    rr25: number | null
    bf25: number | null
    atmIv: number | null
    iv25Call: number | null
    iv25Put: number | null
    deltaAxisAvailable: boolean
  }
}

export type IvSignalScan = {
  asOf: string
  underlying: 'BTC'
  expiry: string
  settlementAt: string
  spotPrice: number
  timeToExpiryYears: number
  parameters: IvSignalScanParameters
  ivCurve: IvSignalIvCurvePoint[]
  smile: IvSignalSmile
  density: IvSignalDensityPoint[]
  servedCdf: number[] | null
  markers: {
    spot: number
    tailLower: number
    tailUpper: number
    bandLower: number
    bandUpper: number
    peakStrike: number
  }
  signals: {
    skew: {
      signal: IvSignalDirection
      pUp: number
      pDown: number
      difference: number
    }
    tails: {
      signal: IvSignalDirection
      pUp: number
      pDown: number
      difference: number
    }
    peak: {
      signal: IvSignalDirection
      peakStrike: number
      shiftPercent: number
    }
    band: {
      signal: IvSignalDirection
      pBand: number
      pOutside: number
      difference: number
    }
  }
  modelVerdict: IvSignalDirection
  verdict: IvSignalDirection
  rnd: {
    forward: number
    pBelowForward: number
    pAboveForward: number
    pLeft5: number
    pRight5: number
    pLeftSigma: number
    pRightSigma: number
    sigmaMove: number
    sigmaLeftStrike: number | null
    sigmaRightStrike: number | null
    atmIv: number | null
    percentile05: number
    percentile16: number
    percentile25: number
    percentile50: number
    percentile75: number
    percentile84: number
    percentile95: number
    expectedMoveUp: number
    expectedMoveDown: number
    mean: number
    normalizationIntegral: number
    negativeArea: number
    wingOrdering: 'left' | 'right' | 'balanced'
    wingSignal: IvSignalDirection
    sigmaOrdering: 'left' | 'right' | 'balanced'
    sigmaSignal: IvSignalDirection
  }
  outlook: {
    rawVerdict: IvSignalDirection
    publishedVerdict: IvSignalDirection
    forming: boolean
    confirmationWindow: number
    confirmationRequired: number
    rawMatchesInWindow: number
  }
  suppressionReasons: string[]
  selection: {
    policy: string
    ivBasis: 'mark_iv' | 'unknown'
    source: string
    verifiedLiveQuotes: boolean
    inputRows: number
    expiryRows: number
    validQuoteRows: number
    selectedMarketStrikes: number
    preferredSideSelections: number
    oppositeSideFallbacks: number
    atmMergedSelections: number
    atmSingleSideSelections: number
    methodology: string
    syntheticAnchorAdded: boolean
    rejectedInvalidContractRows: number
    rejectedInvalidIvRows: number
    rejectedMissingQuoteRows: number
    rejectedZeroBidRows: number
    rejectedCrossedQuoteRows: number
    rejectedStaleQuoteRows: number
    rejectedNonOpenRows: number
    rejectedMissingSizeRows: number
    rejectedInvalidIvMarketRows: number
    rejectedWideSpreadRows: number
    rejectedLowDeltaRows: number
    rejectedLowOpenInterestRows: number
    coverageCorridor: number | null
    deltaCutoff: number | null
    impliedForward: number | null
    forwardSource: 'matching_future' | 'inverse_put_call_parity' | 'parity_pairs' | 'venue_underlying_price' | 'underlying_price' | 'spot_fallback' | 'unknown'
    forwardSourceQuality: ForwardSourceQuality
    forwardPairCount: number
    otmReference: number | null
    medianSelectedIvSpreadPercentagePoints: number
    maxSelectedIvSpreadPercentagePoints: number
    maxQuoteAgeSeconds: number
    oldestSelectedQuoteAgeSeconds: number | null
  }
  curveQuality: {
    level: IvSignalCurveQualityLevel
    signalEligible: boolean
    negativeGridPoints: number
    gridPointCount: number
    negativeGridFraction: number
    negativeArea: number
    positiveArea: number
    normalizationIntegral: number
    clippingRequired: boolean
    sparseCenter: boolean
  }
  coverage: {
    totalExpiryRows: number
    validIvRows: number
    uniqueStrikes: number
    droppedRows: number
    duplicateRows: number
    strikeMin: number
    strikeMax: number
    ivCoverageRatio: number
    hardValidStrikes: number
    hardValidCoverageRatio: number
    spotBracketed: boolean
    forwardBracketed: boolean
    impliedForward: number | null
    otmReference: number | null
    lowerStrikes: number
    upperStrikes: number
    centerLogGap: number | null
    centerGapExceeded: boolean
    tenorMinStrikes: number
    tenorMinSideStrikes: number
    maxCenterLogGap: number
    tenorBucket: string
  }
  freshness: {
    snapshotAgeSeconds: number
    thresholdSeconds: number
    isFresh: boolean
  }
  eligibility: {
    isZeroDte: boolean
    directionalEligible: boolean
    zeroDteEligible: boolean
    recommendedRefreshSeconds: number
    hoursToSettlement: number
    activeSignalCount: number
    alignedSignalCount: number
    lowerCanonicalStrikes: number
    upperCanonicalStrikes: number
    nearestLowerGapPercent: number | null
    nearestUpperGapPercent: number | null
    requirements: {
      settlementWindow: boolean
      curveQuality: boolean
      twoSidedCoverage: boolean
      quoteFreshness: boolean
      signalAlignment: boolean
    }
  }
  display: SurfaceDisplayState
  diagnosticDensity: DensityDiagnostic | null
  feed: {
    source: string
    transport: 'websocket' | 'snapshot' | 'unknown'
    channelInterval: 'incremental' | '100ms' | 'agg2' | 'unknown'
    status: IvSignalFeedStatus
    connected: boolean
    warmupComplete: boolean
    universeIsCurrent: boolean
    expectedExpiryInstruments: number
    subscribedExpiryInstruments: number
    initializedExpiryInstruments: number
    freshExpiryInstruments: number
    completenessRatio: number
    lastMessageAt: string
    lastMessageAgeSeconds: number | null
    reconnectCount: number
    connectionGeneration: number
    lastError: string
  }
  warnings: string[]
}

export const defaultIvSignalScanParameters: IvSignalScanParameters = {
  tailThreshold: 0.02,
  bandWidth: 0.03,
  signalDelta: 0.03,
}

export type FetchIvSignalScanOptions = Partial<IvSignalScanParameters> & {
  expiry: string
  signal?: AbortSignal
}

const apiBaseUrl =
  import.meta.env.VITE_LOTUS_API_BASE_URL
  ?? (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')

export async function fetchIvSignalScan({
  expiry,
  signal,
}: FetchIvSignalScanOptions): Promise<IvSignalScan> {
  const params = new URLSearchParams({
    expiry: normalizeLiveExpiry(expiry),
  })
  const response = await fetch(`${apiBaseUrl}/api/v1/options-surface?${params}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })

  if (!response.ok) {
    const detail = await readFastApiDetail(response)
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    throw new Error(
      `Options surface request failed: ${status}${detail ? ` (${detail})` : ''}`,
    )
  }

  return surfaceToScan(await response.json() as unknown)
}

function surfaceToScan(value: unknown): IvSignalScan {
  const raw = asRecord(value)
  const forward = asRecord(raw.forward)
  const quotes = asRecord(raw.quotes)
  const smile = asRecord(raw.smile)
  const density = asRecord(raw.density)
  const analytics = asRecord(raw.analytics)
  const validation = asRecord(raw.validation)
  const feedRaw = asRecord(raw.feed)
  const freshnessRaw = asRecord(raw.freshness)
  const forwardUsd = optionalNonNegativeNumber(forward.forward_usd) ?? finiteNumber(raw.index_usd, Number.NaN)
  const display = mapDisplay(raw.display, raw)
  const status = stringValue(raw.model_status).toLowerCase() || display.surfaceDisplayStatus
  const rejected = display.densityStatus === 'rejected' || display.densityStatus === 'unavailable' || !raw.density
  const observed = arrayValue(smile.observed).map(mapSurfaceSmilePoint)
  const synthetic = arrayValue(smile.synthetic).map(mapSurfaceSmilePoint)
  const fit = arrayValue(smile.fit).map((point) => {
    const row = asRecord(point)
    return {
      strike: finiteNumber(row.strike_usd, Number.NaN),
      iv: finiteNumber(row.iv, Number.NaN),
      ivPercent: finiteNumber(row.iv, Number.NaN) * 100,
      logMoneyness: finiteNumber(row.log_moneyness, Number.NaN),
      delta: optionalFiniteNumber(row.forward_delta),
    }
  }).filter((point) => Number.isFinite(point.strike) && Number.isFinite(point.iv))
  const points = [...observed, ...synthetic]
  const strikes = arrayValue(density.strikes_usd).map((item) => finiteNumber(item, Number.NaN))
  const rawDensity = arrayValue(density.raw_density).map((item) => finiteNumber(item, Number.NaN))
  const servedCdfRaw = arrayValue(density.cdf).map((item) => finiteNumber(item, Number.NaN))
  const quantiles = asRecord(density.quantiles)
  const densityEligible = display.densityStatus === 'accepted' || display.densityStatus === 'degraded'
  const densityPoints = !densityEligible
    ? []
    : strikes.map((strike, index) => ({
      strike,
      raw: rawDensity[index] ?? 0,
      smoothed: rawDensity[index] ?? 0,
    })).filter((point) => Number.isFinite(point.strike))
  const servedCdf = densityEligible
    && servedCdfRaw.length === densityPoints.length
    && servedCdfRaw.length > 0
    && servedCdfRaw.every((value) => Number.isFinite(value))
    ? servedCdfRaw
    : null
  const reasons = asRecord(quotes.reason_counts)
  const quality: IvSignalCurveQualityLevel = status === 'accepted'
    ? 'HIGH'
    : status === 'degraded' || status === 'research'
      ? 'CAUTION'
      : 'LOW'
  const idle = { signal: 'NO_TRADE' as const, pUp: 0, pDown: 0, difference: 0 }
  return {
    asOf: stringValue(raw.as_of_utc),
    underlying: 'BTC',
    expiry: stringValue(raw.expiry),
    settlementAt: stringValue(raw.expiry_utc),
    spotPrice: finiteNumber(raw.index_usd, Number.NaN),
    timeToExpiryYears: finiteNumber(raw.time_to_expiry_years, Number.NaN),
    parameters: defaultIvSignalScanParameters,
    ivCurve: points.map((point) => ({
      strike: point.strike,
      iv: point.iv,
      ivPercent: point.ivPercent,
      source: point.source,
      optionSide: point.optionSide,
      synthetic: point.synthetic,
      quoteAgeSeconds: point.quoteAgeSeconds ?? 0,
      bidIv: point.bidIv,
      askIv: point.askIv,
      markIv: point.markIv,
    })),
    smile: {
      points,
      fit,
      metrics: {
        rr25: optionalFiniteNumber(analytics.rr_25),
        bf25: optionalFiniteNumber(analytics.bf_25),
        atmIv: optionalNonNegativeNumber(analytics.atm_iv),
        iv25Call: optionalNonNegativeNumber(analytics.iv_25_call),
        iv25Put: optionalNonNegativeNumber(analytics.iv_25_put),
        deltaAxisAvailable: points.some((point) => point.delta != null),
      },
    },
    density: densityPoints,
    servedCdf,
    diagnosticDensity: mapDiagnosticDensity(density),
    display,
    markers: {
      spot: forwardUsd,
      tailLower: forwardUsd * 0.95,
      tailUpper: forwardUsd * 1.05,
      bandLower: rejected ? Number.NaN : optionalFiniteNumber(quantiles.p25) ?? Number.NaN,
      bandUpper: rejected ? Number.NaN : optionalFiniteNumber(quantiles.p75) ?? Number.NaN,
      // peakStrike is a legacy field. It is not a density mode and must not
      // be sourced from p50 / the risk-neutral median.
      peakStrike: Number.NaN,
    },
    signals: {
      skew: idle,
      tails: idle,
      peak: { signal: 'NO_TRADE', peakStrike: optionalFiniteNumber(quantiles.p50) ?? forwardUsd, shiftPercent: 0 },
      band: { signal: 'NO_TRADE', pBand: 0, pOutside: 0, difference: 0 },
    },
    modelVerdict: 'NO_TRADE',
    verdict: 'NO_TRADE',
    rnd: {
      forward: forwardUsd,
      pBelowForward: rejected ? 0 : finiteNumber(analytics.p_below_forward, 0),
      pAboveForward: rejected ? 0 : finiteNumber(analytics.p_above_forward, 0),
      pLeft5: rejected ? 0 : finiteNumber(analytics.p_left_5, 0),
      pRight5: rejected ? 0 : finiteNumber(analytics.p_right_5, 0),
      pLeftSigma: rejected ? 0 : finiteNumber(analytics.p_left_sigma, 0),
      pRightSigma: rejected ? 0 : finiteNumber(analytics.p_right_sigma, 0),
      sigmaMove: optionalNonNegativeNumber(analytics.atm_iv) != null
        ? Number(analytics.atm_iv) * Math.sqrt(finiteNumber(raw.time_to_expiry_years, 0))
        : 0,
      sigmaLeftStrike: optionalFiniteNumber(analytics.implied_move_1sd_down) != null
        ? forwardUsd - Number(analytics.implied_move_1sd_down)
        : null,
      sigmaRightStrike: optionalFiniteNumber(analytics.implied_move_1sd_up) != null
        ? forwardUsd + Number(analytics.implied_move_1sd_up)
        : null,
      atmIv: optionalNonNegativeNumber(analytics.atm_iv),
      percentile05: rejected ? Number.NaN : finiteNumber(quantiles.p05, Number.NaN),
      percentile16: rejected ? Number.NaN : finiteNumber(quantiles.p16, Number.NaN),
      percentile25: rejected ? Number.NaN : finiteNumber(quantiles.p25, Number.NaN),
      percentile50: rejected ? Number.NaN : finiteNumber(quantiles.p50, Number.NaN),
      percentile75: rejected ? Number.NaN : finiteNumber(quantiles.p75, Number.NaN),
      percentile84: rejected ? Number.NaN : finiteNumber(quantiles.p84, Number.NaN),
      percentile95: rejected ? Number.NaN : finiteNumber(quantiles.p95, Number.NaN),
      expectedMoveUp: finiteNumber(analytics.implied_move_1sd_up, 0),
      expectedMoveDown: finiteNumber(analytics.implied_move_1sd_down, 0),
      mean: rejected ? forwardUsd : finiteNumber(analytics.risk_neutral_mean, forwardUsd),
      normalizationIntegral: finiteNumber(density.mass, 0),
      negativeArea: finiteNumber(density.raw_negative_mass, 0),
      wingOrdering: 'balanced',
      wingSignal: 'NO_TRADE',
      sigmaOrdering: 'balanced',
      sigmaSignal: 'NO_TRADE',
    },
    outlook: {
      rawVerdict: 'NO_TRADE',
      publishedVerdict: 'NO_TRADE',
      forming: false,
      confirmationWindow: 3,
      confirmationRequired: 2,
      rawMatchesInWindow: 0,
    },
    suppressionReasons: rejected
      ? arrayValue(raw.warnings).map((item) => stringValue(item)).concat(['surface_rejected'])
      : arrayValue(raw.warnings).map((item) => stringValue(item)),
    selection: {
      policy: 'options_surface_v1',
      ivBasis: 'mark_iv',
      source: stringValue(feedRaw.source) || 'options_surface',
      verifiedLiveQuotes: stringValue(feedRaw.transport) === 'websocket',
      inputRows: finiteNumber(quotes.input_rows, 0),
      expiryRows: finiteNumber(quotes.input_rows, 0),
      validQuoteRows: finiteNumber(quotes.accepted_rows, 0),
      selectedMarketStrikes: finiteNumber(quotes.accepted_strikes, 0),
      preferredSideSelections: finiteNumber(quotes.preferred_side_selections, 0),
      oppositeSideFallbacks: finiteNumber(quotes.opposite_side_fallbacks, 0),
      atmMergedSelections: finiteNumber(quotes.atm_merged, 0),
      atmSingleSideSelections: 0,
      methodology: 'options_surface_v1',
      syntheticAnchorAdded: quotes.synthetic_atm_added === true,
      rejectedInvalidContractRows: finiteNumber(reasons.malformed_contract, 0),
      rejectedInvalidIvRows: finiteNumber(reasons.invalid_iv, 0),
      rejectedMissingQuoteRows: finiteNumber(reasons.missing_quote, 0),
      rejectedZeroBidRows: finiteNumber(reasons.zero_bid, 0),
      rejectedCrossedQuoteRows: finiteNumber(reasons.crossed_price, 0),
      rejectedStaleQuoteRows: finiteNumber(reasons.stale_quote, 0),
      rejectedNonOpenRows: finiteNumber(reasons.non_open, 0),
      rejectedMissingSizeRows: finiteNumber(reasons.missing_size, 0),
      rejectedInvalidIvMarketRows: finiteNumber(reasons.invalid_iv_market, 0),
      rejectedWideSpreadRows: finiteNumber(reasons.wide_spread, 0),
      rejectedLowDeltaRows: finiteNumber(reasons.low_delta, 0),
      rejectedLowOpenInterestRows: finiteNumber(reasons.low_open_interest, 0),
      coverageCorridor: null,
      deltaCutoff: null,
      impliedForward: optionalNonNegativeNumber(forward.forward_usd),
      forwardSource: forwardSource(forward.source),
      forwardSourceQuality: forwardSourceQuality(forward.source_quality),
      forwardPairCount: finiteNumber(forward.parity_pair_count, 0),
      otmReference: optionalNonNegativeNumber(forward.forward_usd),
      medianSelectedIvSpreadPercentagePoints: 0,
      maxSelectedIvSpreadPercentagePoints: 0,
      maxQuoteAgeSeconds: 30,
      oldestSelectedQuoteAgeSeconds: null,
    },
    curveQuality: {
      level: quality,
      signalEligible: false,
      negativeGridPoints: 0,
      gridPointCount: Math.max(finiteNumber(density.grid_points, 1), 1),
      negativeGridFraction: 0,
      negativeArea: finiteNumber(density.raw_negative_mass, 0),
      positiveArea: Math.max(finiteNumber(density.mass, 0), 0),
      normalizationIntegral: finiteNumber(density.mass, 0),
      clippingRequired: false,
      sparseCenter: quotes.center_log_gap == null,
    },
    coverage: {
      totalExpiryRows: finiteNumber(quotes.input_rows, 0),
      validIvRows: finiteNumber(quotes.accepted_rows, 0),
      uniqueStrikes: Math.max(finiteNumber(quotes.accepted_strikes, 0), 4),
      droppedRows: finiteNumber(quotes.rejected_rows, 0),
      duplicateRows: finiteNumber(reasons.duplicate, 0),
      strikeMin: points[0]?.strike ?? forwardUsd,
      strikeMax: points[points.length - 1]?.strike ?? forwardUsd,
      ivCoverageRatio: 0,
      hardValidStrikes: finiteNumber(quotes.accepted_strikes, 0),
      hardValidCoverageRatio: 0,
      spotBracketed: true,
      forwardBracketed: finiteNumber(quotes.lower_strikes, 0) > 0 && finiteNumber(quotes.upper_strikes, 0) > 0,
      impliedForward: optionalNonNegativeNumber(forward.forward_usd),
      otmReference: optionalNonNegativeNumber(forward.forward_usd),
      lowerStrikes: finiteNumber(quotes.lower_strikes, 0),
      upperStrikes: finiteNumber(quotes.upper_strikes, 0),
      centerLogGap: optionalFiniteNumber(quotes.center_log_gap),
      centerGapExceeded: false,
      tenorMinStrikes: 8,
      tenorMinSideStrikes: 3,
      maxCenterLogGap: 0.06,
      tenorBucket: stringValue(quotes.tenor_bucket) || 'unknown',
    },
    freshness: {
      snapshotAgeSeconds: finiteNumber(freshnessRaw.snapshot_age_seconds, 0),
      thresholdSeconds: finiteNumber(freshnessRaw.threshold_seconds, 180),
      isFresh: freshnessRaw.is_fresh === true,
    },
    eligibility: {
      isZeroDte: false,
      directionalEligible: false,
      zeroDteEligible: false,
      recommendedRefreshSeconds: 600,
      hoursToSettlement: 0,
      activeSignalCount: 0,
      alignedSignalCount: 0,
      lowerCanonicalStrikes: finiteNumber(quotes.lower_strikes, 0),
      upperCanonicalStrikes: finiteNumber(quotes.upper_strikes, 0),
      nearestLowerGapPercent: null,
      nearestUpperGapPercent: null,
      requirements: {
        settlementWindow: true,
        curveQuality: quality !== 'LOW',
        twoSidedCoverage: finiteNumber(quotes.lower_strikes, 0) > 0 && finiteNumber(quotes.upper_strikes, 0) > 0,
        quoteFreshness: freshnessRaw.is_fresh === true,
        signalAlignment: false,
      },
    },
    feed: mapFeed(feedRaw),
    warnings: arrayValue(raw.warnings).map((item) => stringValue(item)),
    modelStatus: status || stringValue(validation.model_status),
  } as IvSignalScan
}

function mapDisplay(value: unknown, raw: Record<string, unknown>): SurfaceDisplayState {
  const display = asRecord(value)
  const residual = asRecord(raw.fit_residual_summary)
  const validation = asRecord(raw.validation)
  const analytics = asRecord(raw.analytics)
  const smile = asRecord(raw.smile)
  const density = asRecord(raw.density)
  const quoteStatus = statusThree(display.quote_status ?? validation.quote_status, fallbackQuoteStatus(raw))
  const smileStatus = statusSmile(display.smile_status ?? validation.smile_status ?? smile.status, 'rejected')
  const densityStatus = statusDensity(
    display.density_status ?? validation.density_status ?? density.status,
    raw.density == null ? 'unavailable' : 'rejected',
  )
  const surfaceStatus = statusSurface(
    display.surface_display_status ?? validation.surface_display_status,
    densityStatus === 'rejected' || smileStatus === 'rejected' ? 'rejected' : 'degraded',
  )
  const eligibility = mapEligibilityList(display.metric_eligibility, {
    quoteStatus,
    smileStatus,
    densityStatus,
    analytics,
  })
  return {
    quoteStatus,
    smileStatus,
    densityStatus,
    surfaceDisplayStatus: surfaceStatus,
    reasonCodes: stringArray(display.reason_codes).length
      ? stringArray(display.reason_codes)
      : stringArray(raw.warnings),
    humanReadableReason: stringValue(display.human_readable_reason)
      || stringValue(validation.human_readable_reason)
      || fallbackHumanReason(densityStatus),
    diagnosticDetail: stringValue(display.diagnostic_detail),
    failedChecks: stringArray(display.failed_checks).length
      ? stringArray(display.failed_checks)
      : stringArray(validation.failed_checks),
    metricEligibility: eligibility,
    servedFitterName: stringValue(display.served_fitter_name) || stringValue(raw.fitter_name) || 'tv_pchip',
    servedFitterGrade: gradeOf(display.served_fitter_grade ?? raw.fitter_grade),
    researchFitterName: stringValue(display.research_fitter_name) || null,
    researchFailedChecks: stringArray(display.research_failed_checks),
    researchHumanReason: stringValue(display.research_human_reason) || null,
    customerWarningScope: scopeOf(display.customer_warning_scope),
    servingMode: servingModeOf(display.serving_mode ?? raw.serving_mode),
    configVersion: stringValue(display.config_version ?? raw.config_version) || null,
    configHash: stringValue(display.config_hash ?? raw.config_hash) || null,
    primaryFailureCategory: failureCategoryOf(
      display.primary_failure_category ?? raw.primary_failure_category,
    ),
    residualBudgetOk: residualBudgetOf(display.residual_budget_ok ?? residual.residual_budget_ok),
  }
}

function residualBudgetOf(value: unknown): boolean | null {
  if (value === true) return true
  if (value === false) return false
  return null
}

function servingModeOf(value: unknown): SurfaceDisplayState['servingMode'] {
  const normalized = stringValue(value).toLowerCase()
  if (
    normalized === 'diagnostic_candidate'
    || normalized === 'shadow_compare'
    || normalized === 'disabled'
  ) return normalized
  return 'diagnostic_candidate'
}

function failureCategoryOf(value: unknown): SurfaceDisplayState['primaryFailureCategory'] {
  const normalized = stringValue(value).toLowerCase()
  if (
    normalized === 'none'
    || normalized === 'market_data'
    || normalized === 'fit_quality'
    || normalized === 'hard_gate'
  ) return normalized
  return null
}

function gradeOf(value: unknown): SurfaceDisplayState['servedFitterGrade'] {
  const normalized = stringValue(value).toLowerCase()
  if (
    normalized === 'production'
    || normalized === 'diagnostic'
    || normalized === 'diagnostic_candidate'
    || normalized === 'research'
  ) return normalized
  return 'diagnostic'
}

function scopeOf(value: unknown): SurfaceDisplayState['customerWarningScope'] {
  const normalized = stringValue(value).toLowerCase()
  if (normalized === 'served' || normalized === 'research' || normalized === 'none') return normalized
  return 'none'
}

function mapEligibilityList(
  value: unknown,
  context: {
    quoteStatus: QuoteStatusLike
    smileStatus: string
    densityStatus: string
    analytics: Record<string, unknown>
  },
): SurfaceDisplayState['metricEligibility'] {
  const rows = arrayValue(value)
  if (rows.length > 0) {
    const mapped: SurfaceDisplayState['metricEligibility'] = {}
    for (const row of rows) {
      const item = asRecord(row)
      const name = stringValue(item.metric)
      if (!name) continue
      mapped[name] = {
        available: item.available === true,
        reasonCode: stringValue(item.reason_code) || null,
        reason: stringValue(item.reason) || null,
      }
    }
    return applyCustomerModePolicy(mapped)
  }
  const densityOk = context.densityStatus === 'accepted' || context.densityStatus === 'degraded'
  const smileOk = context.smileStatus !== 'rejected'
  const rrOk = smileOk
    && optionalFiniteNumber(context.analytics.rr_25) != null
    && optionalFiniteNumber(context.analytics.bf_25) != null
  const atmOk = smileOk && optionalNonNegativeNumber(context.analytics.atm_iv) != null
  return {
    forward: { available: true, reasonCode: null, reason: null },
    index: { available: true, reasonCode: null, reason: null },
    quote_coverage: { available: true, reasonCode: null, reason: null },
    atm_iv: { available: atmOk, reasonCode: atmOk ? null : 'smile_unavailable', reason: atmOk ? null : 'Unavailable — no accepted smile' },
    implied_move_1sd: { available: atmOk, reasonCode: atmOk ? null : 'smile_unavailable', reason: atmOk ? null : 'Unavailable — no accepted smile' },
    rr_25: { available: rrOk, reasonCode: rrOk ? null : 'rr_unsolved', reason: rrOk ? null : 'Unavailable — 25Δ roots did not solve inside observed smile coverage' },
    bf_25: { available: rrOk, reasonCode: rrOk ? null : 'rr_unsolved', reason: rrOk ? null : 'Unavailable — 25Δ roots did not solve inside observed smile coverage' },
    density_chart: { available: densityOk, reasonCode: densityOk ? null : 'density_rejected', reason: densityOk ? null : 'Unavailable — distribution validation failed' },
    median: { available: densityOk, reasonCode: densityOk ? null : 'density_rejected', reason: densityOk ? null : 'Unavailable — distribution validation failed' },
    mode: {
      available: false,
      reasonCode: densityOk ? 'mode_not_served' : 'density_rejected',
      reason: densityOk
        ? 'Unavailable — a density mode is not served; p50 is the median, not a mode.'
        : 'Unavailable — distribution validation failed',
    },
    central_range_50: { available: densityOk, reasonCode: densityOk ? null : 'density_rejected', reason: densityOk ? null : 'Unavailable — distribution validation failed' },
    central_range_90: { available: densityOk, reasonCode: densityOk ? null : 'density_rejected', reason: densityOk ? null : 'Unavailable — distribution validation failed' },
    tail_probabilities: { available: densityOk, reasonCode: densityOk ? null : 'density_rejected', reason: densityOk ? null : 'Unavailable — distribution validation failed' },
    digital_probabilities: { available: densityOk, reasonCode: densityOk ? null : 'density_rejected', reason: densityOk ? null : 'Unavailable — distribution validation failed' },
  }
}

function mapDiagnosticDensity(density: Record<string, unknown>): DensityDiagnostic | null {
  const diagnostic = asRecord(density.diagnostic)
  const strikes = arrayValue(diagnostic.strikes_usd).map((item) => finiteNumber(item, Number.NaN))
    .filter((value) => Number.isFinite(value))
  const raw = arrayValue(diagnostic.raw_density).map((item) => finiteNumber(item, Number.NaN))
  if (strikes.length < 2) return null
  return {
    label: stringValue(diagnostic.label) || DIAGNOSTIC_DENSITY_LABEL,
    isValidDistribution: false,
    strikesUsd: strikes,
    rawDensity: raw,
  }
}

type QuoteStatusLike = 'accepted' | 'degraded' | 'rejected'

function statusThree(value: unknown, fallback: QuoteStatusLike): QuoteStatusLike {
  const normalized = stringValue(value).toLowerCase()
  if (normalized === 'accepted' || normalized === 'degraded' || normalized === 'rejected') return normalized
  return fallback
}

function statusSmile(value: unknown, fallback: SurfaceDisplayState['smileStatus']): SurfaceDisplayState['smileStatus'] {
  const normalized = stringValue(value).toLowerCase()
  if (normalized === 'accepted' || normalized === 'degraded' || normalized === 'rejected' || normalized === 'research') {
    return normalized
  }
  return fallback
}

function statusDensity(value: unknown, fallback: SurfaceDisplayState['densityStatus']): SurfaceDisplayState['densityStatus'] {
  const normalized = stringValue(value).toLowerCase()
  if (normalized === 'accepted' || normalized === 'degraded' || normalized === 'rejected' || normalized === 'unavailable') {
    return normalized
  }
  return fallback
}

function statusSurface(value: unknown, fallback: SurfaceDisplayState['surfaceDisplayStatus']): SurfaceDisplayState['surfaceDisplayStatus'] {
  const normalized = stringValue(value).toLowerCase()
  if (normalized === 'ready' || normalized === 'degraded' || normalized === 'rejected' || normalized === 'unavailable') {
    return normalized
  }
  return fallback
}

function fallbackQuoteStatus(raw: Record<string, unknown>): QuoteStatusLike {
  const quotes = asRecord(raw.quotes)
  if (finiteNumber(quotes.accepted_strikes, 0) <= 0) return 'rejected'
  if (quotes.synthetic_atm_added === true || finiteNumber(quotes.rejected_rows, 0) > 0) return 'degraded'
  return 'accepted'
}

function fallbackHumanReason(densityStatus: string): string {
  if (densityStatus === 'rejected') {
    return 'Distribution unavailable: the implied density was not a valid monotone probability distribution.'
  }
  if (densityStatus === 'unavailable') {
    return 'Unavailable — distribution validation failed'
  }
  return ''
}

function mapSurfaceSmilePoint(value: unknown): IvSignalSmilePoint {
  const row = asRecord(value)
  const classification = smileClassification(
    row.classification,
    row.classification === 'synthetic',
    row.source,
  )
  return {
    strike: finiteNumber(row.strike_usd, Number.NaN),
    iv: finiteNumber(row.iv, Number.NaN),
    ivPercent: finiteNumber(row.iv, Number.NaN) * 100,
    logMoneyness: finiteNumber(row.log_moneyness, Number.NaN),
    delta: optionalFiniteNumber(row.forward_delta),
    optionSide: optionSide(row.option_side),
    classification,
    source: stringValue(row.source),
    synthetic: classification === 'synthetic',
    bidIv: optionalNonNegativeNumber(row.bid_iv),
    askIv: optionalNonNegativeNumber(row.ask_iv),
    markIv: optionalNonNegativeNumber(row.mark_iv),
    quoteAgeSeconds: optionalFiniteNumber(row.quote_age_seconds),
  }
}

export function toIvSignalScan(value: unknown): IvSignalScan {
  const raw = asRecord(value)
  const rawParameters = asRecord(raw.parameters)
  const parameters: IvSignalScanParameters = {
    tailThreshold: finiteNumber(
      rawParameters.tail_threshold,
      defaultIvSignalScanParameters.tailThreshold,
    ),
    bandWidth: finiteNumber(
      rawParameters.band_width,
      defaultIvSignalScanParameters.bandWidth,
    ),
    signalDelta: finiteNumber(
      rawParameters.signal_delta,
      defaultIvSignalScanParameters.signalDelta,
    ),
  }
  const spotPrice = nonNegativeNumber(raw.spot_price)
  const rawSignals = asRecord(raw.signals)
  const rawPeakSignal = asRecord(rawSignals.peak)
  const peakStrike = nonNegativeNumber(rawPeakSignal.peak_strike)
  const rawMarkers = asRecord(raw.markers)
  const rawSelection = asRecord(raw.selection)
  const rawCurveQuality = asRecord(raw.curve_quality)
  const coverage = mapCoverage(raw.coverage)
  const freshness = mapFreshness(raw.freshness)
  const eligibility = mapEligibility(raw.eligibility)
  const feed = mapFeed(raw.feed)
  const qualityLevel = curveQualityLevel(rawCurveQuality.level)
  const qualityEligible = rawCurveQuality.signal_eligible === true
  const verifiedLiveQuotes = rawSelection.verified_live_quotes === true
  const hasReleaseGateContract = typeof raw.model_verdict === 'string'
    && stringValue(rawSelection.policy).length > 0
    && typeof rawCurveQuality.level === 'string'
    && asRecord(raw.feed).transport === 'websocket'
  const feedEligible = feed.transport === 'websocket'
    && feed.status === 'READY'
    && feed.connected
    && feed.warmupComplete
    && feed.universeIsCurrent
    && feed.expectedExpiryInstruments > 0
    && feed.subscribedExpiryInstruments === feed.expectedExpiryInstruments
    && feed.initializedExpiryInstruments === feed.expectedExpiryInstruments
    && feed.freshExpiryInstruments === feed.expectedExpiryInstruments
    && feed.completenessRatio === 1
  const suppressionReasons = stringArray(raw.suppression_reasons)
  if (!hasReleaseGateContract) {
    suppressionReasons.unshift('Release-gate diagnostics are unavailable; signal suppressed.')
  }
  if (!verifiedLiveQuotes && !suppressionReasons.some((reason) => /unverified|quote/i.test(reason))) {
    suppressionReasons.push('Live quote verification failed; signal suppressed.')
  }
  if (!freshness.isFresh && !suppressionReasons.some((reason) => /stale|fresh/i.test(reason))) {
    suppressionReasons.push('Snapshot freshness gate failed; signal suppressed.')
  }
  if (!coverage.spotBracketed && !suppressionReasons.some((reason) => /bracket|coverage/i.test(reason))) {
    suppressionReasons.push('Available strikes do not bracket spot; signal suppressed.')
  }
  if (!qualityEligible && !suppressionReasons.some((reason) => /curve|density|quality/i.test(reason))) {
    suppressionReasons.push('Curve quality gate failed; signal suppressed.')
  }
  if (!feedEligible && !suppressionReasons.some((reason) => /ticker|stream|feed|subscription|warm/i.test(reason))) {
    suppressionReasons.push('Deribit ticker stream is not ready; signal suppressed.')
  }
  const signalEligible = hasReleaseGateContract
    && verifiedLiveQuotes
    && freshness.isFresh
    && coverage.spotBracketed
    && qualityEligible
    && feedEligible
    && suppressionReasons.length === 0

  return {
    asOf: stringValue(raw.as_of),
    underlying: 'BTC',
    expiry: stringValue(raw.expiry),
    settlementAt: stringValue(raw.settlement_at),
    spotPrice,
    timeToExpiryYears: nonNegativeNumber(raw.time_to_expiry_years),
    parameters,
    smile: mapSmile(raw.smile),
    ivCurve: arrayValue(raw.iv_curve)
      .map((point) => asRecord(point))
      .map((point) => ({
        strike: finiteNumber(point.strike, Number.NaN),
        iv: nonNegativeNumber(point.iv),
        ivPercent: nonNegativeNumber(point.iv_percent),
        source: stringValue(point.source),
        optionSide: optionSide(point.option_side),
        synthetic: point.synthetic === true,
        quoteAgeSeconds: optionalNonNegativeNumber(point.quote_age_seconds),
      }))
      .filter((point) => Number.isFinite(point.strike) && point.strike > 0 && point.iv > 0)
      .sort((left, right) => left.strike - right.strike),
    density: arrayValue(raw.density)
      .map((point) => asRecord(point))
      .map((point) => ({
        strike: finiteNumber(point.strike, Number.NaN),
        raw: finiteNumber(point.raw),
        smoothed: finiteNumber(point.smoothed),
      }))
      .filter((point) => Number.isFinite(point.strike) && point.strike > 0)
      .sort((left, right) => left.strike - right.strike),
    servedCdf: null,
    markers: {
      spot: finiteNumber(rawMarkers.spot, spotPrice),
      tailLower: finiteNumber(
        rawMarkers.tail_lower,
        spotPrice * (1 - parameters.tailThreshold),
      ),
      tailUpper: finiteNumber(
        rawMarkers.tail_upper,
        spotPrice * (1 + parameters.tailThreshold),
      ),
      bandLower: finiteNumber(
        rawMarkers.band_lower,
        spotPrice * (1 - parameters.bandWidth),
      ),
      bandUpper: finiteNumber(
        rawMarkers.band_upper,
        spotPrice * (1 + parameters.bandWidth),
      ),
      peakStrike: finiteNumber(rawMarkers.peak_strike, peakStrike),
    },
    signals: {
      skew: mapDirectionalMassSignal(rawSignals.skew),
      tails: mapDirectionalMassSignal(rawSignals.tails),
      peak: {
        signal: signalDirection(rawPeakSignal.signal),
        peakStrike,
        shiftPercent: finiteNumber(rawPeakSignal.shift_percent),
      },
      band: mapBandSignal(rawSignals.band),
    },
    modelVerdict: signalDirection(raw.model_verdict ?? raw.verdict),
    verdict: signalEligible ? signalDirection(raw.verdict) : 'NO_TRADE',
    rnd: mapRnd(raw.rnd, spotPrice),
    outlook: mapOutlook(raw.outlook, raw.verdict),
    suppressionReasons,
    selection: {
      policy: stringValue(rawSelection.policy),
      ivBasis: rawSelection.iv_basis === 'mark_iv' ? 'mark_iv' : 'unknown',
      source: stringValue(rawSelection.source),
      verifiedLiveQuotes,
      inputRows: nonNegativeInteger(rawSelection.input_rows),
      expiryRows: nonNegativeInteger(rawSelection.expiry_rows),
      validQuoteRows: nonNegativeInteger(rawSelection.valid_quote_rows),
      selectedMarketStrikes: nonNegativeInteger(rawSelection.selected_market_strikes),
      preferredSideSelections: nonNegativeInteger(rawSelection.preferred_side_selections),
      oppositeSideFallbacks: nonNegativeInteger(rawSelection.opposite_side_fallbacks),
      atmMergedSelections: nonNegativeInteger(rawSelection.atm_merged_selections),
      atmSingleSideSelections: nonNegativeInteger(rawSelection.atm_single_side_selections),
      methodology: stringValue(rawSelection.methodology) || 'dvol_inspired_quote_filter_and_forward',
      syntheticAnchorAdded: rawSelection.synthetic_anchor_added === true,
      rejectedInvalidContractRows: nonNegativeInteger(rawSelection.rejected_invalid_contract_rows),
      rejectedInvalidIvRows: nonNegativeInteger(rawSelection.rejected_invalid_iv_rows),
      rejectedMissingQuoteRows: nonNegativeInteger(rawSelection.rejected_missing_quote_rows),
      rejectedZeroBidRows: nonNegativeInteger(rawSelection.rejected_zero_bid_rows),
      rejectedCrossedQuoteRows: nonNegativeInteger(rawSelection.rejected_crossed_quote_rows),
      rejectedStaleQuoteRows: nonNegativeInteger(rawSelection.rejected_stale_quote_rows),
      rejectedNonOpenRows: nonNegativeInteger(rawSelection.rejected_non_open_rows),
      rejectedMissingSizeRows: nonNegativeInteger(rawSelection.rejected_missing_size_rows),
      rejectedInvalidIvMarketRows: nonNegativeInteger(rawSelection.rejected_invalid_iv_market_rows),
      rejectedWideSpreadRows: nonNegativeInteger(rawSelection.rejected_wide_spread_rows),
      rejectedLowDeltaRows: nonNegativeInteger(rawSelection.rejected_low_delta_rows),
      rejectedLowOpenInterestRows: nonNegativeInteger(rawSelection.rejected_low_open_interest_rows),
      coverageCorridor: optionalNonNegativeNumber(rawSelection.coverage_corridor),
      deltaCutoff: optionalNonNegativeNumber(rawSelection.delta_cutoff),
      impliedForward: optionalNonNegativeNumber(rawSelection.implied_forward),
      forwardSource: forwardSource(rawSelection.forward_source),
      forwardSourceQuality: forwardSourceQuality(
        rawSelection.forward_source_quality ?? asRecord(raw.forward).source_quality,
      ),
      forwardPairCount: nonNegativeInteger(rawSelection.forward_pair_count),
      otmReference: optionalNonNegativeNumber(rawSelection.otm_reference),
      medianSelectedIvSpreadPercentagePoints: nonNegativeNumber(rawSelection.median_selected_iv_spread_percentage_points),
      maxSelectedIvSpreadPercentagePoints: nonNegativeNumber(rawSelection.max_selected_iv_spread_percentage_points),
      maxQuoteAgeSeconds: nonNegativeNumber(rawSelection.max_quote_age_seconds),
      oldestSelectedQuoteAgeSeconds: optionalNonNegativeNumber(rawSelection.oldest_selected_quote_age_seconds),
    },
    curveQuality: {
      level: qualityLevel,
      signalEligible,
      negativeGridPoints: nonNegativeInteger(rawCurveQuality.negative_grid_points),
      gridPointCount: nonNegativeInteger(rawCurveQuality.grid_point_count),
      negativeGridFraction: clamp01(finiteNumber(rawCurveQuality.negative_grid_fraction)),
      negativeArea: nonNegativeNumber(rawCurveQuality.negative_area),
      positiveArea: nonNegativeNumber(rawCurveQuality.positive_area),
      normalizationIntegral: finiteNumber(rawCurveQuality.normalization_integral),
      clippingRequired: rawCurveQuality.clipping_required === true,
      sparseCenter: rawCurveQuality.sparse_center === true,
    },
    coverage,
    freshness,
    eligibility,
    feed,
    warnings: stringArray(raw.warnings),
    display: mapDisplay(raw.display, raw),
    diagnosticDensity: mapDiagnosticDensity(asRecord(raw.density)),
  }
}

export function resolveIvSignalScanParameters(
  parameters: Partial<IvSignalScanParameters> = {},
): IvSignalScanParameters {
  return {
    tailThreshold: finiteNumber(
      parameters.tailThreshold,
      defaultIvSignalScanParameters.tailThreshold,
    ),
    bandWidth: finiteNumber(
      parameters.bandWidth,
      defaultIvSignalScanParameters.bandWidth,
    ),
    signalDelta: finiteNumber(
      parameters.signalDelta,
      defaultIvSignalScanParameters.signalDelta,
    ),
  }
}

function mapSmile(value: unknown): IvSignalSmile {
  const raw = asRecord(value)
  const metrics = asRecord(raw.metrics)
  const points = arrayValue(raw.points)
    .map((point) => asRecord(point))
    .map((point) => ({
      strike: finiteNumber(point.strike, Number.NaN),
      iv: nonNegativeNumber(point.iv),
      ivPercent: nonNegativeNumber(point.iv_percent),
      logMoneyness: finiteNumber(point.log_moneyness, Number.NaN),
      delta: optionalFiniteNumber(point.delta),
      optionSide: optionSide(point.option_side),
      classification: smileClassification(point.classification, point.synthetic === true, point.source),
      source: stringValue(point.source),
      synthetic: point.synthetic === true,
      bidIv: optionalNonNegativeNumber(point.bid_iv),
      askIv: optionalNonNegativeNumber(point.ask_iv),
      markIv: optionalNonNegativeNumber(point.mark_iv),
    }))
    .filter((point) => Number.isFinite(point.strike) && point.strike > 0 && point.iv > 0)
    .sort((left, right) => left.strike - right.strike)
  const fit = arrayValue(raw.fit)
    .map((point) => asRecord(point))
    .map((point) => ({
      strike: finiteNumber(point.strike, Number.NaN),
      iv: nonNegativeNumber(point.iv),
      ivPercent: nonNegativeNumber(point.iv_percent),
      logMoneyness: finiteNumber(point.log_moneyness, Number.NaN),
      delta: optionalFiniteNumber(point.delta),
    }))
    .filter((point) => Number.isFinite(point.strike) && point.strike > 0 && point.iv > 0)
    .sort((left, right) => left.strike - right.strike)
  return {
    points,
    fit,
    metrics: {
      rr25: optionalFiniteNumber(metrics.rr_25),
      bf25: optionalFiniteNumber(metrics.bf_25),
      atmIv: optionalNonNegativeNumber(metrics.atm_iv),
      iv25Call: optionalNonNegativeNumber(metrics.iv_25_call),
      iv25Put: optionalNonNegativeNumber(metrics.iv_25_put),
      deltaAxisAvailable: metrics.delta_axis_available === true
        && points.every((point) => point.delta != null && Number.isFinite(point.delta)),
    },
  }
}

function smileClassification(
  value: unknown,
  synthetic: boolean,
  source: unknown,
): IvSignalSmileClassification {
  if (synthetic) return 'synthetic'
  const normalized = stringValue(value).trim().toLowerCase()
  if (normalized === 'preferred' || normalized === 'fallback' || normalized === 'synthetic') {
    return normalized
  }
  return stringValue(source).toLowerCase().includes('fallback') ? 'fallback' : 'preferred'
}

function optionalFiniteNumber(value: unknown): number | null {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function mapRnd(value: unknown, spotPrice: number): IvSignalScan['rnd'] {
  const raw = asRecord(value)
  const ordering = stringValue(raw.wing_ordering)
  const sigmaOrdering = stringValue(raw.sigma_ordering)
  return {
    forward: nonNegativeNumber(raw.forward) || spotPrice,
    pBelowForward: clamp01(finiteNumber(raw.p_below_forward)),
    pAboveForward: clamp01(finiteNumber(raw.p_above_forward)),
    pLeft5: clamp01(finiteNumber(raw.p_left_5)),
    pRight5: clamp01(finiteNumber(raw.p_right_5)),
    pLeftSigma: clamp01(finiteNumber(raw.p_left_sigma)),
    pRightSigma: clamp01(finiteNumber(raw.p_right_sigma)),
    sigmaMove: nonNegativeNumber(raw.sigma_move),
    sigmaLeftStrike: optionalNonNegativeNumber(raw.sigma_left_strike),
    sigmaRightStrike: optionalNonNegativeNumber(raw.sigma_right_strike),
    atmIv: optionalNonNegativeNumber(raw.atm_iv),
    percentile05: nonNegativeNumber(raw.percentile_05),
    percentile16: nonNegativeNumber(raw.percentile_16),
    percentile25: nonNegativeNumber(raw.percentile_25),
    percentile50: nonNegativeNumber(raw.percentile_50),
    percentile75: nonNegativeNumber(raw.percentile_75),
    percentile84: nonNegativeNumber(raw.percentile_84),
    percentile95: nonNegativeNumber(raw.percentile_95),
    expectedMoveUp: nonNegativeNumber(raw.expected_move_up),
    expectedMoveDown: nonNegativeNumber(raw.expected_move_down),
    mean: nonNegativeNumber(raw.mean),
    normalizationIntegral: finiteNumber(raw.normalization_integral),
    negativeArea: nonNegativeNumber(raw.negative_area),
    wingOrdering: ordering === 'left' || ordering === 'right' ? ordering : 'balanced',
    wingSignal: signalDirection(raw.wing_signal),
    sigmaOrdering: sigmaOrdering === 'left' || sigmaOrdering === 'right' ? sigmaOrdering : 'balanced',
    sigmaSignal: signalDirection(raw.sigma_signal),
  }
}

function mapOutlook(value: unknown, fallbackVerdict: unknown): IvSignalScan['outlook'] {
  const raw = asRecord(value)
  const published = signalDirection(raw.published_verdict ?? fallbackVerdict)
  const rawVerdict = signalDirection(raw.raw_verdict ?? fallbackVerdict)
  return {
    rawVerdict,
    publishedVerdict: published,
    forming: raw.forming === true && rawVerdict !== published,
    confirmationWindow: Math.max(1, nonNegativeInteger(raw.confirmation_window) || 3),
    confirmationRequired: Math.max(1, nonNegativeInteger(raw.confirmation_required) || 2),
    rawMatchesInWindow: nonNegativeInteger(raw.raw_matches_in_window),
  }
}

function mapDirectionalMassSignal(value: unknown) {
  const raw = asRecord(value)
  return {
    signal: signalDirection(raw.signal),
    pUp: finiteNumber(raw.p_up),
    pDown: finiteNumber(raw.p_down),
    difference: finiteNumber(raw.difference),
  }
}

function mapBandSignal(value: unknown) {
  const raw = asRecord(value)
  return {
    signal: signalDirection(raw.signal),
    pBand: finiteNumber(raw.p_band),
    pOutside: finiteNumber(raw.p_outside),
    difference: finiteNumber(raw.difference),
  }
}

function mapCoverage(value: unknown): IvSignalScan['coverage'] {
  const raw = asRecord(value)
  return {
    totalExpiryRows: nonNegativeInteger(raw.total_expiry_rows),
    validIvRows: nonNegativeInteger(raw.valid_iv_rows),
    uniqueStrikes: nonNegativeInteger(raw.unique_strikes),
    droppedRows: nonNegativeInteger(raw.dropped_rows),
    duplicateRows: nonNegativeInteger(raw.duplicate_rows),
    strikeMin: nonNegativeNumber(raw.strike_min),
    strikeMax: nonNegativeNumber(raw.strike_max),
    ivCoverageRatio: clamp01(finiteNumber(raw.iv_coverage_ratio)),
    hardValidStrikes: nonNegativeInteger(raw.hard_valid_strikes),
    hardValidCoverageRatio: clamp01(finiteNumber(raw.hard_valid_coverage_ratio)),
    spotBracketed: raw.spot_bracketed === true,
    forwardBracketed: raw.forward_bracketed === true,
    impliedForward: optionalNonNegativeNumber(raw.implied_forward),
    otmReference: optionalNonNegativeNumber(raw.otm_reference),
    lowerStrikes: nonNegativeInteger(raw.lower_strikes),
    upperStrikes: nonNegativeInteger(raw.upper_strikes),
    centerLogGap: optionalNonNegativeNumber(raw.center_log_gap),
    centerGapExceeded: raw.center_gap_exceeded === true,
    tenorMinStrikes: nonNegativeInteger(raw.tenor_min_strikes) || 8,
    tenorMinSideStrikes: nonNegativeInteger(raw.tenor_min_side_strikes) || 3,
    maxCenterLogGap: nonNegativeNumber(raw.max_center_log_gap) || 0.06,
    tenorBucket: stringValue(raw.tenor_bucket) || '0_2_dte',
  }
}

function mapFreshness(value: unknown): IvSignalScan['freshness'] {
  const raw = asRecord(value)
  return {
    snapshotAgeSeconds: nonNegativeNumber(raw.snapshot_age_seconds),
    thresholdSeconds: nonNegativeNumber(raw.threshold_seconds),
    isFresh: raw.is_fresh === true,
  }
}

function mapEligibility(value: unknown): IvSignalScan['eligibility'] {
  const raw = asRecord(value)
  const requirements = asRecord(raw.requirements)
  const recommendedRefreshSeconds = nonNegativeInteger(raw.recommended_refresh_seconds)
  return {
    isZeroDte: raw.is_zero_dte === true,
    directionalEligible: raw.directional_eligible === true,
    zeroDteEligible: raw.zero_dte_eligible === true,
    recommendedRefreshSeconds: recommendedRefreshSeconds >= 60
      ? recommendedRefreshSeconds
      : 600,
    hoursToSettlement: nonNegativeNumber(raw.hours_to_settlement),
    activeSignalCount: nonNegativeInteger(raw.active_signal_count),
    alignedSignalCount: nonNegativeInteger(raw.aligned_signal_count),
    lowerCanonicalStrikes: nonNegativeInteger(raw.lower_canonical_strikes),
    upperCanonicalStrikes: nonNegativeInteger(raw.upper_canonical_strikes),
    nearestLowerGapPercent: optionalNonNegativeNumber(raw.nearest_lower_gap_percent),
    nearestUpperGapPercent: optionalNonNegativeNumber(raw.nearest_upper_gap_percent),
    requirements: {
      settlementWindow: requirements.settlement_window === true,
      curveQuality: requirements.curve_quality === true,
      twoSidedCoverage: requirements.two_sided_coverage === true,
      quoteFreshness: requirements.quote_freshness === true,
      signalAlignment: requirements.signal_alignment === true,
    },
  }
}

function mapFeed(value: unknown): IvSignalScan['feed'] {
  const raw = asRecord(value)
  const rawStatus = stringValue(raw.status)
  const status: IvSignalFeedStatus = (
    rawStatus === 'READY'
    || rawStatus === 'WARMING'
    || rawStatus === 'DEGRADED'
    || rawStatus === 'DISCONNECTED'
  ) ? rawStatus : 'DISCONNECTED'
  const rawTransport = stringValue(raw.transport)
  const rawInterval = stringValue(raw.channel_interval)
  return {
    source: stringValue(raw.source),
    transport: rawTransport === 'websocket' || rawTransport === 'snapshot'
      ? rawTransport
      : 'unknown',
    channelInterval: rawInterval === 'incremental' || rawInterval === '100ms' || rawInterval === 'agg2'
      ? rawInterval
      : 'unknown',
    status,
    connected: raw.connected === true,
    warmupComplete: raw.warmup_complete === true,
    universeIsCurrent: raw.universe_is_current === true,
    expectedExpiryInstruments: nonNegativeInteger(raw.expected_expiry_instruments),
    subscribedExpiryInstruments: nonNegativeInteger(raw.subscribed_expiry_instruments),
    initializedExpiryInstruments: nonNegativeInteger(raw.initialized_expiry_instruments),
    freshExpiryInstruments: nonNegativeInteger(raw.fresh_expiry_instruments),
    completenessRatio: clamp01(finiteNumber(raw.completeness_ratio)),
    lastMessageAt: stringValue(raw.last_message_at),
    lastMessageAgeSeconds: optionalNonNegativeNumber(raw.last_message_age_seconds),
    reconnectCount: nonNegativeInteger(raw.reconnect_count),
    connectionGeneration: nonNegativeInteger(raw.connection_generation),
    lastError: stringValue(raw.last_error),
  }
}

async function readFastApiDetail(response: Response): Promise<string> {
  try {
    const body = asRecord(await response.json() as unknown)
    return formatFastApiDetail(body.detail)
  } catch {
    return ''
  }
}

function formatFastApiDetail(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    const detail = asRecord(value)
    return stringValue(detail.msg) || stringValue(detail.message)
  }

  return value
    .map((item) => {
      const issue = asRecord(item)
      const message = stringValue(issue.msg)
      if (!message) return ''

      const location = arrayValue(issue.loc)
        .filter((part) => typeof part === 'string' || typeof part === 'number')
        .join('.')
      return location ? `${location}: ${message}` : message
    })
    .filter(Boolean)
    .join('; ')
}

function signalDirection(value: unknown): IvSignalDirection {
  const normalized = stringValue(value).trim().toUpperCase().replace(' ', '_')
  if (normalized === 'LONG' || normalized === 'SHORT') return normalized
  return 'NO_TRADE'
}

function curveQualityLevel(value: unknown): IvSignalCurveQualityLevel {
  const normalized = stringValue(value).trim().toUpperCase()
  if (normalized === 'HIGH' || normalized === 'CAUTION') return normalized
  return 'LOW'
}

function applyCustomerModePolicy(
  eligibility: SurfaceDisplayState['metricEligibility'],
): SurfaceDisplayState['metricEligibility'] {
  const densityOk = eligibility.density_chart?.available === true
  return {
    ...eligibility,
    mode: {
      available: false,
      reasonCode: densityOk ? 'mode_not_served' : (eligibility.mode?.reasonCode || 'density_rejected'),
      reason: densityOk
        ? 'Unavailable — a density mode is not served; p50 is the median, not a mode.'
        : (eligibility.mode?.reason || 'Unavailable — distribution validation failed'),
    },
  }
}

function forwardSourceQuality(value: unknown): ForwardSourceQuality {
  const normalized = stringValue(value).trim().toLowerCase()
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low' || normalized === 'unavailable') {
    return normalized
  }
  return 'unavailable'
}

function forwardSource(value: unknown): IvSignalScan['selection']['forwardSource'] {
  const normalized = stringValue(value).trim().toLowerCase()
  if (
    normalized === 'matching_future'
    || normalized === 'inverse_put_call_parity'
    || normalized === 'parity_pairs'
    || normalized === 'venue_underlying_price'
    || normalized === 'underlying_price'
    || normalized === 'spot_fallback'
  ) return normalized
  return 'unknown'
}

function optionSide(value: unknown): IvSignalIvCurvePoint['optionSide'] {
  const normalized = stringValue(value).trim().toLowerCase()
  if (
    normalized === 'call'
    || normalized === 'put'
    || normalized === 'merged'
    || normalized === 'synthetic'
  ) return normalized
  return 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown): string[] {
  return arrayValue(value)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function finiteNumber(value: unknown, fallback = 0): number {
  if (value == null || value === '' || typeof value === 'boolean') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function nonNegativeNumber(value: unknown): number {
  return Math.max(0, finiteNumber(value))
}

function optionalNonNegativeNumber(value: unknown): number | null {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : null
}

function nonNegativeInteger(value: unknown): number {
  return Math.max(0, Math.floor(finiteNumber(value)))
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
