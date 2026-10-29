import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMonitor } from '../src/index.js'
import { DEFAULT_CONFIG, type Config } from '../src/config.js'
import type { Notification } from '../src/events.js'
import type { DeliveryResult, Notifier } from '../src/notify/notifier.js'
import type { ProbeResult } from '../src/probe/targets.js'
import type { RuntimeEvent } from '../src/runtime.js'

const dirs: string[] = []

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codexmonitor-mon-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class RecordingNotifier implements Notifier {
  sent: Notification[] = []
  started = 0
  stopped = 0

  async start(): Promise<void> {
    this.started++
  }

  async stop(): Promise<void> {
    this.stopped++
  }

  async send(n: Notification): Promise<DeliveryResult> {
    this.sent.push(n)
    return { ok: true, messageId: `m-${this.sent.length}` }
  }
}

const okProbe = async (): Promise<ProbeResult> => ({
  mode: 'proxy',
  l1: { ok: true, status: null, latencyMs: 1 },
  l2: { ok: true, status: 200, latencyMs: 1 },
  l3: { ok: true, status: 200, latencyMs: 1 },
  verdict: 'ok',
})

const cfg = (dir: string): Config => ({
  ...DEFAULT_CONFIG,
  notify: { ...DEFAULT_CONFIG.notify, channel: 'console' },
  codex: { ...DEFAULT_CONFIG.codex, sessionsDir: dir },
  state: { dir },
  probe: { ...DEFAULT_CONFIG.probe, enabled: true, intervalMs: 1000, retryDelayMs: 100 },
})

describe('createMonitor', () => {
  it('sendTest 走真实投递并发出 delivered 事件', async () => {
    const dir = makeDir()
    const notifier = new RecordingNotifier()
    const events: RuntimeEvent[] = []
    const monitor = createMonitor(cfg(dir), {
      notifier,
      probe: okProbe,
      log: () => {},
      tickIntervalMs: 3_600_000,
      onEvent: (e) => events.push(e),
    })
    await monitor.start()
    await monitor.sendTest()

    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]!.source).toBe('manualTest')
    expect(events.some((e) => e.type === 'delivered')).toBe(true)

    await monitor.stop()
  })

  it('暂停探针后不再探测，恢复后立即补跑一轮', async () => {
    vi.useFakeTimers()
    const dir = makeDir()
    let calls = 0
    const monitor = createMonitor(cfg(dir), {
      notifier: new RecordingNotifier(),
      probe: async () => {
        calls++
        return okProbe()
      },
      log: () => {},
      tickIntervalMs: 3_600_000,
    })
    await monitor.start()

    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)

    monitor.setProbePaused(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)

    monitor.setProbePaused(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)

    await monitor.stop()
  })

  it('stop 幂等，通道只停一次', async () => {
    const dir = makeDir()
    const notifier = new RecordingNotifier()
    const monitor = createMonitor(cfg(dir), {
      notifier,
      probe: okProbe,
      log: () => {},
      tickIntervalMs: 3_600_000,
    })
    await monitor.start()
    await monitor.stop()
    await monitor.stop()
    expect(notifier.stopped).toBe(1)
  })

  it('观察者抛错不影响投递', async () => {
    const dir = makeDir()
    const notifier = new RecordingNotifier()
    const monitor = createMonitor(cfg(dir), {
      notifier,
      probe: okProbe,
      log: () => {},
      tickIntervalMs: 3_600_000,
      onEvent: () => {
        throw new Error('boom')
      },
    })
    await monitor.start()
    await expect(monitor.sendTest()).resolves.toBeUndefined()
    expect(notifier.sent).toHaveLength(1)
    await monitor.stop()
  })
})
