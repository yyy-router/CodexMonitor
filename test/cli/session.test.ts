import { describe, it, expect } from 'vitest'
import { createSession } from '../../src/cli/session.js'
import type { Monitor } from '../../src/index.js'
import { DEFAULT_CONFIG, type Config } from '../../src/config.js'

const delay = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const makeMonitor = (
  events: string[],
  name: string,
  opts: { failStart?: boolean; gate?: Promise<void> } = {},
): Monitor => ({
  start: async () => {
    if (opts.gate) await opts.gate
    if (opts.failStart) throw new Error(`${name} start failed`)
    events.push(`${name}:start`)
  },
  stop: async () => {
    events.push(`${name}:stop`)
  },
  sendTest: async () => {},
  setProbePaused: () => {},
})

const cfg = (dir: string): Config => ({
  ...DEFAULT_CONFIG,
  notify: { ...DEFAULT_CONFIG.notify, channel: 'console' },
  codex: { ...DEFAULT_CONFIG.codex, sessionsDir: dir },
  state: { dir },
})

const cfgA = cfg('A')
const cfgB = cfg('B')

describe('createSession', () => {
  it('并发 reload 只重建一次，且返回同一个 promise', async () => {
    const events: string[] = []
    const old = makeMonitor(events, 'old')
    const replacement = makeMonitor(events, 'new')
    let created = 0
    const session = createSession(cfgA, old, {
      loadConfig: () => cfgB,
      create: () => {
        created++
        return replacement
      },
    })

    const first = session.reload()
    const second = session.reload()
    expect(second).toBe(first)

    await expect(first).resolves.toBe('配置已重载')
    expect(created).toBe(1)
    expect(session.current()).toBe(replacement)
    expect(session.currentConfig()).toBe(cfgB)
  })

  it('重载进行中 stop：等重载结束并停掉新核心', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const events: string[] = []
    const old = makeMonitor(events, 'old')
    const next = makeMonitor(events, 'new', { gate })
    const session = createSession(cfgA, old, { loadConfig: () => cfgB, create: () => next })

    const reloading = session.reload()
    await delay(0) // 旧核心已停，新核心卡在 start
    const stopping = session.stop()
    await delay(0)
    release()

    await expect(reloading).resolves.toBe('已停止')
    await stopping
    expect(events).toEqual(['old:stop', 'new:start', 'new:stop'])
    expect(session.current()).toBeUndefined()
  })

  it('新核心启动失败时用旧配置回滚', async () => {
    const events: string[] = []
    const old = makeMonitor(events, 'old')
    const broken = makeMonitor(events, 'broken', { failStart: true })
    const revived = makeMonitor(events, 'revived')
    const creates: Config[] = []
    const session = createSession(cfgA, old, {
      loadConfig: () => cfgB,
      create: (c) => {
        creates.push(c)
        return creates.length === 1 ? broken : revived
      },
    })

    await expect(session.reload()).resolves.toContain('已按上一次配置继续运行')
    expect(creates).toHaveLength(2)
    expect(creates[1]).toBe(cfgA)
    expect(session.current()).toBe(revived)
  })

  it('新配置读取失败：旧核心继续运行', async () => {
    const events: string[] = []
    const old = makeMonitor(events, 'old')
    const session = createSession(cfgA, old, {
      loadConfig: () => {
        throw new Error('bad json')
      },
      create: () => makeMonitor(events, 'new'),
    })

    await expect(session.reload()).resolves.toContain('重载失败')
    expect(events).toEqual([])
    expect(session.current()).toBe(old)
  })

  it('停止后 reload 返回「已停止」，不重建核心', async () => {
    const events: string[] = []
    const session = createSession(cfgA, makeMonitor(events, 'old'), {
      loadConfig: () => cfgB,
      create: () => makeMonitor(events, 'new'),
    })
    await session.stop()

    await expect(session.reload()).resolves.toBe('已停止')
    expect(events).toEqual(['old:stop'])
  })
})
