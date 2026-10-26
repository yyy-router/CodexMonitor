/**
 * 配额守卫（纯函数，§4.3）—— 仅 iLink 通道的会话额度守卫。
 *
 * 飞书 webhook / 自建应用没有「10 条会话额度 + 入站重置」模型，无需此守卫。
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

export type QuotaGuardConfig = Config['ilink']['quota']

export type QuotaGuard = {
  /** 按级别判断预算是否够发（alert/critical 永不被砍）。可传外部 budget 供批处理模拟递减 */
  canSend(severity: Severity, budget?: number): boolean
  /** 投递结果回传：成功递减；errcode -2 → 归零静默 */
  onSent(result: DeliveryResult): void
  /** 入站消息 = 充值，remaining 回 perActivation */
  onInbound(): void
  remaining(): number
  isSilenced(): boolean
}

export function createQuotaGuard(cfg: QuotaGuardConfig): QuotaGuard {
  let remaining = cfg.perActivation

  return {
    canSend(severity, budget = remaining) {
      if (budget <= 0) return false // 硬墙：耗尽后一律静默
      if (severity === 'alert' || severity === 'critical') return true
      // info / warn：只用 reserveForAlerts 之外的那部分预算
      return budget > cfg.reserveForAlerts
    },

    onSent(result) {
      if (result.ok) {
        remaining = Math.max(0, remaining - 1)
      } else if (result.errcode === -2) {
        remaining = 0 // 配额耗尽，静默降级
      }
      // 其他失败（网络等）：消息未投出，不扣额度
    },

    onInbound() {
      remaining = cfg.perActivation
    },

    remaining() {
      return remaining
    },

    isSilenced() {
      return remaining <= 0
    },
  }
}
