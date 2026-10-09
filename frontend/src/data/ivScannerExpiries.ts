import { normalizeLiveExpiry } from '@/api/liveTerminal'

const DAY_MS = 86_400_000
const SETTLEMENT_HOUR_UTC = 8
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

export type IvScannerExpiryRole =
  | '0dte'
  | 'eow'
  | 'next-weekly'
  | 'eom'
  | 'next-monthly'
  | 'next-quarterly'

export type IvScannerAsOf = number | string | Date

export interface IvScannerExpiryOption {
  /** Normalized API value (YYYY-MM-DD). */
  value: string
  /** Full dropdown copy, including every role assigned to this expiry. */
  label: string
  /** Compact role copy for narrow controls. */
  shortLabel: string
  /** Exposed separately so consumers do not need to parse display copy. */
  roleLabel: string
  roles: IvScannerExpiryRole[]
  settlementMs: number
}

interface ListedExpiry {
  value: string
  settlementMs: number
}

/**
 * Find a listed, still-live expiry that settles on the as-of UTC date.
 * Deribit option expiries settle at 08:00 UTC, so the same date is not 0DTE
 * after that cutoff. The returned value is always normalized to YYYY-MM-DD.
 */
export function findTrueZeroDteCandidate(
  listedExpiries: readonly string[],
  asOf: IvScannerAsOf,
): string | null {
  const asOfMs = toTimestamp(asOf)
  if (asOfMs === null) return null

  const asOfDate = formatUtcDate(new Date(asOfMs))
  return normalizeListedExpiries(listedExpiries)
    .find((expiry) => expiry.value === asOfDate && expiry.settlementMs > asOfMs)
    ?.value ?? null
}

/**
 * Curate the IV Scanner expiry menu around the expiries for which a single-
 * expiry density is most useful. Same-day expiries remain entirely hidden
 * unless the caller has already established 0DTE eligibility.
 */
export function buildIvScannerExpiryOptions(
  listedExpiries: readonly string[],
  asOf: IvScannerAsOf,
  includeEligibleZeroDte: boolean,
): IvScannerExpiryOption[] {
  const asOfMs = toTimestamp(asOf)
  if (asOfMs === null) return []

  const listed = normalizeListedExpiries(listedExpiries)
    .filter((expiry) => expiry.settlementMs > asOfMs)
  const zeroDte = findTrueZeroDteCandidate(listedExpiries, asOfMs)

  // Do not let a same-day monthly/quarterly contract bypass the 0DTE gate by
  // appearing under a structural label.
  const futureFridays = listed.filter((expiry) => (
    expiry.value !== zeroDte && isFriday(expiry.settlementMs)
  ))
  const monthEnds = futureFridays.filter((expiry) => isLastFridayOfMonth(expiry.settlementMs))
  const rolesByExpiry = new Map<string, IvScannerExpiryRole[]>()

  if (includeEligibleZeroDte && zeroDte) {
    addRole(rolesByExpiry, zeroDte, '0dte')
  }

  const [eow, nextWeekly] = futureFridays
  if (eow) addRole(rolesByExpiry, eow.value, 'eow')
  if (nextWeekly) addRole(rolesByExpiry, nextWeekly.value, 'next-weekly')

  const [eom, followingMonthEnd] = monthEnds
  if (eom) addRole(rolesByExpiry, eom.value, 'eom')
  if (followingMonthEnd) {
    addRole(
      rolesByExpiry,
      followingMonthEnd.value,
      isQuarterMonth(followingMonthEnd.settlementMs) ? 'next-quarterly' : 'next-monthly',
    )
  }

  const byValue = new Map(listed.map((expiry) => [expiry.value, expiry]))
  return [...rolesByExpiry.entries()]
    .map(([value, roles]) => {
      const expiry = byValue.get(value)
      if (!expiry) return null

      const roleLabel = formatPrimaryRole(roles)
      return {
        value,
        label: `${roleLabel} · ${formatDisplayDate(value)}`,
        shortLabel: roleLabel,
        roleLabel,
        roles,
        settlementMs: expiry.settlementMs,
      }
    })
    .filter((option): option is IvScannerExpiryOption => option !== null)
    .sort((left, right) => left.settlementMs - right.settlementMs)
}

function normalizeListedExpiries(listedExpiries: readonly string[]): ListedExpiry[] {
  const bySettlement = new Map<number, ListedExpiry>()

  for (const rawExpiry of listedExpiries) {
    const normalized = normalizeLiveExpiry(rawExpiry.trim().toUpperCase())
    const settlementMs = parseSettlementMs(normalized)
    if (settlementMs === null) continue

    bySettlement.set(settlementMs, { value: normalized, settlementMs })
  }

  return [...bySettlement.values()].sort((left, right) => left.settlementMs - right.settlementMs)
}

function parseSettlementMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  const day = Number(match[3])
  const settlementMs = Date.UTC(year, monthIndex, day, SETTLEMENT_HOUR_UTC)
  const settlement = new Date(settlementMs)

  if (
    settlement.getUTCFullYear() !== year
    || settlement.getUTCMonth() !== monthIndex
    || settlement.getUTCDate() !== day
  ) {
    return null
  }

  return settlementMs
}

function toTimestamp(value: IvScannerAsOf): number | null {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : value

  return Number.isFinite(timestamp) ? timestamp : null
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isFriday(settlementMs: number): boolean {
  return new Date(settlementMs).getUTCDay() === 5
}

function isLastFridayOfMonth(settlementMs: number): boolean {
  const settlement = new Date(settlementMs)
  if (settlement.getUTCDay() !== 5) return false

  return new Date(settlementMs + 7 * DAY_MS).getUTCMonth() !== settlement.getUTCMonth()
}

function isQuarterMonth(settlementMs: number): boolean {
  return [2, 5, 8, 11].includes(new Date(settlementMs).getUTCMonth())
}

function addRole(
  rolesByExpiry: Map<string, IvScannerExpiryRole[]>,
  expiry: string,
  role: IvScannerExpiryRole,
) {
  const roles = rolesByExpiry.get(expiry)
  if (roles) {
    if (!roles.includes(role)) roles.push(role)
    return
  }

  rolesByExpiry.set(expiry, [role])
}

function formatRole(role: IvScannerExpiryRole): string {
  if (role === '0dte') return '0DTE'
  if (role === 'eow') return 'EOW'
  if (role === 'next-weekly') return 'Weekly'
  if (role === 'eom') return 'EOM'
  if (role === 'next-quarterly') return 'EOQ'
  return 'Monthly'
}

function formatPrimaryRole(roles: readonly IvScannerExpiryRole[]): string {
  const priority: IvScannerExpiryRole[] = [
    '0dte',
    'next-quarterly',
    'eom',
    'next-monthly',
    'eow',
    'next-weekly',
  ]
  return formatRole(priority.find((role) => roles.includes(role)) ?? roles[0] ?? 'eow')
}

function formatDisplayDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value

  const month = MONTH_LABELS[Number(match[2]) - 1]
  return `${month} ${Number(match[3])}, ${match[1]}`
}
