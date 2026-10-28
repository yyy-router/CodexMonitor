import { describe, it, expect, afterEach } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { main } from '../src/index.js'
import { ConsoleNotifier } from '../src/notify/console-notifier.js'
import { DEFAULT_CONFIG, type Config } from '../src/config.js'
import type { ProbeResult } from '../src/probe/targets.js'

const dirs: string[] = []

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codexmonitor-e2e-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const okProbe = async (): Promise<ProbeResult> => ({
  mode: 'proxy',
  l1: { ok: true, status: null, latencyMs: 1 },
  l2: { ok: true, status: 200, latencyMs: 1 },
  l3: { ok: true, status: 200, latencyMs: 1 },
  verdict: 'ok',
})

/** 每个 rollout 文件首行必须是 session_meta，tailer 才会跟踪 */
const metaLine = (cwd = 'd:\\code_store\\大论文'): string =>
  JSON.stringify({
    timestamp: new Date(0).toISOString(),
    type: 'session_meta',
    payload: { id: 'sess-1', session_id: 'sess-1', cwd },
  })

const eventLine = (payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload })

/**
 * 跑一次完整链路：启动 main（真实 tailer + 真实文件）→ 写会话文件 → 追加事件 →
 * 等通知落到 ConsoleNotifier → 停止。
 */
const runScenario = async (
  payload: Record<string, unknown>,
): Promise<{ logs: string[]; stateDir: string }> => {
  const base = makeDir()
  const sessionsDir = path.join(base, 'sessions')
  const stateDir = path.join(base, 'state')
  mkdirSync(sessionsDir, { recursive: true })

  const logs: string[] = []
  const ac = new AbortController()
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    notify: {
      ...DEFAULT_CONFIG.notify,
      channel: 'console',
      aggregate: { ...DEFAULT_CONFIG.notify.aggregate, minIntervalMs: 0 },
    },
    codex: { ...DEFAULT_CONFIG.codex, sessionsDir },
    state: { dir: stateDir },
    probe: { ...DEFAULT_CONFIG.probe, enabled: false },
  }

  const done = main(cfg, {
    notifier: new ConsoleNotifier({ log: (line) => logs.push(line) }),
    signal: ac.signal,
    probe: okProbe,
    log: () => {},
    tickIntervalMs: 20,
  })

  // 先落 session_meta，让 tailer 跟踪并把基线设在 EOF；再追加业务事件
  const file = path.join(sessionsDir, 'rollout-2026-01-01T00-00-00-sess-1.jsonl')
  writeFileSync(file, `${metaLine()}\n`, 'utf8')
  await delay(100)
  appendFileSync(file, `${eventLine(payload)}\n`, 'utf8')

  const deadline = Date.now() + 700
  while (logs.length === 0 && Date.now() < deadline) await delay(20)

  ac.abort()
  await done
  return { logs, stateDir }
}

describe('端到端（真实文件 → tailer → PolicyEngine → ConsoleNotifier）', () => {
  it('turn_aborted → 立即推送 alert，并写入投递日志', async () => {
    const { logs, stateDir } = await runScenario({
      type: 'turn_aborted',
      turn_id: 't1',
      reason: 'interrupted',
    })

    expect(logs).toEqual(['[alert] 🚨 [大论文] 任务被中断'])

    const logFile = path.join(stateDir, 'delivery.jsonl')
    expect(existsSync(logFile)).toBe(true)
    expect(JSON.parse(readFileSync(logFile, 'utf8').trim())).toMatchObject({
      ok: true,
      source: 'turnAborted',
    })
  })

  it('token_count 100% → 额度耗尽 alert，并把额度快照落盘', async () => {
    const { logs, stateDir } = await runScenario({
      type: 'token_count',
      rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: null } },
    })

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('5 小时额度已用尽')

    const snapshot = JSON.parse(readFileSync(path.join(stateDir, 'quota.json'), 'utf8'))
    expect(snapshot).toMatchObject({ fiveHour: { usedPercent: 100, waiting: true } })
  })
})
