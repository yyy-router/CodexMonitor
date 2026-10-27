import { describe, it, expect, afterEach } from 'vitest'
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const okProbe = async (): Promise<ProbeResult> => ({
  l1: { ok: true, status: null, latencyMs: 1 },
  l2: { ok: true, status: 200, latencyMs: 1 },
  l3: { ok: true, status: 200, latencyMs: 1 },
  verdict: 'ok',
})

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
})
