/** TUI 配色语义：级别 / 网络判定 / 额度阈值 → 颜色名。纯函数，便于单测 */

import type { ProbeVerdict, Severity } from '../events.js'

export function severityColor(severity: Severity): string {
  switch (severity) {
    case 'info':
      return 'gray'
    case 'warn':
      return 'yellow'
    case 'critical':
    case 'alert':
      return 'red'
  }
}

/** 严重级别加粗，让告警在列表里一眼可见 */
export function severityBold(severity: Severity): boolean {
  return severity === 'critical' || severity === 'alert'
}

export function verdictColor(verdict: ProbeVerdict, enabled: boolean): string {
  if (!enabled) return 'gray'
  if (verdict === 'ok') return 'green'
  if (verdict === 'slow') return 'yellow'
  return 'red'
}

export function quotaColor(percent: number, warnAt: number, criticalAt: number): string {
  if (percent >= criticalAt) return 'red'
  if (percent >= warnAt) return 'yellow'
  return 'green'
}
