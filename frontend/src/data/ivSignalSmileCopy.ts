import type { IvSignalScan } from '@/api/ivSignalScanner'

export function smileUnavailableCopy(
  scan: Pick<IvSignalScan, 'smile' | 'curveQuality' | 'display'>,
  refreshFailed = false,
): string {
  if (refreshFailed && (scan.smile.points.length < 2 || scan.smile.fit.length < 2)) {
    return 'Smile unavailable — live book not current'
  }
  if (scan.display?.smileStatus === 'rejected') {
    return 'Smile unavailable — calibration rejected'
  }
  if (scan.smile.points.length < 4) {
    return 'Smile unavailable — insufficient accepted IV points'
  }
  return 'Smile unavailable — insufficient accepted IV points'
}
