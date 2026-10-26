/**
 * PolicyEngine（组合器，§3/§4.3）。
 *
 * 组合 classify + aggregator + quotaTracker + quotaGuard，把 CodexEvent / NetEvent
 * 转成 Notification[]。纯逻辑，不做网络 / 文件 IO。
 */

import type { CodexEvent, NetEvent, Notification, Severity } from '../events.js'
import type { InboundMessage, DeliveryResult } from '../notify/notifier.js'
import type { Aggregator } from './aggregator.js'
import type { QuotaTracker } from './quota-tracker.js'
import type { QuotaGuard } from './quota-guard.js'

export type PolicyDeps = {
  /** 事件 → 级别（已绑定 thresholds 的 classify） */
  classify: (ev: CodexEvent | NetEvent) => Severity | null
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

const PROBE_LABEL: Record<NetEvent['verdict'], string> = {
  ok: '链路正常',
  slow: '链路延迟高',
  proxyDown: '代理节点故障',
  netDown: '整体断网',
  proxyNotRunning: '代理程序未运行',
}

/** 项目名取 cwd basename（兼容 win32 / posix，回归 #11） */
function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

export function createPolicyEngine(deps: PolicyDeps): PolicyEngine {
  const { classify: cls, aggregator, quotaTracker, quotaGuard } = deps

  const gate = (notes: Notification[]): Notification[] => {
    if (!quotaGuard) return notes
    // 批内模拟递减：多条消息不能共享同一 remaining 判断，否则会突破 reserveForAlerts
    let budget = quotaGuard.remaining()
    return notes.filter((n) => {
      const ok = quotaGuard.canSend(n.severity, budget)
      if (ok) budget -= 1
      return ok
    })
  }

  return {
    onEvent(ev, now) {
      // NetEvent：以 verdict 判别（CodexEvent 无该字段）
      if ('verdict' in ev) {
        if (cls(ev) !== 'alert') return [] // ok / slow：恢复由状态机跃迁在上层产出
        return gate([
          {
            id: `probe-${ev.verdict}-${ev.ts}`,
            ts: now,
            severity: 'alert',
            text: `🚨 网络异常：${PROBE_LABEL[ev.verdict]}`,
            source: ev.verdict,
          },
        ])
      }

      switch (ev.kind) {
        case 'quota': {
          // 耗尽 / 重置 / critical 归 tracker（含各去重标志）
          const notes = quotaTracker.process(ev, now)
          // warn 走 classify（默认关闭，30min 冷却后续 issue 补）
          const sev = cls(ev)
          if (sev === 'warn') {
            const pct = Math.round(ev.window.usedPercent)
            notes.push({
              id: `quota-warn-${ev.ts}`,
              ts: now,
              severity: 'warn',
              text: `⚠️ 额度预警：已达 ${pct}%`,
              source: 'quotaWarn',
            })
          }
          return gate(notes)
        }

        case 'turnAborted':
          return gate([
            {
              id: `abort-${ev.ts}`,
              ts: now,
              severity: 'alert',
              text: `🚨 [${projectName(ev.cwd)}] 任务被中断`,
              source: 'turnAborted',
            },
          ])

        case 'turnComplete':
          aggregator.add(
            {
              project: projectName(ev.cwd),
              summary: ev.lastAgentMessage,
              durationMs: ev.durationMs,
              ts: ev.ts,
            },
            now,
          )
          return []

        case 'turnStarted':
          return []
      }
    },

    tick(now) {
      const notes = [quotaTracker.tick(now), aggregator.maybeFlush(now)]
        .flat()
        .filter((n): n is Notification => n != null)
      return gate(notes)
    },

    onInbound() {
      quotaGuard?.onInbound()
    },

    onDelivery(result) {
      quotaGuard?.onSent(result)
    },
  }
}
