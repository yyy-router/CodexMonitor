/**
 * 事件 → 级别（纯函数，§4.3）。
 *
 * 返回 null 表示不推（turnStarted / 无关事件 / 长思考）。
 * 级别映射见设计文档 §4.3 表格。
 */

import type { CodexEvent, NetEvent, Severity } from '../events.js'
import type { Config } from '../config.js'

export type Thresholds = Config['notify']['thresholds']

export function classify(
  _ev: CodexEvent | NetEvent,
  _thresholds: Thresholds,
): Severity | null {
  throw new Error('Not implemented: classify')
}
