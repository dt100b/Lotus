/**
 * Iso-GEX contour extraction (marching squares) for gamma surface ridge borders.
 *
 * Two independent contour families share this extractor:
 *   1. Magnitude isolines ("Lines") — equal-|GEX| ridges (non-zero levels)
 *   2. Zero-gamma contour ("Flip") — net GEX = 0 polarity boundary
 *
 * Contours are level sets of the signed unit GEX field. They are NOT the
 * neutral/void fill (that is mid-ramp color).
 */

/** Default magnitude isolines in signed unit space (excludes zero / Flip). */
export const DEFAULT_CONTOUR_LEVELS = [-0.75, -0.5, -0.28, 0.28, 0.5, 0.75] as const

/** Zero-gamma / Flip contour level (net GEX polarity boundary). */
export const ZERO_GAMMA_CONTOUR_LEVEL = 0 as const

export type ContourSegment = {
  x0: number
  y0: number
  x1: number
  y1: number
  level: number
}

/**
 * Extract polyline segments for each isoline level over a dense field grid.
 * field is row-major: field[y * cols + x], values in signed unit [-1, +1].
 * Coordinates are returned in the same unit space as cell size (1 unit = 1 cell).
 */
export function extractContourSegments(
  field: Float32Array,
  cols: number,
  rows: number,
  levels: readonly number[] = DEFAULT_CONTOUR_LEVELS,
): ContourSegment[] {
  if (cols < 2 || rows < 2 || field.length < cols * rows) return []

  const out: ContourSegment[] = []
  for (const level of levels) {
    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const v00 = field[row * cols + col]!
        const v10 = field[row * cols + col + 1]!
        const v01 = field[(row + 1) * cols + col]!
        const v11 = field[(row + 1) * cols + col + 1]!
        const idx =
          (v00 >= level ? 8 : 0)
          | (v10 >= level ? 4 : 0)
          | (v11 >= level ? 2 : 0)
          | (v01 >= level ? 1 : 0)
        if (idx === 0 || idx === 15) continue

        const segs = marchingSegments(idx, col, row, 1, 1, v00, v10, v01, v11, level)
        for (const [ax, ay, bx, by] of segs) {
          out.push({ x0: ax, y0: ay, x1: bx, y1: by, level })
        }
      }
    }
  }
  return out
}

/**
 * Extract only the zero-gamma (Flip) contour — net GEX polarity boundary.
 * Independent of magnitude isolines so callers can style it differently.
 */
export function extractZeroGammaContour(
  field: Float32Array,
  cols: number,
  rows: number,
): ContourSegment[] {
  return extractContourSegments(field, cols, rows, [ZERO_GAMMA_CONTOUR_LEVEL])
}

/**
 * Strip zero from a level list so magnitude isolines never duplicate Flip.
 */
export function magnitudeContourLevels(
  levels: readonly number[],
  eps = 1e-6,
): number[] {
  return levels.filter((l) => Math.abs(l) > eps)
}

function marchingSegments(
  idx: number,
  x: number,
  y: number,
  w: number,
  h: number,
  v00: number,
  v10: number,
  v01: number,
  v11: number,
  level: number,
): Array<[number, number, number, number]> {
  const lerp = (_a: number, _b: number, va: number, vb: number) => {
    const d = vb - va
    if (Math.abs(d) < 1e-12) return 0.5
    return (level - va) / d
  }

  const topX = x + w * lerp(0, 1, v00, v10)
  const topY = y
  const rightX = x + w
  const rightY = y + h * lerp(0, 1, v10, v11)
  const bottomX = x + w * lerp(0, 1, v01, v11)
  const bottomY = y + h
  const leftX = x
  const leftY = y + h * lerp(0, 1, v00, v01)

  // Standard marching-squares edge cases (saddle: pick consistent diagonal).
  switch (idx) {
    case 1:
    case 14:
      return [[leftX, leftY, bottomX, bottomY]]
    case 2:
    case 13:
      return [[bottomX, bottomY, rightX, rightY]]
    case 3:
    case 12:
      return [[leftX, leftY, rightX, rightY]]
    case 4:
    case 11:
      return [[topX, topY, rightX, rightY]]
    case 5: {
      // Saddle
      const center = (v00 + v10 + v01 + v11) / 4
      if (center >= level) {
        return [
          [topX, topY, leftX, leftY],
          [bottomX, bottomY, rightX, rightY],
        ]
      }
      return [
        [topX, topY, rightX, rightY],
        [leftX, leftY, bottomX, bottomY],
      ]
    }
    case 6:
    case 9:
      return [[topX, topY, bottomX, bottomY]]
    case 7:
    case 8:
      return [[topX, topY, leftX, leftY]]
    case 10: {
      const center = (v00 + v10 + v01 + v11) / 4
      if (center >= level) {
        return [
          [topX, topY, rightX, rightY],
          [leftX, leftY, bottomX, bottomY],
        ]
      }
      return [
        [topX, topY, leftX, leftY],
        [bottomX, bottomY, rightX, rightY],
      ]
    }
    default:
      return []
  }
}
