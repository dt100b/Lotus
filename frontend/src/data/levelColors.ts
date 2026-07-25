/**
 * Intentional level-role palette (same family across Levels list + Regime map).
 *
 * - Positive Gamma → green / teal (largest positive net GEX strike)
 * - Negative Gamma → red / rose (largest negative net GEX strike)
 * - Gamma Flip → amber / yellow (polarity transition marker)
 */
export const levelColors = {
  positiveGamma: '#94c970',
  negativeGamma: '#ee5f66',
  gammaFlip: '#d0bc62',
  expectedMove: '#7fd1c8',
  /** @deprecated Prefer positiveGamma. */
  stabilizer: '#94c970',
  /** @deprecated Prefer negativeGamma. */
  amplifier: '#ee5f66',
  /** @deprecated Removed from Levels desk. */
  anchor: '#a8b7c4',
  /** @deprecated Prefer positiveGamma. */
  zeroDteCall: '#94c970',
  /** @deprecated Prefer negativeGamma. */
  zeroDtePut: '#ee5f66',
  /** @deprecated Prefer gammaFlip. */
  zeroGamma: '#a8b7c4',
} as const

/**
 * CSS custom-property accents used by Levels desk role markers.
 * Quiet-desk family (Polarity): faded mixes, not neon strong tokens.
 */
export const levelRoleCssVars = {
  positiveGamma: 'var(--desk-long, color-mix(in srgb, var(--terminal-green) 42%, transparent))',
  negativeGamma: 'var(--desk-short, color-mix(in srgb, var(--terminal-red) 40%, transparent))',
  gammaFlip: 'color-mix(in srgb, var(--terminal-yellow) 48%, transparent)',
  expectedMove: 'color-mix(in srgb, var(--terminal-blue) 44%, transparent)',
  maxPain: 'color-mix(in srgb, var(--terminal-muted) 55%, transparent)',
} as const

export const spotDistanceColors = {
  above: '#62b8ff',
  below: '#ee5f66',
  neutral: '#a8b7bd',
} as const

/** Softened spot-distance bases for quiet Levels desk (matches Polarity fade). */
export const quietSpotDistanceColors = {
  above: 'color-mix(in srgb, var(--terminal-blue) 62%, var(--terminal-muted) 38%)',
  below: 'color-mix(in srgb, var(--terminal-red) 58%, var(--terminal-muted) 42%)',
  neutral: 'var(--desk-value-soft, var(--terminal-muted))',
} as const

export const spotDistanceNeutralThresholdPercent = 0.1
export const spotDistanceFullColorThresholdPercent = 12

export function getSpotDistanceColor(
  distanceFromSpotPercent: number | undefined,
  options?: { quiet?: boolean },
) {
  const quiet = options?.quiet === true
  const palette = quiet ? quietSpotDistanceColors : spotDistanceColors

  if (distanceFromSpotPercent === undefined || !Number.isFinite(distanceFromSpotPercent)) {
    return quiet ? quietSpotDistanceColors.neutral : 'var(--terminal-muted)'
  }

  const distance = Math.abs(distanceFromSpotPercent)
  if (distance <= spotDistanceNeutralThresholdPercent) {
    return palette.neutral
  }

  const baseColor = distanceFromSpotPercent > 0 ? palette.above : palette.below
  // Quiet desk: keep more mix toward neutral so distances never go neon
  const fullWeight = quiet ? 58 : 82
  const baseWeight = quiet ? 22 : 18
  const progress = Math.min(
    1,
    (distance - spotDistanceNeutralThresholdPercent)
      / (spotDistanceFullColorThresholdPercent - spotDistanceNeutralThresholdPercent),
  )
  const easedProgress = progress * progress * (3 - 2 * progress)
  const colorWeight = Math.round(baseWeight + easedProgress * fullWeight)
  const neutral = quiet ? quietSpotDistanceColors.neutral : spotDistanceColors.neutral

  return `color-mix(in srgb, ${baseColor} ${colorWeight}%, ${neutral})`
}
