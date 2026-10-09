/**
 * Client-side 0DTE forward gamma projection (mock / offline fallback).
 *
 * Mirrors project/pipeline/forward_gamma_surface.py:
 * hold chain fixed, advance τ → settle, revalue net GEX via BS gamma ratios.
 */

import {
  emptyGexForwardSurface,
  type GexForwardSurface,
} from '@/api/gexForwardSurface'

const DERIBIT_SETTLE_HOUR_UTC = 8
const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000
// ~5 minutes — match pipeline; avoid settle Γ spike crushing the unit field.
const MIN_TAU_YEARS = 5 / (365.25 * 24 * 60)
const IV_PERCENT_THRESHOLD = 3
const MIN_REF_GAMMA = 1e-14

export type ForwardChainLeg = {
  strike: number
  /** Signed $ GEX / 1% at reference (S0, τ0). */
  gex0: number
  /** Decimal vol. */
  iv: number
}

export type ForwardChainInput = {
  spot: number
  /** Snapshot as-of epoch ms. */
  asOfMs?: number
  /** ISO expiry YYYY-MM-DD or Deribit-style settle ms. */
  expiry?: string
  settleMs?: number
  legs: ForwardChainLeg[]
  nTimes?: number
  nPrices?: number
  priceWindowPct?: number
}

/**
 * Build a dense forward surface from strike-level call/put GEX + IV.
 */
export function buildForwardGammaSurface(input: ForwardChainInput): GexForwardSurface {
  const spot = input.spot
  if (!(spot > 0) || !Number.isFinite(spot)) {
    return emptyGexForwardSurface('invalid spot')
  }

  const nowMs = input.asOfMs && input.asOfMs > 0 ? input.asOfMs : Date.now()
  const settleMs = input.settleMs && input.settleMs > 0
    ? input.settleMs
    : settleMsFromExpiry(input.expiry ?? '')
  if (settleMs == null || settleMs <= nowMs) {
    return emptyGexForwardSurface(
      settleMs == null ? 'unparseable expiry' : '0DTE already settled',
    )
  }

  const legs = input.legs.filter(
    (l) =>
      Number.isFinite(l.strike)
      && l.strike > 0
      && Number.isFinite(l.gex0)
      && Math.abs(l.gex0) > 0
      && Number.isFinite(l.iv)
      && l.iv > 0,
  )
  if (!legs.length) return emptyGexForwardSurface('no non-zero legs with IV')

  const tau0 = Math.max(MIN_TAU_YEARS, (settleMs - nowMs) / MS_PER_YEAR)
  const prepared: Array<{ leg: ForwardChainLeg; gRef: number }> = []
  for (const leg of legs) {
    const gRef = bsGamma(spot, leg.strike, tau0, leg.iv)
    if (gRef == null || gRef < MIN_REF_GAMMA) continue
    prepared.push({ leg, gRef })
  }
  if (!prepared.length) return emptyGexForwardSurface('no invertible reference gamma')

  const nT = Math.max(8, input.nTimes ?? 64)
  const nP = Math.max(16, input.nPrices ?? 128)
  const window = Math.max(1, input.priceWindowPct ?? 8) / 100

  let pLo = spot * (1 - window)
  let pHi = spot * (1 + window)
  for (const { leg } of prepared) {
    pLo = Math.min(pLo, leg.strike)
    pHi = Math.max(pHi, leg.strike)
  }
  const pad = Math.max((pHi - pLo) * 0.04, spot * 0.005)
  pLo = Math.max(1, pLo - pad)
  pHi = pHi + pad

  const prices: number[] = []
  for (let i = 0; i < nP; i++) {
    prices.push(pLo + ((pHi - pLo) * i) / (nP - 1))
  }

  const times: number[] = []
  for (let i = 0; i < nT; i++) {
    times.push(Math.floor(nowMs + ((settleMs - nowMs) * i) / (nT - 1)))
  }
  times[nT - 1] = settleMs - 1

  const invS0sq = 1 / (spot * spot)
  const values: number[][] = []
  for (const tMs of times) {
    const tau = Math.max(MIN_TAU_YEARS, (settleMs - tMs) / MS_PER_YEAR)
    const col: number[] = []
    for (const s of prices) {
      let total = 0
      const sSqRatio = s * s * invS0sq
      for (const { leg, gRef } of prepared) {
        const gNew = bsGamma(s, leg.strike, tau, leg.iv)
        if (gNew == null) continue
        total += leg.gex0 * (gNew / gRef) * sSqRatio
      }
      col.push(Number.isFinite(total) ? total : 0)
    }
    values.push(col)
  }

  return {
    times,
    prices,
    values,
    spot,
    settleMs,
    asOfMs: nowMs,
    expiry: input.expiry ?? '',
    meta: {
      version: 'gex_forward_surface.v1',
      methodology:
        'forward BS gamma revaluation; inventory frozen; 0DTE only; r=q=0 (client)',
      note: 'Client mock / offline forward projection',
      legCount: prepared.length,
      nTimes: nT,
      nPrices: nP,
      priceWindowPct: input.priceWindowPct ?? 8,
      tau0Years: tau0,
      tau0Hours: tau0 * 365.25 * 24,
      metric: 'gamma',
      unit: 'USD / 1% move',
      ivShift: 0,
      referenceIv: prepared[0]?.leg.iv ?? null,
      settlementStrike: prepared.reduce(
        (best, item) => Math.abs(item.leg.strike - spot) < Math.abs(best - spot)
          ? item.leg.strike
          : best,
        prepared[0]!.leg.strike,
      ),
      positioningSource: 'flow',
      positionRecovery: 'gex_inversion',
      directPositionLegCount: 0,
      referenceGexCoverage: 1,
      expiryScope: '0dte',
    },
  }
}

/**
 * Mock path: synthesize legs from strike profile without real IV.
 * Uses a mild smile so the surface still exercises soft-field paint.
 */
export function synthesizeForwardFromProfile(
  gammaBars: Array<{
    strike: number
    gammaExposureUsd?: number
    netGammaExposureUsd?: number
    callGammaExposureUsd?: number
    putGammaExposureUsd?: number
  }>,
  spot: number,
  options?: {
    asOfMs?: number
    settleMs?: number
    /** Hours of residual life when settle unknown. Default 6h. */
    residualHours?: number
    nTimes?: number
    nPrices?: number
    priceWindowPct?: number
  },
): GexForwardSurface {
  const nowMs = options?.asOfMs ?? Date.now()
  const residualH = options?.residualHours ?? 6
  const settleMs =
    options?.settleMs
    ?? nowMs + residualH * 3600_000

  const legs: ForwardChainLeg[] = []
  for (const row of gammaBars) {
    const strike = row.strike
    if (!(strike > 0)) continue
    const net = row.netGammaExposureUsd ?? row.gammaExposureUsd ?? 0
    const call = row.callGammaExposureUsd
    const put = row.putGammaExposureUsd
    // Mild smile: higher IV in the wings.
    const moneyness = Math.abs(Math.log(strike / Math.max(spot, 1)))
    const iv = Math.min(1.8, Math.max(0.25, 0.45 + moneyness * 1.4))

    if (call != null && put != null) {
      if (Math.abs(call) > 0) legs.push({ strike, gex0: call, iv })
      if (Math.abs(put) > 0) legs.push({ strike, gex0: put, iv })
    } else if (Math.abs(net) > 0) {
      // Split net 55/45 put/call near ATM bias — structural mock only.
      legs.push({ strike, gex0: net * 0.55, iv })
      legs.push({ strike, gex0: net * 0.45, iv: iv * 1.02 })
    }
  }

  return buildForwardGammaSurface({
    spot,
    asOfMs: nowMs,
    settleMs,
    legs,
    nTimes: options?.nTimes,
    nPrices: options?.nPrices,
    priceWindowPct: options?.priceWindowPct,
  })
}

export function normalizeMarkIv(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null
  let v = raw
  if (v > IV_PERCENT_THRESHOLD) v = v / 100
  if (!(v > 0) || v > 5) return null
  return v
}

export function settleMsFromExpiry(expiry: string): number | null {
  if (!expiry) return null
  const text = expiry.includes('T') ? expiry.split('T')[0]! : expiry.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (![y, mo, d].every(Number.isFinite)) return null
  return Date.UTC(y, mo - 1, d, DERIBIT_SETTLE_HOUR_UTC, 0, 0)
}

/** Black–Scholes gamma (call = put), r = q = 0. */
export function bsGamma(
  spot: number,
  strike: number,
  tYears: number,
  iv: number,
): number | null {
  if (
    !(spot > 0)
    || !(strike > 0)
    || !(tYears > 0)
    || !(iv > 0)
    || !Number.isFinite(spot)
    || !Number.isFinite(strike)
    || !Number.isFinite(tYears)
    || !Number.isFinite(iv)
  ) {
    return null
  }
  const sqrtT = Math.sqrt(tYears)
  const denom = iv * sqrtT
  if (!(denom > 0)) return null
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * tYears) / denom
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI)
  const gamma = pdf / (spot * denom)
  if (!Number.isFinite(gamma) || gamma < 0) return null
  return gamma
}
