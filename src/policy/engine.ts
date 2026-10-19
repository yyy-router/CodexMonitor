/**
 * PolicyEngine（组合器，§3/§4.3）。
 *
 * 组合 classify + aggregator + quotaTracker + quotaGuard，把 CodexEvent / NetEvent
 * 转成 Notification[]。纯逻辑，不做网络 / 文件 IO。
 */

import { classify } from './classify.js'
import type { CodexEvent, NetEvent, Notification } from '../events.js'
import type { InboundMessage, DeliveryResult } from '../notify/notifier.js'
import type { Aggregator } from './aggregator.js'
import type { QuotaTracker } from './quota-tracker.js'
import type { QuotaGuard } from './quota-guard.js'

export type PolicyDeps = {
  classify: typeof classify
  aggregator: Aggregator
  quotaTracker: QuotaTracker
  /** 投递守卫。iLink 有会话额度守卫；飞书 webhook 无，缺省即不设防（恒可发） */
  quotaGuard?: QuotaGuard
}

export type PolicyEngine = {
  /** 投喂一个 Codex / 网络事件，产出待发通知 */
  onEvent(ev: CodexEvent | NetEvent, now: number): Notification[]
  /** tick 循环调用（聚合 flush + 倒计时） */
  tick(now: number): Notification[]
  /** 入站消息（iLink 下用于配额充值；无守卫时 no-op） */
  onInbound(msg: InboundMessage): void
  /** 投递结果回传，供守卫记账（无守卫时 no-op） */
  onDelivery(result: DeliveryResult): void
}

export function createPolicyEngine(_deps: PolicyDeps): PolicyEngine {
  throw new Error('Not implemented: createPolicyEngine')
}
