/**
 * 投递日志（§4.5）。
 *
 * 每次发送追加一条 JSONL（~/.codexmonitor/delivery.jsonl），留痕审计。
 */

import type { Severity } from '../events.js'

export type DeliveryLogEntry = {
  ts: number
  severity: Severity
  source: string
  text: string
  ok: boolean
  reason?: string
  errcode?: number
  messageId?: string
}

export type DeliveryLog = {
  record(entry: DeliveryLogEntry): void
}

export function createDeliveryLog(_dir: string): DeliveryLog {
  throw new Error('Not implemented: createDeliveryLog')
}
