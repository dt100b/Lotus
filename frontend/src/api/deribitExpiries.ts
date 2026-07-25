const dayMs = 86_400_000
const monthLabels = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const
const monthIndexes = Object.fromEntries(monthLabels.map((label, index) => [label, index])) as Record<string, number>

export const deribitOpexCutoffHourUtc = 8
export const defaultDeribitExpiryCounts = {
  daily: 4,
  weekly: 3,
  monthly: 3,
  quarterly: 4,
} as const

export type DeribitExpiry = string

export function getActiveDeribitExpiries(nowMs = Date.now()): DeribitExpiry[] {
  const expiries = new Map<number, DeribitExpiry>()

  addExpiryDates(expiries, getDailyExpiryDates(nowMs, defaultDeribitExpiryCounts.daily))
  addExpiryDates(expiries, getWeeklyExpiryDates(nowMs, defaultDeribitExpiryCounts.weekly))
  addExpiryDates(expiries, getMonthlyExpiryDates(nowMs, defaultDeribitExpiryCounts.monthly))
  addExpiryDates(expiries, getQuarterlyExpiryDates(nowMs, defaultDeribitExpiryCounts.quarterly))

  return [...expiries.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, label]) => label)
}

export function getNextDeribitExpiry(nowMs = Date.now()) {
  const [label] = getActiveDeribitExpiries(nowMs)
  if (!label) return null

  const date = parseDeribitExpiry(label)
  if (!date) return null

  return {
    label,
    date,
    msRemaining: Math.max(0, date.getTime() - nowMs),
  }
}

export function parseDeribitExpiry(value: string) {
  const match = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(value)
  if (!match) return null

  const [, dayValue, monthValue, yearValue] = match
  const monthIndex = monthIndexes[monthValue]
  if (monthIndex === undefined) return null

  return new Date(Date.UTC(2000 + Number(yearValue), monthIndex, Number(dayValue), deribitOpexCutoffHourUtc, 0, 0))
}

export function formatDeribitExpiry(date: Date) {
  const day = date.getUTCDate()
  const month = monthLabels[date.getUTCMonth()]
  const year = String(date.getUTCFullYear()).slice(-2)

  return `${day}${month}${year}`
}

export function getDeribitExpiryMs(expiry: string) {
  return parseDeribitExpiry(expiry)?.getTime() ?? null
}

/**
 * Deribit contract structure (options):
 *  - Weekly  → every Friday 08:00 UTC
 *  - Monthly → last Friday of each calendar month 08:00 UTC
 *  - Quarterly → last Friday of Mar / Jun / Sep / Dec 08:00 UTC
 *  - Daily   → any other listed day
 *
 * @see https://support.deribit.com (Contract Introduction Policy)
 */
export type DeribitExpiryStructure = 'daily' | 'weekly' | 'monthly' | 'quarterly'

/** Desk UI tenor tag — structural + 0DTE (front) + ALL. */
export type ExpiryTenor = 'all' | '0dte' | DeribitExpiryStructure

/** Pure Deribit structural class from the expiry date code. */
export function getDeribitExpiryStructure(expiry: string): DeribitExpiryStructure {
  const date = parseDeribitExpiry(expiry)
  if (!date) return 'daily'

  // Last Friday of month wins over plain weekly.
  if (isLastFridayOfMonth(date)) {
    // Quarter months: Mar=2, Jun=5, Sep=8, Dec=11
    return [2, 5, 8, 11].includes(date.getUTCMonth()) ? 'quarterly' : 'monthly'
  }

  return date.getUTCDay() === 5 ? 'weekly' : 'daily'
}

/**
 * Classify for labels. Front book date is always 0DTE (even if it is also
 * a Friday weekly / monthly / quarterly structurally).
 */
export function getExpiryTenor(
  expiry: string,
  frontExpiry?: string | null,
): ExpiryTenor {
  if (expiry === 'ALL') return 'all'
  if (frontExpiry && expiry === frontExpiry) return '0dte'
  return getDeribitExpiryStructure(expiry)
}

/**
 * Build select options with Deribit structural tags on every matching date:
 *  ALL · 0DTE (front) · Weekly / Monthly / Quarterly for all Fridays of that class
 *  · bare codes for plain dailies (e.g. 27JUL26)
 */
export function buildExpirySelectOptions(
  listedExpiries: string[],
): Array<{ value: string; label: string; shortLabel: string }> {
  const front = listedExpiries[0] ?? null

  return [
    { value: 'ALL', label: 'ALL', shortLabel: 'ALL' },
    ...listedExpiries.map((value) => {
      const tenor = getExpiryTenor(value, front)
      return {
        value,
        label: formatTenorExpiryLabel(value, tenor, 'full'),
        shortLabel: formatTenorExpiryLabel(value, tenor, 'short'),
      }
    }),
  ]
}

export function formatExpiryOptionLabel(
  expiry: string,
  frontExpiry?: string | null,
): string {
  return formatTenorExpiryLabel(expiry, getExpiryTenor(expiry, frontExpiry), 'full')
}

export function formatExpiryOptionShortLabel(
  expiry: string,
  frontExpiry?: string | null,
): string {
  return formatTenorExpiryLabel(expiry, getExpiryTenor(expiry, frontExpiry), 'short')
}

function formatTenorExpiryLabel(
  expiry: string,
  tenor: ExpiryTenor,
  style: 'full' | 'short',
): string {
  if (tenor === 'all') return 'ALL'
  if (tenor === '0dte') return '0DTE'
  if (tenor === 'daily') return expiry
  if (style === 'short') {
    if (tenor === 'weekly') return `W ${expiry}`
    if (tenor === 'monthly') return `M ${expiry}`
    return `Q ${expiry}`
  }
  if (tenor === 'weekly') return `Weekly ${expiry}`
  if (tenor === 'monthly') return `Monthly ${expiry}`
  return `Quarterly ${expiry}`
}

function isLastFridayOfMonth(date: Date) {
  if (date.getUTCDay() !== 5) return false
  const nextFriday = new Date(date.getTime() + 7 * dayMs)
  return nextFriday.getUTCMonth() !== date.getUTCMonth()
}

function addExpiryDates(expiries: Map<number, DeribitExpiry>, dates: Date[]) {
  for (const date of dates) {
    expiries.set(date.getTime(), formatDeribitExpiry(date))
  }
}

function getDailyExpiryDates(nowMs: number, count: number) {
  const dates: Date[] = []
  let candidate = getUtcCutoffDate(nowMs)

  if (candidate.getTime() <= nowMs) {
    candidate = addUtcDays(candidate, 1)
  }

  while (dates.length < count) {
    dates.push(candidate)
    candidate = addUtcDays(candidate, 1)
  }

  return dates
}

function getWeeklyExpiryDates(nowMs: number, count: number) {
  return collectUpcomingDates(nowMs, count, (candidate) => candidate.getUTCDay() === 5)
}

function getMonthlyExpiryDates(nowMs: number, count: number) {
  return collectUpcomingMonthEnds(nowMs, count, () => true)
}

function getQuarterlyExpiryDates(nowMs: number, count: number) {
  return collectUpcomingMonthEnds(nowMs, count, (monthIndex) => [2, 5, 8, 11].includes(monthIndex))
}

function collectUpcomingDates(nowMs: number, count: number, isMatch: (date: Date) => boolean) {
  const dates: Date[] = []
  let candidate = getUtcCutoffDate(nowMs)

  while (dates.length < count) {
    if (candidate.getTime() > nowMs && isMatch(candidate)) {
      dates.push(candidate)
    }

    candidate = addUtcDays(candidate, 1)
  }

  return dates
}

function collectUpcomingMonthEnds(nowMs: number, count: number, isEligibleMonth: (monthIndex: number) => boolean) {
  const dates: Date[] = []
  const cursor = getUtcCutoffDate(nowMs)
  let year = cursor.getUTCFullYear()
  let month = cursor.getUTCMonth()

  while (dates.length < count) {
    if (isEligibleMonth(month)) {
      const date = getLastFridayOfMonth(year, month)
      if (date.getTime() > nowMs) {
        dates.push(date)
      }
    }

    month += 1
    if (month > 11) {
      month = 0
      year += 1
    }
  }

  return dates
}

function getUtcCutoffDate(nowMs: number) {
  const now = new Date(nowMs)
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), deribitOpexCutoffHourUtc, 0, 0))
}

function addUtcDays(date: Date, days: number) {
  return new Date(date.getTime() + days * dayMs)
}

function getLastFridayOfMonth(year: number, monthIndex: number) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0, deribitOpexCutoffHourUtc, 0, 0))
  const daysSinceFriday = (lastDay.getUTCDay() - 5 + 7) % 7

  return addUtcDays(lastDay, -daysSinceFriday)
}
