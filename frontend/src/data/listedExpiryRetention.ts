import type { VolSurfaceListedExpiry } from './mockTerminal'

/** Hold the front contract's last valid display value across quote rejections. */
export function retainFrontExpiryIv(
  rows: VolSurfaceListedExpiry[],
  previous: VolSurfaceListedExpiry | null,
  nowMs = Date.now(),
): { rows: VolSurfaceListedExpiry[]; front: VolSurfaceListedExpiry | null } {
  const front = rows[0]
  if (!front || front.expiryTsMs <= nowMs) return { rows, front: null }
  if (front.status === 'ok' && front.atmIvPercent != null
    && Number.isFinite(front.atmIvPercent) && front.atmIvPercent > 0) {
    return { rows, front }
  }
  // A new expiry must earn its own value; never carry today's IV into tomorrow.
  if (!previous || previous.expiryTsMs !== front.expiryTsMs) return { rows, front: null }
  const held = { ...previous, dteDays: front.dteDays }
  return { rows: [held, ...rows.slice(1)], front: previous }
}
