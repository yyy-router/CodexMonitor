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

/** 发件箱（投递失败待重试）在 StateStore 里的键 */
export const PENDING_STATE_KEY = 'pending'

/** 单条通知的最大投递次数（含首次），超过即放弃，避免队列无限增长 */
export const MAX_DELIVERY_ATTEMPTS = 6

/** 退避基数：5s → 10s → 20s → 40s → 80s */
const RETRY_BASE_MS = 5_000
const retryDelayMs = (attempts: number): number => RETRY_BASE_MS * 2 ** (attempts - 1)

/** 投递失败、等待重试的通知（已按分片拆好） */
type PendingNote = {
  note: Notification
  /** 已失败次数 */
  attempts: number
  /** 下次可重试的时刻，unix 毫秒 */
  nextAttemptAt: number
}

/** 网络恢复通知文案 */
export const RECOVERY_TEXT = '✅ 网络已恢复正常'

/** 运行时事件：TUI 的只读数据源；观察者抛错不得影响投递 */
export type RuntimeEvent =
  | { type: 'delivered'; note: Readonly<Notification>; result: Readonly<DeliveryResult> }
  | { type: 'probe'; result: ProbeResult; transition: StateTransition; state: ProbeState }
  | { type: 'quota'; snapshot: QuotaSnapshot }
  | { type: 'pending'; count: number }

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
  /** 观察者；抛错只记日志 */
  onEvent?: (e: RuntimeEvent) => void
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
  /** 发一条测试通知：走完整投递链路（分片 / 发件箱 / 投递日志 / 事件） */
  sendTest(): Promise<void>
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
  let lastEmittedQuota = ''
  let pending: PendingNote[] = []
  let lastPending = ''
  let lastPendingEmitted = -1

  const emit = (e: RuntimeEvent): void => {
    if (!deps.onEvent) return
    try {
      deps.onEvent(e)
    } catch (err) {
      log(`事件观察者异常：${errText(err)}`)
    }
  }

  /** 只在内容变化时落盘，避免每秒 tick 都写文件 */
  const persistQuota = (): void => {
    const snapshot = quota.snapshot()
    const json = JSON.stringify(snapshot)
    // 先发事件：落盘失败（磁盘满 / 目录只读）不该让 TUI 停在旧额度上
    if (json !== lastEmittedQuota) {
      lastEmittedQuota = json
      emit({ type: 'quota', snapshot })
    }
    if (json === lastSnapshot) return
    try {
      stateStore.save(QUOTA_STATE_KEY, snapshot)
      lastSnapshot = json
    } catch (e) {
      log(`额度状态保存失败：${errText(e)}`)
    }
  }

  const persistPending = (): void => {
    const json = JSON.stringify(pending)
    if (json !== lastPending) {
      try {
        stateStore.save(PENDING_STATE_KEY, pending)
        lastPending = json
      } catch (e) {
        log(`发件箱保存失败：${errText(e)}`)
      }
    }
    if (pending.length !== lastPendingEmitted) {
      lastPendingEmitted = pending.length
      emit({ type: 'pending', count: pending.length })
    }
  }

  /** 长消息拆片；每片占 1 条配额，id 必须唯一（飞书 uuid 幂等键会去重相同 id） */
  const expand = (note: Notification): Notification[] => {
    const chunks = splitLongMessage(note.text)
    if (chunks.length === 0) return []
    if (chunks.length === 1) return [{ ...note, text: chunks[0]! }]
    return chunks.map((text, i) => ({ ...note, id: `${note.id}#${i + 1}`, text }))
  }

  /**
   * 投递：先把到期的发件箱重试掉，再发新通知。
   * 失败的通知按原 id 入队（飞书 uuid 幂等，重发不会重复送达），
   * 指数退避重试，超过 MAX_DELIVERY_ATTEMPTS 次后放弃。
   */
  const deliver = async (notes: Notification[]): Promise<void> => {
    const at = now()
    const due = pending.filter((p) => p.nextAttemptAt <= at)
    pending = pending.filter((p) => p.nextAttemptAt > at)

    const batch: PendingNote[] = [
      ...due,
      ...notes.flatMap(expand).map((note) => ({ note, attempts: 0, nextAttemptAt: 0 })),
    ]

    for (const item of batch) {
      let result: DeliveryResult
      try {
        result = await notifier.send(item.note)
      } catch (e) {
        result = { ok: false, reason: errText(e) }
      }

      policy.onDelivery(result)
      deliveryLog.record({
        ts: now(),
        severity: item.note.severity,
        source: item.note.source,
        text: item.note.text,
        ok: result.ok,
        reason: result.reason,
        errcode: result.errcode,
        messageId: result.messageId,
      })
      // 传副本：观察者（TUI）只能读，不能改写重试决策
      emit({ type: 'delivered', note: { ...item.note }, result: { ...result } })

      if (!result.ok) {
        const attempts = item.attempts + 1
        if (attempts < MAX_DELIVERY_ATTEMPTS) {
          pending.push({ note: item.note, attempts, nextAttemptAt: now() + retryDelayMs(attempts) })
        } else {
          log(
            `投递失败已达上限，放弃：${item.note.id}（${result.reason ?? result.errcode ?? 'unknown'}）`,
          )
        }
      }
    }

    persistPending()
  }

  return {
    async start() {
      const saved = stateStore.load<QuotaSnapshot>(QUOTA_STATE_KEY)
      if (saved) quota.restore(saved)
      const restored = quota.snapshot()
      lastSnapshot = JSON.stringify(restored)
      lastEmittedQuota = lastSnapshot
      emit({ type: 'quota', snapshot: restored })

      // 上次进程遗留的未送达通知：重启后继续重试
      const savedPending = stateStore.load<PendingNote[]>(PENDING_STATE_KEY)
      pending = Array.isArray(savedPending)
        ? savedPending.filter(
            (p): p is PendingNote =>
              typeof p === 'object' &&
              p !== null &&
              typeof p.note?.id === 'string' &&
              typeof p.attempts === 'number' &&
              typeof p.nextAttemptAt === 'number',
          )
        : []
      lastPending = JSON.stringify(pending)
      lastPendingEmitted = pending.length
      emit({ type: 'pending', count: pending.length })

      await notifier.start()
    },

    async stop() {
      persistQuota()
      persistPending()
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

      emit({ type: 'probe', result, transition, state })

      return { verdict: result.verdict, transition, state }
    },

    async sendTest() {
      const at = now()
      await deliver([
        {
          id: `manual-test-${at}`,
          ts: at,
          severity: 'info',
          text: '🔔 CodexMonitor 测试通知',
          source: 'manualTest',
        },
      ])
    },
  }
}
