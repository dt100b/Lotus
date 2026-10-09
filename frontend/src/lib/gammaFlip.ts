/**
 * @deprecated Prefer `@/lib/zeroGamma`. Re-exports kept for any residual imports.
 */
export {
  ZERO_GAMMA_MIN_MASS_FRACTION as GAMMA_FLIP_MIN_MASS_FRACTION,
  ZERO_GAMMA_MAX_DISTANCE_FRAC as GAMMA_FLIP_MAX_DISTANCE_FRAC,
  ZERO_GAMMA_ONE_SIDED_MIN_FRAC as GAMMA_FLIP_ONE_SIDED_MIN_FRAC,
  estimateZeroGamma,
  estimateZeroGamma as estimateGammaFlipZone,
  barsToZeroGammaInput,
  barsToZeroGammaInput as barsToFlipInput,
  type ZeroGammaResult as GammaFlipResult,
  type ZeroGammaBar as GammaFlipBar,
} from '@/lib/zeroGamma'
