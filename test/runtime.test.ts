import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRuntime, type RuntimeDeps } from '../src/runtime.js'
import { createPolicyEngine } from '../src/policy/engine.js'
import { classify } from '../src/policy/classify.js'
import { createAggregator } from '../src/policy/aggregator.js'
import { createQuotaTracker } from '../src/policy/quota-tracker.js'
import { createQuotaGuard } from '../src/policy/quota-guard.js'
import { createStateStore } from '../src/store/state-store.js'
import { createDeliveryLog } from '../src/notify/delivery-log.js'
import { DEFAULT_CONFIG } from '../src/config.js'
import type { CodexEvent, Notification, ProbeVerdict } from '../src/events.js'
import type { DeliveryResult, Notifier } from '../src/notify/notifier.js'
import type { ProbeResult } from '../src/probe/targets.js'

const dirs: string[] = []

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codexmonitor-rt-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class RecordingNotifier implements Notifier {
  sent: Notification[] = []
  started = 0
  stopped = 0

  constructor(private readonly result: DeliveryResult = { ok: true, messageId: 'm' }) {}

  async start(): Promise<void> {
    this.started++
  }

  async stop(): Promise<void> {
    this.stopped++
  }

  async send(n: Notification): Promise<DeliveryResult> {
    this.sent.push(n)
    return this.result.ok ? { ...this.result, messageId: `m-${this.sent.length}` } : { ...this.result }
  }
}

const probeResult = (verdict: ProbeVerdict, latencyMs = 10): ProbeResult => {
  const up = verdict === 'ok' || verdict === 'slow'
  return {
    l1: { ok: verdict !== 'proxyNotRunning', status: null, latencyMs: 1 },
    l2: { ok: up, status: up ? 200 : 0, latencyMs: up ? latencyMs : null },
    l3: { ok: true, status: 200, latencyMs: 1 },
    verdict,
  }
}

const thresholds = DEFAULT_CONFIG.notify.thresholds

const makeRuntime = (over: Partial<RuntimeDeps> = {}) => {
  const dir = makeDir()
  const notifier = new RecordingNotifier()
  const quota = createQuotaTracker({ thresholds })
  const quotaGuard = createQuotaGuard(DEFAULT_CONFIG.ilink.quota)
  const policy = createPolicyEngine({
    classify: (ev) => classify(ev, thresholds),
    aggregator: createAggregator({ minIntervalMs: 0, maxItems: 5, maxPerDay: 10 }),
    quotaTracker: quota,
    quotaGuard,
  })
  const stateStore = createStateStore(dir)
  const deliveryLog = createDeliveryLog(dir)
  const rt = createRuntime({
    cfg: DEFAULT_CONFIG,
    notifier,
    policy,
    quota,
    stateStore,
    deliveryLog,
    probe: async () => probeResult('ok'),
    now: () => 1_000_000,
    ...over,
  })
  return { rt, notifier, quota, quotaGuard, stateStore, deliveryLog, dir }
}

const note = (over: Partial<Notification> = {}): Notification => ({
  id: 'n1',
  ts: 1,
  severity: 'alert',
  text: '内容',
  source: 'test',
  ...over,
})

const turnAborted = (): CodexEvent => ({
  ts: 1,
  sessionId: 's',
  cwd: '/proj',
  kind: 'turnAborted',
  turnId: 't1',
  reason: 'interrupted',
})

const turnComplete = (): CodexEvent => ({
  ts: 1,
  sessionId: 's',
  cwd: '/proj',
  kind: 'turnComplete',
  turnId: 't1',
  durationMs: 1000,
  timeToFirstTokenMs: null,
  lastAgentMessage: 'done',
})

const quotaEvent = (usedPercent: number): CodexEvent => ({
  ts: 1,
  sessionId: 's',
  cwd: '/proj',
  kind: 'quota',
  window: { windowMinutes: 300, usedPercent, resetsAt: null },
})

const readLog = (dir: string): Array<Record<string, unknown>> =>
  readFileSync(path.join(dir, 'delivery.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe('createRuntime', () => {
  it('deliver：超长消息分片投递，每片 ≤ 2000 且逐片留痕', async () => {
    const { rt, notifier, dir } = makeRuntime()
    await rt.deliver([note({ severity: 'info', text: 'x'.repeat(4500) })])

    expect(notifier.sent).toHaveLength(3)
    expect(notifier.sent.map((n) => n.id)).toEqual(['n1#1', 'n1#2', 'n1#3'])
    expect(notifier.sent.every((n) => n.text.length <= 2000)).toBe(true)
    expect(readLog(dir)).toHaveLength(3)
  })

  it('ingest：turnAborted 立即投递 alert', async () => {
    const { rt, notifier, dir } = makeRuntime()
    await rt.ingest([turnAborted()])

    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]!.severity).toBe('alert')
    expect(readLog(dir)[0]).toMatchObject({ ok: true, source: 'turnAborted' })
  })

  it('ingest：quota 事件落盘额度快照', async () => {
    const { rt, stateStore } = makeRuntime()
    await rt.ingest([quotaEvent(100)])

    expect(stateStore.load('quota')).toMatchObject({
      fiveHour: { windowMinutes: 300, usedPercent: 100, waiting: true },
    })
  })

  it('tick：聚合池 flush 后投递 info', async () => {
    const { rt, notifier } = makeRuntime()
    await rt.ingest([turnComplete()])
    expect(notifier.sent).toHaveLength(0)

    await rt.tick()
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]!.source).toBe('turnCompleteAggregated')
  })

  it('deliver 回写配额守卫：成功递减，errcode -2 归零', async () => {
    const ok = makeRuntime()
    await ok.rt.deliver([note()])
    expect(ok.quotaGuard.remaining()).toBe(9)

    const failing = makeRuntime({ notifier: new RecordingNotifier({ ok: false, errcode: -2 }) })
    await failing.rt.deliver([note()])
    expect(failing.quotaGuard.remaining()).toBe(0)
  })

  it('deliver：notifier 抛异常记为失败，不中断', async () => {
    const throwing: Notifier = {
      start: async () => {},
      stop: async () => {},
      send: async () => {
        throw new Error('boom')
      },
    }
    const { rt, dir } = makeRuntime({ notifier: throwing })
    await expect(rt.deliver([note()])).resolves.toBeUndefined()
    expect(readLog(dir)[0]).toMatchObject({ ok: false, reason: 'boom' })
  })

  it('probeRound：连续确认才报警，恢复需连续 ok', async () => {
    const verdicts: ProbeVerdict[] = ['proxyDown', 'proxyDown', 'proxyDown', 'ok', 'ok']
    const { rt, notifier } = makeRuntime({ probe: async () => probeResult(verdicts.shift()!) })

    const r1 = await rt.probeRound()
    expect(r1.transition).toBe('none')
    expect(notifier.sent).toHaveLength(0)

    const r2 = await rt.probeRound()
    expect(r2.transition).toBe('enteredAlert')
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]!.severity).toBe('alert')
    expect(notifier.sent[0]!.source).toBe('proxyDown')

    const r3 = await rt.probeRound() // 报警态继续故障 → 不重复报警
    expect(r3.transition).toBe('none')
    expect(notifier.sent).toHaveLength(1)

    const r4 = await rt.probeRound() // 第 1 次 ok
    expect(r4.transition).toBe('none')
    expect(notifier.sent).toHaveLength(1)

    const r5 = await rt.probeRound() // 第 2 次 ok → 恢复
    expect(r5.transition).toBe('recovered')
    expect(notifier.sent).toHaveLength(2)
    expect(notifier.sent[1]!.severity).toBe('info')
    expect(notifier.sent[1]!.source).toBe('probeRecovered')
  })

  it('start：恢复额度快照；stop：启停 notifier', async () => {
    const { rt, notifier, stateStore } = makeRuntime()
    stateStore.save('quota', {
      fiveHour: {
        windowMinutes: 300,
        usedPercent: 100,
        resetsAt: 100,
        waiting: true,
        notifiedExhausted: true,
        notifiedReset: false,
        notifiedCritical: false,
        lastResetResetsAt: null,
        lastProcessedTs: 10,
        lastUpdatedAt: 10,
      },
    })

    await rt.start()
    expect(notifier.started).toBe(1)

    // 恢复的证据：waiting 且已过计划重置时间 → tick 产出重置通知
    await rt.tick()
    expect(notifier.sent.some((n) => n.source === 'quotaReset')).toBe(true)

    await rt.stop()
    expect(notifier.stopped).toBe(1)
  })
})
