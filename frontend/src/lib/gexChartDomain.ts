/**
 * Dynamic GEX chart domain helpers.
 *
 * Optimal approach for sparse, often one-sided GEX books:
 * 1. TradingView-style outer margin (~22%) so the peak sits near 78% of its
 *    half-axis — more air than 15%, without the old mock-era ±10/20M floors.
 * 2. **Mirrored** domains for Net GEX *strike bars*: size both sides from the
 *    larger |peak| + outer buffer so zero is centered on the GEX axis.
 * 3. **Asymmetric** domains for profile/area and other signed series: left from
 *    max |negative|, right from max positive (avoids empty half-pane on
 *    one-sided books when centering is less important).
 * 4. Domain edges follow peak/(1−margin) and are not hard-snapped to ticks
 *    (tick snap used to erase margin changes). Ticks are independent grids.
 */

/** Soft floor so empty / near-empty books still have a readable axis. */
export const MIN_GEX_DOMAIN_USD = 1_000_000

/**
 * Outer margin: free fraction of each used side beyond the data peak.
 * 22% is the sweet spot in the 20–25% range for spiky GEX bars/profiles.
 */
export const GEX_MARGIN_OUTER = 0.22

/**
 * Opposite-side pad when a book is entirely one-sided (keeps 0 off the edge).
 * Slightly tighter than outer so one-sided charts don't waste the empty half.
 */
export const GEX_MARGIN_OPPOSITE = 0.18

/**
 * Expand a data peak so it sits inside the plot with outer% free space.
 * peak / (1 − outer)  e.g. 4.09M @ 22% → ~5.24M.
 */
export function applyOuterMargin(peakAbs: number, outer = GEX_MARGIN_OUTER): number {
  const peak = finiteNonNegative(peakAbs)
  if (peak <= 0) return 0
  const clamped = Math.min(Math.max(outer, 0), 0.45)
  return peak / (1 - clamped)
}

/**
 * Symmetric domain half-width [−D, +D]. Used by Net GEX strike bars so zero is
 * centered. Prefer {@link getSignedGexDomain} for profile/area series where
 * each side sizes independently.
 */
export function getSymmetricGexDomainMax(peakAbsGex: number): number {
  return domainFromPeak(peakAbsGex)
}

/**
 * One-sided domain max for absolute concentration charts: [0, D].
 */
export function getAbsoluteGexDomainMax(peakAbsGex: number): number {
  return domainFromPeak(peakAbsGex)
}

/**
 * Signed GEX domain from independent positive and negative peaks.
 * Used by profile/area charts and other asymmetric signed series.
 */
export function getSignedGexDomain(
  maxPositiveGex: number,
  minNegativeGex: number,
): [number, number] {
  const pos = Math.max(finiteNumber(maxPositiveGex), 0)
  const negMag = Math.max(-finiteNumber(minNegativeGex), 0)

  if (pos <= 0 && negMag <= 0) {
    return [-MIN_GEX_DOMAIN_USD, MIN_GEX_DOMAIN_USD]
  }

  // Opposite pad: fraction of the active peak so zero isn't glued to the edge.
  const oppositePeak = Math.max(pos, negMag) * GEX_MARGIN_OPPOSITE
  const oppositePad = Math.max(
    domainFromPeak(oppositePeak, GEX_MARGIN_OPPOSITE),
    MIN_GEX_DOMAIN_USD * GEX_MARGIN_OPPOSITE,
  )

  if (pos <= 0) {
    return [-domainFromPeak(negMag), oppositePad]
  }
  if (negMag <= 0) {
    return [-oppositePad, domainFromPeak(pos)]
  }

  return [-domainFromPeak(negMag), domainFromPeak(pos)]
}

/**
 * Net GEX strike-bar domain: keep the usual outer buffer on the side with the
 * larger |gamma| peak, then mirror that half-width so the GEX axis is symmetric
 * about zero. Example: peak −8.83M → D ≈ 8.83M / 0.78 → [−D, +D].
 */
export function getMirroredGexDomain(
  maxPositiveGex: number,
  minNegativeGex: number,
): [number, number] {
  const pos = Math.max(finiteNumber(maxPositiveGex), 0)
  const negMag = Math.max(-finiteNumber(minNegativeGex), 0)
  const peakAbs = Math.max(pos, negMag)
  const half = getSymmetricGexDomainMax(peakAbs)
  return [-half, half]
}

/** Alias — profile area charts use independent pos/neg domains. */
export function getProfileGexDomain(
  maxPositiveGex: number,
  minNegativeGex: number,
): [number, number] {
  return getSignedGexDomain(maxPositiveGex, minNegativeGex)
}

/**
 * Domain edge from a data peak: margin expansion, then soft ceil only when
 * already extremely close to a nice step.
 */
export function domainFromPeak(peakAbs: number, outer = GEX_MARGIN_OUTER): number {
  const padded = applyOuterMargin(peakAbs, outer)
  if (padded <= 0) return MIN_GEX_DOMAIN_USD
  return softCeilDomain(Math.max(padded, MIN_GEX_DOMAIN_USD))
}

/**
 * Light snap: if value is within 2% of the next nice step, take the step;
 * otherwise keep the continuous margin-based value.
 */
export function softCeilDomain(value: number): number {
  const safe = Math.max(Math.abs(finiteNumber(value)), MIN_GEX_DOMAIN_USD)
  const step = getGexTickStep(safe)
  const ceil = Math.ceil(safe / step) * step
  if (ceil - safe <= step * 0.02) {
    return ceil
  }
  return safe
}

/** Hard tick-aligned ceil (rarely needed). */
export function getRoundedDomainMax(value: number): number {
  const safeValue = Math.max(Math.abs(finiteNumber(value)), MIN_GEX_DOMAIN_USD)
  const step = getGexTickStep(safeValue)
  return Math.ceil(safeValue / step) * step
}

/**
 * Tick step scales with domain size so low-single-digit-M books get 1M ticks.
 */
export function getGexTickStep(domainMax: number): number {
  const abs = Math.max(Math.abs(finiteNumber(domainMax)), MIN_GEX_DOMAIN_USD)

  if (abs <= 5_000_000) return 1_000_000
  if (abs <= 12_000_000) return 2_000_000
  if (abs <= 25_000_000) return 5_000_000
  if (abs <= 60_000_000) return 10_000_000
  if (abs <= 120_000_000) return 20_000_000
  if (abs <= 250_000_000) return 50_000_000
  return 100_000_000
}

/**
 * Symmetric ticks for [−domainMax, +domainMax].
 */
export function buildSymmetricMillionTicks(domainMax: number): number[] {
  return buildGexAxisTicks(-Math.abs(domainMax), Math.abs(domainMax))
}

/**
 * Strike-ladder scale: always five evenly spaced ticks
 *   [−D, −D/2, 0, +D/2, +D]
 * so the narrow DOM strip never looks gapped or thinned-uneven.
 * D is a nice 1–2–2.5–3–4–5–6–8–10 magnitude covering peak + outer margin.
 */
export function buildLadderAxisScale(peakAbsGex: number): {
  maxAbs: number
  ticks: number[]
} {
  const peak = Math.max(finiteNonNegative(peakAbsGex), 0)
  const padded = Math.max(applyOuterMargin(peak), MIN_GEX_DOMAIN_USD)
  const maxAbs = niceCeilLadderDomain(padded)
  const half = maxAbs / 2
  return {
    maxAbs,
    ticks: [-maxAbs, -half, 0, half, maxAbs],
  }
}

/**
 * Ceil to a ladder-friendly nice number. Includes 3/4/6/8 so a ~5.2M pad
 * snaps to 6M (ticks ±6 / ±3) instead of jumping all the way to 10M.
 */
function niceCeilLadderDomain(value: number): number {
  const safe = Math.max(finiteNonNegative(value), MIN_GEX_DOMAIN_USD)
  const exp = 10 ** Math.floor(Math.log10(safe))
  const fraction = safe / exp
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  for (const step of steps) {
    if (fraction <= step + 1e-9) return step * exp
  }
  return 10 * exp
}

/**
 * Axis ticks across an arbitrary [domainMin, domainMax] (asymmetric OK).
 * Grid lines stay on nice steps; domain edges may sit past the outer ticks.
 */
export function buildGexAxisTicks(domainMin: number, domainMax: number): number[] {
  const lo = Math.min(finiteNumber(domainMin), finiteNumber(domainMax))
  const hi = Math.max(finiteNumber(domainMin), finiteNumber(domainMax))
  const extent = Math.max(Math.abs(lo), Math.abs(hi), MIN_GEX_DOMAIN_USD)
  const step = getGexTickStep(extent)

  const start = Math.ceil(lo / step) * step
  const end = Math.floor(hi / step) * step
  const ticks: number[] = []

  // Ensure 0 is present when the domain crosses or touches zero.
  if (lo <= 0 && hi >= 0) {
    ticks.push(0)
  }

  for (let tick = start; tick <= end + step * 1e-9; tick += step) {
    const rounded = Math.round(tick / step) * step
    if (Math.abs(rounded) < step * 1e-9) continue // already added 0
    if (rounded < lo - step * 1e-9 || rounded > hi + step * 1e-9) continue
    ticks.push(rounded)
  }

  return ticks.sort((a, b) => a - b)
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function finiteNonNegative(value: number): number {
  return Math.max(finiteNumber(value), 0)
}
