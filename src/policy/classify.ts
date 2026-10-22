/**
 * 事件 → 级别（纯函数，§4.3）。
 *
 * 返回 null 表示不推（turnStarted / 无关事件 / 长思考）。
 * 级别映射见设计文档 §4.3 表格。
 */

import type { CodexEvent, NetEvent, Severity } from '../events.js'
import type { Config } from '../config.js'

export type Thresholds = Config['notify']['thresholds']

export function classify(ev: CodexEvent | NetEvent, t: Thresholds): Severity | null {
  // NetEvent 以 verdict 判别（CodexEvent 无该字段）
  if ('verdict' in ev) {
    switch (ev.verdict) {
      case 'proxyDown':
      case 'netDown':
      case 'proxyNotRunning':
        return 'alert'
      default:
        return null // ok / slow：恢复通知由状态机跃迁在上层产出，慢不推
    }
  }

  // CodexEvent（以 kind 判别）
  switch (ev.kind) {
    case 'turnComplete':
      return 'info'
    case 'turnAborted':
      return 'alert'
    case 'quota': {
      const p = ev.window.usedPercent
      if (p >= t.quotaExhausted) return 'alert'
      if (p >= t.quotaCritical) return 'critical'
      if (p >= t.quotaWarn) return t.warnEnabled ? 'warn' : null
      return null
    }
    default:
      return null // turnStarted 不推
  }
}
