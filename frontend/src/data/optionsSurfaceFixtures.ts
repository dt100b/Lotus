import type { IvSignalScan } from '../api/ivSignalScanner'
import type { SurfaceDisplayState } from './optionsSurfaceDisplay'
import { DIAGNOSTIC_DENSITY_LABEL } from './optionsSurfaceDisplay'

const idle = { signal: 'NO_TRADE' as const, pUp: 0, pDown: 0, difference: 0 }

const baseDisplay = (overrides: Partial<SurfaceDisplayState> = {}): SurfaceDisplayState => ({
  quoteStatus: 'degraded',
  smileStatus: 'degraded',
  densityStatus: 'rejected',
  surfaceDisplayStatus: 'rejected',
  reasonCodes: ['cdf_not_monotone', 'call_not_convex_in_strike'],
  humanReadableReason: 'Distribution unavailable: the implied density was not a valid monotone probability distribution.',
  diagnosticDetail: 'gate cdf_not_monotone: min_cdf_step=-2.39e-05 lt -1e-08 @ K=56105->56137.5',
  failedChecks: ['Density CDF was not monotone', 'Call-price convexity failed'],
  metricEligibility: {
    forward: { available: true, reasonCode: null, reason: null },
    index: { available: true, reasonCode: null, reason: null },
    quote_coverage: { available: true, reasonCode: null, reason: null },
    atm_iv: { available: true, reasonCode: null, reason: null },
    implied_move_1sd: { available: true, reasonCode: null, reason: null },
    rr_25: { available: true, reasonCode: null, reason: null },
    bf_25: { available: true, reasonCode: null, reason: null },
    density_chart: { available: false, reasonCode: 'density_rejected', reason: 'Unavailable — distribution validation failed' },
    median: { available: false, reasonCode: 'density_rejected', reason: 'Unavailable — distribution validation failed' },
    mode: { available: false, reasonCode: 'density_rejected', reason: 'Unavailable — distribution validation failed' },
    central_range_50: { available: false, reasonCode: 'density_rejected', reason: 'Unavailable — distribution validation failed' },
    central_range_90: { available: false, reasonCode: 'density_rejected', reason: 'Unavailable — distribution validation failed' },
    tail_probabilities: { available: false, reasonCode: 'density_rejected', reason: 'Unavailable — distribution validation failed' },
    digital_probabilities: { available: false, reasonCode: 'density_rejected', reason: 'Unavailable — distribution validation failed' },
  },
  servedFitterName: 'tv_pchip',
  servedFitterGrade: 'diagnostic',
  researchFitterName: 'svi_raw',
  researchFailedChecks: ['Research SVI candidate failed convexity diagnostics; it is not used for the displayed surface.'],
  researchHumanReason: 'Research SVI candidate failed convexity diagnostics; it is not used for the displayed surface.',
  customerWarningScope: 'served',
  servingMode: 'diagnostic_candidate',
  configVersion: 'surface_serving.v1',
  configHash: 'fixture',
  primaryFailureCategory: 'hard_gate',
  residualBudgetOk: null,
  ...overrides,
})

function scanFixture(overrides: Partial<IvSignalScan> = {}): IvSignalScan {
  return {
    asOf: '2026-08-16T23:00:57.159956+00:00',
    underlying: 'BTC',
    expiry: '2026-08-21',
    settlementAt: '2026-08-21T08:00:00+00:00',
    spotPrice: 62860.55,
    timeToExpiryYears: 0.01198,
    parameters: { tailThreshold: 0.02, bandWidth: 0.03, signalDelta: 0.03 },
    ivCurve: [],
    smile: {
      points: [
        { strike: 55000, iv: 0.52, ivPercent: 52, logMoneyness: -0.13, delta: -0.12, optionSide: 'put', classification: 'preferred', source: 'put_otm_mark_iv', synthetic: false, bidIv: 0.48, askIv: 0.56, markIv: 0.52 },
        { strike: 62885, iv: 0.27, ivPercent: 27, logMoneyness: 0, delta: 0.5, optionSide: 'merged', classification: 'synthetic', source: 'synthetic_atm', synthetic: true, bidIv: null, askIv: null, markIv: 0.27 },
        { strike: 68000, iv: 0.28, ivPercent: 28, logMoneyness: 0.08, delta: 0.12, optionSide: 'call', classification: 'preferred', source: 'call_otm_mark_iv', synthetic: false, bidIv: 0.26, askIv: 0.30, markIv: 0.28 },
      ],
      fit: [
        { strike: 55000, iv: 0.52, ivPercent: 52, logMoneyness: -0.13, delta: -0.12 },
        { strike: 62885, iv: 0.25, ivPercent: 25, logMoneyness: 0, delta: 0.5 },
        { strike: 68000, iv: 0.28, ivPercent: 28, logMoneyness: 0.08, delta: 0.12 },
      ],
      metrics: { rr25: -2.2, bf25: 0.5, atmIv: 0.25, iv25Call: 0.248, iv25Put: 0.271, deltaAxisAvailable: true },
    },
    density: [],
    servedCdf: null,
    diagnosticDensity: {
      label: DIAGNOSTIC_DENSITY_LABEL,
      isValidDistribution: false,
      strikesUsd: [55000, 56000, 62885, 68000],
      rawDensity: [0.00001, -0.00002, 0.00004, 0.00001],
    },
    markers: { spot: 62885, tailLower: Number.NaN, tailUpper: Number.NaN, bandLower: Number.NaN, bandUpper: Number.NaN, peakStrike: Number.NaN },
    signals: { skew: idle, tails: idle, peak: { signal: 'NO_TRADE', peakStrike: 62885, shiftPercent: 0 }, band: { signal: 'NO_TRADE', pBand: 0, pOutside: 0, difference: 0 } },
    modelVerdict: 'NO_TRADE',
    verdict: 'NO_TRADE',
    rnd: {
      forward: 62885,
      pBelowForward: 0, pAboveForward: 0, pLeft5: 0, pRight5: 0, pLeftSigma: 0, pRightSigma: 0,
      sigmaMove: 0.028, sigmaLeftStrike: 61160, sigmaRightStrike: 64655, atmIv: 0.25,
      percentile05: Number.NaN, percentile16: Number.NaN, percentile25: Number.NaN, percentile50: Number.NaN,
      percentile75: Number.NaN, percentile84: Number.NaN, percentile95: Number.NaN,
      expectedMoveUp: 1770, expectedMoveDown: 1722, mean: 62885,
      normalizationIntegral: 0.985, negativeArea: 0.00024,
      wingOrdering: 'balanced', wingSignal: 'NO_TRADE', sigmaOrdering: 'balanced', sigmaSignal: 'NO_TRADE',
    },
    outlook: { rawVerdict: 'NO_TRADE', publishedVerdict: 'NO_TRADE', forming: false, confirmationWindow: 3, confirmationRequired: 2, rawMatchesInWindow: 0 },
    suppressionReasons: ['density_rejected', 'surface_rejected'],
    selection: {
      policy: 'options_surface_v1', ivBasis: 'mark_iv', source: 'options_surface', verifiedLiveQuotes: true,
      inputRows: 36, expiryRows: 36, validQuoteRows: 16, selectedMarketStrikes: 13,
      preferredSideSelections: 13, oppositeSideFallbacks: 0, atmMergedSelections: 0, atmSingleSideSelections: 0,
      methodology: 'options_surface_v1', syntheticAnchorAdded: true,
      rejectedInvalidContractRows: 0, rejectedInvalidIvRows: 0, rejectedMissingQuoteRows: 0,
      rejectedZeroBidRows: 5, rejectedCrossedQuoteRows: 0, rejectedStaleQuoteRows: 0, rejectedNonOpenRows: 0,
      rejectedMissingSizeRows: 0, rejectedInvalidIvMarketRows: 15, rejectedWideSpreadRows: 0,
      rejectedLowDeltaRows: 0, rejectedLowOpenInterestRows: 0, coverageCorridor: null, deltaCutoff: null,
      impliedForward: 62885, forwardSource: 'matching_future', forwardSourceQuality: 'high', forwardPairCount: 3, otmReference: 62885,
      medianSelectedIvSpreadPercentagePoints: 0, maxSelectedIvSpreadPercentagePoints: 0,
      maxQuoteAgeSeconds: 30, oldestSelectedQuoteAgeSeconds: 0,
    },
    curveQuality: {
      level: 'LOW', signalEligible: false, negativeGridPoints: 16, gridPointCount: 401,
      negativeGridFraction: 0.04, negativeArea: 0.00024, positiveArea: 0.985,
      normalizationIntegral: 0.985, clippingRequired: false, sparseCenter: false,
    },
    coverage: {
      totalExpiryRows: 36, validIvRows: 16, uniqueStrikes: 13, droppedRows: 20, duplicateRows: 0,
      strikeMin: 55000, strikeMax: 68000, ivCoverageRatio: 0, hardValidStrikes: 13, hardValidCoverageRatio: 0,
      spotBracketed: true, forwardBracketed: true, impliedForward: 62885, otmReference: 62885,
      lowerStrikes: 7, upperStrikes: 6, centerLogGap: 0.016, centerGapExceeded: false,
      tenorMinStrikes: 12, tenorMinSideStrikes: 4, maxCenterLogGap: 0.04, tenorBucket: '3_14_dte',
    },
    freshness: { snapshotAgeSeconds: 4, thresholdSeconds: 180, isFresh: true },
    eligibility: {
      isZeroDte: false, directionalEligible: false, zeroDteEligible: false, recommendedRefreshSeconds: 600,
      hoursToSettlement: 105, activeSignalCount: 0, alignedSignalCount: 0,
      lowerCanonicalStrikes: 7, upperCanonicalStrikes: 6, nearestLowerGapPercent: null, nearestUpperGapPercent: null,
      requirements: { settlementWindow: true, curveQuality: false, twoSidedCoverage: true, quoteFreshness: true, signalAlignment: false },
    },
    feed: {
      source: 'deribit_ticker_ws_incremental', transport: 'websocket', channelInterval: 'incremental',
      status: 'READY', connected: true, warmupComplete: true, universeIsCurrent: true,
      expectedExpiryInstruments: 36, subscribedExpiryInstruments: 36, initializedExpiryInstruments: 36,
      freshExpiryInstruments: 36, completenessRatio: 1, lastMessageAt: '2026-08-16T23:00:57Z',
      lastMessageAgeSeconds: 0, reconnectCount: 0, connectionGeneration: 1, lastError: '',
    },
    warnings: ['density_rejected'],
    display: baseDisplay(),
    ...overrides,
  }
}

export const rejectedDensityUsableSmile = scanFixture()

export const readyDensity = scanFixture({
  density: [
    { strike: 55000, raw: 0.00001, smoothed: 0.00001 },
    { strike: 62885, raw: 0.00004, smoothed: 0.00004 },
    { strike: 68000, raw: 0.00001, smoothed: 0.00001 },
  ],
  diagnosticDensity: null,
  display: baseDisplay({
    quoteStatus: 'accepted',
    smileStatus: 'accepted',
    densityStatus: 'accepted',
    surfaceDisplayStatus: 'ready',
    reasonCodes: [],
    humanReadableReason: 'Market-implied surface is ready for this expiry.',
    failedChecks: [],
    researchFailedChecks: [],
    researchHumanReason: null,
    customerWarningScope: 'none',
    metricEligibility: {
      ...baseDisplay().metricEligibility,
      density_chart: { available: true, reasonCode: null, reason: null },
      median: { available: true, reasonCode: null, reason: null },
      mode: { available: false, reasonCode: 'mode_not_served', reason: 'Unavailable — a density mode is not served; p50 is the median, not a mode.' },
      central_range_50: { available: true, reasonCode: null, reason: null },
      central_range_90: { available: true, reasonCode: null, reason: null },
    },
  }),
  servedCdf: [0.05, 0.50, 0.95],
  rnd: {
    ...scanFixture().rnd,
    percentile05: 56000,
    percentile25: 60000,
    percentile50: 62885,
    percentile75: 65000,
    percentile95: 69000,
  },
})

export const degradedDensity = scanFixture({
  density: [
    { strike: 55000, raw: 0.00001, smoothed: 0.00001 },
    { strike: 62885, raw: 0.00004, smoothed: 0.00004 },
    { strike: 68000, raw: 0.00001, smoothed: 0.00001 },
  ],
  diagnosticDensity: null,
  display: baseDisplay({
    densityStatus: 'degraded',
    surfaceDisplayStatus: 'degraded',
    reasonCodes: ['negative_density_mass'],
    humanReadableReason: 'Surface quality is degraded. Treat displayed metrics as diagnostic.',
    failedChecks: ['Negative density mass exceeded tolerance'],
    customerWarningScope: 'none',
    researchFailedChecks: [],
    researchHumanReason: null,
    metricEligibility: {
      ...baseDisplay().metricEligibility,
      density_chart: { available: true, reasonCode: null, reason: null },
      median: { available: true, reasonCode: null, reason: null },
      mode: { available: false, reasonCode: 'mode_not_served', reason: 'Unavailable — a density mode is not served; p50 is the median, not a mode.' },
      central_range_50: { available: true, reasonCode: null, reason: null },
      central_range_90: { available: true, reasonCode: null, reason: null },
    },
  }),
  servedCdf: [0.05, 0.50, 0.95],
})

const passingDensityEligibility = {
  ...baseDisplay().metricEligibility,
  density_chart: { available: true, reasonCode: null, reason: null },
  median: { available: true, reasonCode: null, reason: null },
  mode: { available: false, reasonCode: 'mode_not_served', reason: 'Unavailable — a density mode is not served; p50 is the median, not a mode.' },
  central_range_50: { available: true, reasonCode: null, reason: null },
  central_range_90: { available: true, reasonCode: null, reason: null },
}

export const servedPassResearchFail = scanFixture({
  density: [
    { strike: 55000, raw: 0.00001, smoothed: 0.00001 },
    { strike: 62885, raw: 0.00004, smoothed: 0.00004 },
    { strike: 68000, raw: 0.00001, smoothed: 0.00001 },
  ],
  diagnosticDensity: null,
  display: baseDisplay({
    quoteStatus: 'accepted',
    smileStatus: 'degraded',
    densityStatus: 'accepted',
    surfaceDisplayStatus: 'degraded',
    reasonCodes: [],
    humanReadableReason: 'Market-implied analytics — diagnostic fit',
    failedChecks: [],
    researchFitterName: 'svi_raw',
    researchFailedChecks: ['Research SVI candidate failed convexity diagnostics; it is not used for the displayed surface.'],
    researchHumanReason: 'Research SVI candidate failed convexity diagnostics; it is not used for the displayed surface.',
    customerWarningScope: 'research',
    metricEligibility: passingDensityEligibility,
  }),
  servedCdf: [0.05, 0.50, 0.95],
  rnd: {
    ...scanFixture().rnd,
    percentile05: 56000,
    percentile25: 60000,
    percentile50: 62885,
    percentile75: 65000,
    percentile95: 69000,
  },
})

export const servedFailResearchPass = scanFixture({
  display: baseDisplay({
    reasonCodes: ['call_not_convex_in_strike', 'density_rejected'],
    humanReadableReason: 'Distribution unavailable: fitted call prices were not convex across the observed strike range.',
    failedChecks: ['Call-price convexity failed'],
    researchFitterName: 'svi_raw',
    researchFailedChecks: [],
    researchHumanReason: null,
    customerWarningScope: 'served',
  }),
})

export const servedFailResearchFail = scanFixture({
  display: baseDisplay({
    reasonCodes: ['call_not_convex_in_strike', 'density_rejected'],
    humanReadableReason: 'Distribution unavailable: fitted call prices were not convex across the observed strike range.',
    failedChecks: ['Call-price convexity failed'],
    customerWarningScope: 'served',
  }),
})

export const servedPassNoResearch = scanFixture({
  density: [
    { strike: 55000, raw: 0.00001, smoothed: 0.00001 },
    { strike: 62885, raw: 0.00004, smoothed: 0.00004 },
    { strike: 68000, raw: 0.00001, smoothed: 0.00001 },
  ],
  diagnosticDensity: null,
  display: baseDisplay({
    quoteStatus: 'accepted',
    smileStatus: 'degraded',
    densityStatus: 'accepted',
    surfaceDisplayStatus: 'degraded',
    reasonCodes: [],
    humanReadableReason: 'Market-implied analytics — diagnostic fit',
    failedChecks: [],
    researchFitterName: null,
    researchFailedChecks: [],
    researchHumanReason: null,
    customerWarningScope: 'none',
    metricEligibility: passingDensityEligibility,
  }),
  servedCdf: [0.05, 0.50, 0.95],
  rnd: {
    ...scanFixture().rnd,
    percentile05: 56000,
    percentile25: 60000,
    percentile50: 62885,
    percentile75: 65000,
    percentile95: 69000,
  },
})

export const sparseRejectedSmile = scanFixture({
  smile: { points: [], fit: [], metrics: { rr25: null, bf25: null, atmIv: null, iv25Call: null, iv25Put: null, deltaAxisAvailable: false } },
  diagnosticDensity: null,
  display: baseDisplay({
    quoteStatus: 'rejected',
    smileStatus: 'rejected',
    densityStatus: 'unavailable',
    surfaceDisplayStatus: 'rejected',
    reasonCodes: ['insufficient_or_sparse_observations'],
    humanReadableReason: 'Unavailable — insufficient two-sided wing quotes',
    primaryFailureCategory: 'market_data',
    metricEligibility: {
      ...baseDisplay().metricEligibility,
      atm_iv: { available: false, reasonCode: 'smile_unavailable', reason: 'Unavailable — no accepted smile' },
      implied_move_1sd: { available: false, reasonCode: 'smile_unavailable', reason: 'Unavailable — no accepted smile' },
      rr_25: { available: false, reasonCode: 'rr_unsolved', reason: 'Unavailable — 25Δ roots did not solve inside observed smile coverage' },
      bf_25: { available: false, reasonCode: 'rr_unsolved', reason: 'Unavailable — 25Δ roots did not solve inside observed smile coverage' },
    },
  }),
})

export const residualBudgetRejected = scanFixture({
  display: baseDisplay({
    quoteStatus: 'degraded',
    smileStatus: 'degraded',
    densityStatus: 'rejected',
    surfaceDisplayStatus: 'rejected',
    reasonCodes: ['residual_budget_exceeded', 'density_rejected'],
    humanReadableReason: 'Distribution unavailable: the constrained smile residual exceeded the documented quote-quality budget.',
    failedChecks: ['Fit residual exceeded the quote-quality budget'],
    primaryFailureCategory: 'fit_quality',
    residualBudgetOk: false,
    customerWarningScope: 'served',
  }),
})

export const mediumQualityForward = scanFixture({
  density: [
    { strike: 55000, raw: 0.00001, smoothed: 0.00001 },
    { strike: 62885, raw: 0.00004, smoothed: 0.00004 },
    { strike: 68000, raw: 0.00001, smoothed: 0.00001 },
  ],
  servedCdf: [0.05, 0.50, 0.95],
  diagnosticDensity: null,
  selection: {
    ...scanFixture().selection,
    forwardSource: 'inverse_put_call_parity',
    forwardSourceQuality: 'medium',
  },
  display: baseDisplay({
    quoteStatus: 'degraded',
    smileStatus: 'accepted',
    densityStatus: 'accepted',
    surfaceDisplayStatus: 'degraded',
    reasonCodes: [],
    humanReadableReason: 'Market-implied surface is ready for this expiry.',
    failedChecks: [],
    researchFailedChecks: [],
    researchHumanReason: null,
    customerWarningScope: 'none',
    metricEligibility: passingDensityEligibility,
  }),
  rnd: {
    ...scanFixture().rnd,
    percentile05: 56000,
    percentile25: 60000,
    percentile50: 62885,
    percentile75: 65000,
    percentile95: 69000,
  },
})

export const unavailableForward = scanFixture({
  display: baseDisplay({
    quoteStatus: 'rejected',
    smileStatus: 'rejected',
    densityStatus: 'unavailable',
    surfaceDisplayStatus: 'unavailable',
    reasonCodes: ['forward_unavailable'],
    humanReadableReason: 'No accepted options-implied forward is available for this expiry.',
    metricEligibility: {
      ...baseDisplay().metricEligibility,
      forward: { available: false, reasonCode: 'forward_unavailable', reason: 'No accepted options-implied forward is available for this expiry.' },
    },
  }),
})
