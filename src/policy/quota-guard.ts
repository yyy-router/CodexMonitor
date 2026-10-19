/**
 * 配额守卫（纯函数，§4.3）。
 *
 * 模型：每次用户激活得 perActivation 条（§2.6），不是 24h 窗口。
 *   - 发送成功 → remaining 递减
 *   - errcode -2 → remaining 归零，转静默
 *   - 收到入站消息 → remaining 充值回 perActivation
 *   - canSend 先保 alert/critical，再保 info（reserveForAlerts）
 */

import type { Severity } from '../events.js'
import type { DeliveryResult } from '../notify/notifier.js'
import type { Config } from '../config.js'

export type QuotaGuardConfig = Config['notify']['quota']

export type QuotaGuard = {
  /** 按级别判断预算是否够发（alert/critical 永不被砍） */
  canSend(severity: Severity): boolean
  /** 投递结果回传：成功递减；errcode -2 → 归零静默 */
  onSent(result: DeliveryResult): void
  /** 入站消息 = 充值，remaining 回 perActivation */
  onInbound(): void
  remaining(): number
  isSilenced(): boolean
}

export function createQuotaGuard(_cfg: QuotaGuardConfig): QuotaGuard {
  throw new Error('Not implemented: createQuotaGuard')
}
