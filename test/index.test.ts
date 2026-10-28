import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { main, createNotifier, expandHome } from '../src/index.js'
import { ConsoleNotifier } from '../src/notify/console-notifier.js'
import { DEFAULT_CONFIG, type Config } from '../src/config.js'
import type { Notifier } from '../src/notify/notifier.js'
import type { ProbeResult } from '../src/probe/targets.js'

const dirs: string[] = []

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codexmonitor-main-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const okProbe = async (): Promise<ProbeResult> => ({
  mode: 'proxy',
  l1: { ok: true, status: null, latencyMs: 1 },
  l2: { ok: true, status: 200, latencyMs: 1 },
  l3: { ok: true, status: 200, latencyMs: 1 },
  verdict: 'ok',
})

const downProbe = async (): Promise<ProbeResult> => ({
  mode: 'proxy',
  l1: { ok: true, status: null, latencyMs: 1 },
  l2: { ok: false, status: 0, latencyMs: null },
  l3: { ok: true, status: 200, latencyMs: 1 },
  verdict: 'proxyDown',
})

const noopNotifier = (): Notifier => ({
  start: async () => {},
  stop: async () => {},
  send: async () => ({ ok: true }),
})

/** 探针相关的配置：缩短间隔，tick 拉长避免干扰 */
const probeCfg = (dir: string): Config => ({
  ...DEFAULT_CONFIG,
  notify: { ...DEFAULT_CONFIG.notify, channel: 'console' },
  codex: { ...DEFAULT_CONFIG.codex, sessionsDir: dir },
  state: { dir },
  probe: { ...DEFAULT_CONFIG.probe, enabled: true, intervalMs: 15000, retryDelayMs: 3000 },
})

const TICK_OFF = 3_600_000

describe('expandHome', () => {
  it('展开 ~ 与 ~/ 前缀', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/.codex/sessions')).toBe(path.join(homedir(), '.codex', 'sessions'))
  })

  it('普通路径原样返回', () => {
    expect(expandHome('/tmp/x')).toBe('/tmp/x')
    expect(expandHome('C:\\data\\sessions')).toBe('C:\\data\\sessions')
  })
})

describe('createNotifier', () => {
  it("channel='ilink' 明确报错（本轮不兼容 iLink）", () => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      notify: { ...DEFAULT_CONFIG.notify, channel: 'ilink' },
    }
    expect(() => createNotifier(cfg)).toThrow(/iLink/)
  })

  it("channel='console' 返回控制台通道（本地验证用，无需凭证）", () => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      notify: { ...DEFAULT_CONFIG.notify, channel: 'console' },
    }
    expect(createNotifier(cfg)).toBeInstanceOf(ConsoleNotifier)
  })

  it("channel='feishu' 返回可用通道", () => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      notify: { ...DEFAULT_CONFIG.notify, channel: 'feishu' },
      feishu: { appId: 'a', appSecret: 's', email: 'e@x.com', mobile: '' },
    }
    expect(typeof createNotifier(cfg).send).toBe('function')
  })
})

describe('main', () => {
  it('启动完成后收到停止信号 → 优雅退出并停止 notifier', async () => {
    const dir = makeDir()
    const ac = new AbortController()
    const events: string[] = []
    const notifier: Notifier = {
      start: async () => {
        events.push('start')
        ac.abort() // 启动后立刻请求停止
      },
      stop: async () => {
        events.push('stop')
      },
      send: async () => ({ ok: true }),
    }
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      codex: { ...DEFAULT_CONFIG.codex, sessionsDir: dir },
      state: { dir },
    }

    await main(cfg, { notifier, signal: ac.signal, probe: okProbe, log: () => {} })

    expect(events).toEqual(['start', 'stop'])
  })

  it('探针正常 → 下一次在 intervalMs 后', async () => {
    vi.useFakeTimers()
    const dir = makeDir()
    const ac = new AbortController()
    let calls = 0
    const probe = async (): Promise<ProbeResult> => {
      calls++
      return okProbe()
    }

    const p = main(probeCfg(dir), {
      notifier: noopNotifier(),
      signal: ac.signal,
      probe,
      tickIntervalMs: TICK_OFF,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(14_999)
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(14_999)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2)

    ac.abort()
    await p
  })

  it('探针故障未确认 → 按 retryDelayMs 快速重试；确认后回到 intervalMs', async () => {
    vi.useFakeTimers()
    const dir = makeDir()
    const ac = new AbortController()
    let calls = 0
    const probe = async (): Promise<ProbeResult> => {
      calls++
      return downProbe()
    }

    const p = main(probeCfg(dir), {
      notifier: noopNotifier(),
      signal: ac.signal,
      probe,
      tickIntervalMs: TICK_OFF,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(2_999)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2) // 第 2 次失败 → 进入报警

    await vi.advanceTimersByTimeAsync(14_999)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(3) // 报警态不再快速重试

    ac.abort()
    await p
  })

  it('探针抛错 → 按 retryDelayMs 重试，不崩溃', async () => {
    vi.useFakeTimers()
    const dir = makeDir()
    const ac = new AbortController()
    let calls = 0
    const probe = async (): Promise<ProbeResult> => {
      calls++
      throw new Error('probe boom')
    }

    const p = main(probeCfg(dir), {
      notifier: noopNotifier(),
      signal: ac.signal,
      probe,
      tickIntervalMs: TICK_OFF,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls).toBe(2)

    ac.abort()
    await p
  })

  it('停止时等待在途探针结束', async () => {
    vi.useFakeTimers()
    const dir = makeDir()
    const ac = new AbortController()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = false
    const probe = async (): Promise<ProbeResult> => {
      started = true
      await gate
      return okProbe()
    }

    const p = main(probeCfg(dir), {
      notifier: noopNotifier(),
      signal: ac.signal,
      probe,
      tickIntervalMs: TICK_OFF,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(started).toBe(true)

    let resolved = false
    void p.then(() => {
      resolved = true
    })
    ac.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(false) // 在途探针未结束，main 不该先返回

    release()
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(resolved).toBe(true)
  })

  it('启动失败 → 移除信号监听', async () => {
    const dir = makeDir()
    const sigintBefore = process.listenerCount('SIGINT')
    const sigtermBefore = process.listenerCount('SIGTERM')
    const notifier: Notifier = {
      start: async () => {
        throw new Error('bad creds')
      },
      stop: async () => {},
      send: async () => ({ ok: true }),
    }

    await expect(
      main(probeCfg(dir), { notifier, log: () => {} }),
    ).rejects.toThrow('bad creds')

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore)
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
  })
})
