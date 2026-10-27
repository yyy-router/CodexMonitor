/**
 * 编排核心（§3）：把 PolicyEngine 的产出送进 Notifier，并维护额度状态。
 *
 * 这里只做「投递 + 记账 + 持久化」，不含定时器 —— 定时循环在 index.ts，
 * 这样整层可以用假时钟 / 假通道完整单测。
 */

import type { CodexEvent, NetEvent, Notification, ProbeVerdict } from './events.js'
import type { Config } from './config.js'
import type { PolicyEngine } from './policy/engine.js'
import type { QuotaSnapshot, QuotaTracker } from './policy/quota-tracker.js'
import type { DeliveryResult, Notifier } from './notify/notifier.js'
import { splitLongMessage } from './notify/notifier.js'
import type { DeliveryLog } from './notify/delivery-log.js'
import type { StateStore } from './store/state-store.js'
import {
  createProbeStateMachine,
  type ProbeState,
  type StateTransition,
} from './probe/state-machine.js'
import type { ProbeResult } from './probe/targets.js'

/** 额度快照在 StateStore 里的键 */
export const QUOTA_STATE_KEY = 'quota'

/** 网络恢复通知文案 */
export const RECOVERY_TEXT = '✅ 网络已恢复正常'

export type RuntimeDeps = {
  cfg: Config
  notifier: Notifier
  policy: PolicyEngine
  /** 额度状态机（engine 内部也在用，这里单独持有以便快照/恢复） */
  quota: QuotaTracker
  stateStore: StateStore
  deliveryLog: DeliveryLog
  /** 跑一轮网络探测；由 index 注入（真实探测或测试替身） */
  probe: () => Promise<ProbeResult>
  now?: () => number
  log?: (line: string) => void
}

export type ProbeRoundResult = {
  verdict: ProbeVerdict
  transition: StateTransition
  state: ProbeState
}

export type Runtime = {
  /** 恢复额度快照并启动通道（通道凭证错误在此 fail-fast） */
  start(): Promise<void>
  /** 落盘额度状态并停止通道 */
  stop(): Promise<void>
  /** 分片投递：每片单独发送、单独留痕、单独回写配额守卫 */
  deliver(notes: Notification[]): Promise<void>
  /** 消费一轮 Codex 事件 */
  ingest(events: CodexEvent[]): Promise<void>
  /** 定时 tick：聚合 flush + 额度倒计时 */
  tick(): Promise<void>
  /** 跑一轮探测；仅在状态跃迁时产出通知（报警 / 恢复） */
  probeRound(): Promise<ProbeRoundResult>
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { cfg, notifier, policy, quota, stateStore, deliveryLog, probe } = deps
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((line: string) => console.log(line))
  const stateMachine = createProbeStateMachine({
    confirmAttempts: cfg.probe.confirmAttempts,
    recoverAttempts: cfg.probe.recoverAttempts,
  })

  let lastSnapshot = ''

  /** 只在内容变化时落盘，避免每秒 tick 都写文件 */
  const persistQuota = (): void => {
    const snapshot = quota.snapshot()
    const json = JSON.stringify(snapshot)
    if (json === lastSnapshot) return
    try {
      stateStore.save(QUOTA_STATE_KEY, snapshot)
      lastSnapshot = json
    } catch (e) {
      log(`额度状态保存失败：${errText(e)}`)
    }
  }

  const deliver = async (notes: Notification[]): Promise<void> => {
    for (const note of notes) {
      const chunks = splitLongMessage(note.text)
      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i]!
        // 每片占 1 条配额，id 必须唯一（飞书 uuid 幂等键会去重相同 id）
        const part: Notification =
          chunks.length === 1 ? { ...note, text } : { ...note, id: `${note.id}#${i + 1}`, text }

        let result: DeliveryResult
        try {
          result = await notifier.send(part)
        } catch (e) {
          result = { ok: false, reason: errText(e) }
        }

        policy.onDelivery(result)
        deliveryLog.record({
          ts: now(),
          severity: part.severity,
          source: part.source,
          text,
          ok: result.ok,
          reason: result.reason,
          errcode: result.errcode,
          messageId: result.messageId,
        })
      }
    }
  }

  return {
    async start() {
      const saved = stateStore.load<QuotaSnapshot>(QUOTA_STATE_KEY)
      if (saved) quota.restore(saved)
      lastSnapshot = JSON.stringify(quota.snapshot())
      await notifier.start()
    },

    async stop() {
      persistQuota()
      await notifier.stop()
    },

    deliver,

    async ingest(events) {
      const at = now()
      await deliver(events.flatMap((ev) => policy.onEvent(ev, at)))
      persistQuota()
    },

    async tick() {
      await deliver(policy.tick(now()))
      persistQuota()
    },

    async probeRound() {
      const result = await probe()
      const at = now()
      const { transition, state } = stateMachine.next({ verdict: result.verdict, now: at })

      if (transition === 'enteredAlert') {
        const ev: NetEvent = { ts: at, verdict: result.verdict, latencyMs: result.l2.latencyMs }
        await deliver(policy.onEvent(ev, at))
      } else if (transition === 'recovered') {
        // engine 只负责故障告警；恢复通知由状态机跃迁在上层产出（engine.ts 注释）
        await deliver([
          {
            id: `probe-recovered-${at}`,
            ts: at,
            severity: 'info',
            text: RECOVERY_TEXT,
            source: 'probeRecovered',
          },
        ])
      }

      return { verdict: result.verdict, transition, state }
    },
  }
}
