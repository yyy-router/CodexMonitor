import { describe, it, expect } from 'vitest'
import { restartMonitor } from '../../src/cli/reload.js'
import type { Monitor } from '../../src/index.js'
import { DEFAULT_CONFIG, type Config } from '../../src/config.js'

const makeMonitor = (events: string[], name: string, failStart = false): Monitor => ({
  start: async () => {
    if (failStart) throw new Error(`${name} start failed`)
    events.push(`${name}:start`)
  },
  stop: async () => {
    events.push(`${name}:stop`)
  },
  sendTest: async () => {},
  setProbePaused: () => {},
})

const nextCfg: Config = {
  ...DEFAULT_CONFIG,
  notify: { ...DEFAULT_CONFIG.notify, channel: 'console' },
}

describe('restartMonitor', () => {
  it('先停旧核心，再启动新核心，返回新核心', async () => {
    const events: string[] = []
    const old = makeMonitor(events, 'old')
    const next = makeMonitor(events, 'new')

    const result = await restartMonitor(old, nextCfg, { create: () => next })

    expect(result).toBe(next)
    expect(events).toEqual(['old:stop', 'new:start'])
  })

  it('新核心启动失败 → 清理后抛错（调用方负责回滚）', async () => {
    const events: string[] = []
    const old = makeMonitor(events, 'old')
    const broken = makeMonitor(events, 'new', true)

    await expect(restartMonitor(old, nextCfg, { create: () => broken })).rejects.toThrow(
      'new start failed',
    )
    expect(events).toEqual(['old:stop', 'new:stop'])
  })
})
