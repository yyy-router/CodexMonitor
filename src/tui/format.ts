/** TUI 展示用的纯格式化函数；不含 IO，可完整单测 */

import type { ProbeVerdict, Severity } from '../events.js'

/** emoji、变体选择符、零宽连接符、区域指示符、肤色修饰 */
const EMOJI =
  /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu

/** TUI 不显示 emoji：通知正文保留原文，渲染前净化 */
export function stripEmoji(text: string): string {
  return text
    .replace(EMOJI, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/g, '')
}

/** 0~100 → width 格进度条；越界钳制 */
export function progressBar(percent: number, width = 10): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const filled = Math.round((p / 100) * width)
  return `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`
}

/** 探针状态图标（纯 ASCII） */
export function verdictIcon(
  verdict: ProbeVerdict,
  opts: { paused: boolean; enabled: boolean },
): string {
  if (!opts.enabled) return '[off]'
  if (opts.paused) return '[--]'
  if (verdict === 'ok') return '[OK]'
  if (verdict === 'slow') return '[~~]'
  return '[!!]'
}

/** 日志级别图标（纯 ASCII） */
export function severityIcon(severity: Severity): string {
  switch (severity) {
    case 'info':
      return '[i]'
    case 'warn':
      return '[!]'
    case 'critical':
      return '[!!]'
    case 'alert':
      return '[!!!]'
  }
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const p = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${p(h)}:${p(m)}:${p(s)}`
}

export function formatRelative(ms: number): string {
  if (ms < 1000) return '刚刚'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s 前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m 前`
  return `${Math.floor(m / 60)}h 前`
}

export function formatLatency(ms: number | null): string {
  return ms == null ? '-' : `${Math.round(ms)}ms`
}

/** 距离额度重置的倒计时：30s / 1m / 2h 13m / 5d 3h */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return '已到重置时间'
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 60) return `${totalMin}m`
  const totalHour = Math.floor(totalMin / 60)
  if (totalHour < 24) return `${totalHour}h ${totalMin % 60}m`
  return `${Math.floor(totalHour / 24)}d ${totalHour % 24}h`
}
