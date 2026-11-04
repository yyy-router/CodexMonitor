import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { App } from '../../src/tui/app.js'
import { createInitialState, createTuiStore } from '../../src/tui/store.js'
import type { Controls } from '../../src/index.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const setup = () => {
  const store = createTuiStore(createInitialState({ channel: 'console', probeEnabled: true, now: 0 }))
  const calls: string[] = []
  const controls: Controls = {
    sendTest: async () => {
      calls.push('sendTest')
    },
    setProbePaused: (paused) => {
      calls.push(`pause:${paused}`)
    },
    stop: async () => {},
  }
  return { store, controls, calls }
}

describe('App', () => {
  it('渲染状态头与快捷键', () => {
    const { store, controls } = setup()
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('CodexMonitor')
    expect(frame).toContain('通道 console')
    expect(frame).toContain('[q] 退出')
    unmount()
  })

  it('通知正文去掉 emoji 后显示', () => {
    const { store, controls } = setup()
    store.dispatch({
      type: 'event',
      event: {
        type: 'delivered',
        note: { id: 'n1', ts: 0, severity: 'alert', text: '🚨 [大论文] 任务被中断', source: 'x' },
        result: { ok: true },
      },
      now: 1000,
    })
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[大论文] 任务被中断')
    expect(frame).not.toContain('🚨')
    unmount()
  })

  it('窄终端退化为单列，仍显示全部区块', () => {
    const { store, controls } = setup()
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={60} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('CodexMonitor')
    expect(frame).toContain('额度')
    expect(frame).toContain('投递')
    expect(frame).toContain('最近通知')
    unmount()
  })

  it('通知很多时按终端高度收口，顶部状态不被顶出屏幕', () => {
    const { store, controls } = setup()
    for (let i = 0; i < 10; i++) {
      store.dispatch({
        type: 'event',
        event: {
          type: 'delivered',
          note: { id: `n${i}`, ts: i, severity: 'info', text: `任务${i}\n详情${i}`, source: 'x' },
          result: { ok: true },
        },
        now: 1000 + i,
      })
    }
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={100} rows={16} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('CodexMonitor')
    expect(frame).toContain('额度')
    expect(frame).toContain('任务9 详情9')
    expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(16)
    unmount()
  })

  const quotaWindow = (
    windowMinutes: 300 | 10080,
    usedPercent: number,
    resetsAt: number,
  ) => ({
    windowMinutes,
    usedPercent,
    resetsAt,
    waiting: false,
    notifiedExhausted: false,
    notifiedReset: false,
    notifiedCritical: false,
    lastResetResetsAt: null,
    lastProcessedTs: 0,
    lastUpdatedAt: 0,
  })

  const pushQuota = (store: ReturnType<typeof setup>['store']): void => {
    store.dispatch({
      type: 'event',
      event: {
        type: 'quota',
        snapshot: {
          fiveHour: quotaWindow(300, 84, 2_000),
          sevenDay: quotaWindow(10080, 21, 3_000),
        },
      },
      now: 1000,
    })
  }

  const pushNotes = (store: ReturnType<typeof setup>['store'], count: number): void => {
    for (let i = 0; i < count; i++) {
      store.dispatch({
        type: 'event',
        event: {
          type: 'delivered',
          note: { id: `q${i}`, ts: i, severity: 'info', text: `通知${i}\n详情${i}`, source: 'x' },
          result: { ok: true },
        },
        now: 1000 + i,
      })
    }
  }

  it('60x18 且双额度倒计时：顶部仍可见且不超屏', () => {
    const { store, controls } = setup()
    pushQuota(store)
    pushNotes(store, 3)
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={60} rows={18} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('CodexMonitor')
    expect(frame).toContain('额度')
    expect(frame).toContain('5h')
    expect(frame).toContain('最近通知')
    expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(18)
    unmount()
  })

  it('60x16 极矮终端：进入紧凑模式，额度仍可见', () => {
    const { store, controls } = setup()
    pushQuota(store)
    pushNotes(store, 3)
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={60} rows={16} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('额度')
    expect(frame).toContain('5h')
    expect(frame).toContain('7d')
    expect(frame).not.toContain('投递')
    expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(16)
    unmount()
  })

  it('按 t 触发测试通知', async () => {
    const { store, controls, calls } = setup()
    const { stdin, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} />,
    )
    stdin.write('t')
    await delay(20)
    expect(calls).toContain('sendTest')
    unmount()
  })

  it('按 p 暂停探针并提示', async () => {
    const { store, controls, calls } = setup()
    const { stdin, lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} />,
    )
    stdin.write('p')
    await delay(20)
    expect(calls).toContain('pause:true')
    expect(lastFrame() ?? '').toContain('探针已暂停')
    unmount()
  })
})
