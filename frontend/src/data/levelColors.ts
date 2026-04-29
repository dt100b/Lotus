export const levelColors = {
  zeroDteCall: '#38c6f4',
  zeroDtePut: '#ff7ab8',
  zeroGamma: '#9fb0bd',
  expectedMove: '#7fd1c8',
  gammaFlip: '#f59f3d',
} as const

export const spotDistanceColors = {
  above: '#62b8ff',
  below: '#ee5f66',
  neutral: '#a8b7bd',
} as const

export const spotDistanceNeutralThresholdPercent = 0.1
export const spotDistanceFullColorThresholdPercent = 12

export function getSpotDistanceColor(distanceFromSpotPercent: number | undefined) {
  if (distanceFromSpotPercent === undefined || !Number.isFinite(distanceFromSpotPercent)) {
    return 'var(--terminal-muted)'
  }

  const distance = Math.abs(distanceFromSpotPercent)
  if (distance <= spotDistanceNeutralThresholdPercent) {
    return spotDistanceColors.neutral
  }

  const baseColor = distanceFromSpotPercent > 0 ? spotDistanceColors.above : spotDistanceColors.below
  const progress = Math.min(
    1,
    (distance - spotDistanceNeutralThresholdPercent)
      / (spotDistanceFullColorThresholdPercent - spotDistanceNeutralThresholdPercent),
  )
  const easedProgress = progress * progress * (3 - 2 * progress)
  const colorWeight = Math.round(18 + easedProgress * 82)

  return `color-mix(in srgb, ${baseColor} ${colorWeight}%, ${spotDistanceColors.neutral})`
}
