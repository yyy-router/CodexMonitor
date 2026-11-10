/**
 * 工作时间判断（纯函数）。
 *
 * 仅支持同一天内的 start < end；未列在 days 中的日期全天静默。
 * timezone 为空串时使用系统本地时间，否则使用 IANA 时区。
 */

import type { WorkHoursConfig } from '../config.js'

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const clockMinutes = (value: string): number | null => {
  const m = CLOCK_RE.exec(value)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

type LocalParts = { day: number; minutes: number }

function localParts(now: number, timezone: string): LocalParts | null {
  if (timezone === '') {
    const d = new Date(now)
    return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() }
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now))
    const get = (type: string): string | undefined => parts.find((p) => p.type === type)?.value
    const day = WEEKDAY[get('weekday') ?? '']
    const hour = Number(get('hour'))
    const minute = Number(get('minute'))
    if (day == null || !Number.isInteger(hour) || !Number.isInteger(minute)) return null
    return { day, minutes: hour * 60 + minute }
  } catch {
    return null
  }
}

/** 当前时刻是否落在工作时间段内；配置异常时放行，避免误静默 */
export function isWithinWorkHours(now: number, cfg: WorkHoursConfig): boolean {
  if (!cfg.enabled) return true

  const start = clockMinutes(cfg.start)
  const end = clockMinutes(cfg.end)
  if (start == null || end == null || start >= end) return true
  if (!Array.isArray(cfg.days) || cfg.days.length === 0) return false

  const parts = localParts(now, cfg.timezone)
  if (parts == null) return true
  if (!cfg.days.includes(parts.day)) return false
  return parts.minutes >= start && parts.minutes < end
}
