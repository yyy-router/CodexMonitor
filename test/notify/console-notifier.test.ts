import { describe, it, expect, vi } from 'vitest'
import { ConsoleNotifier } from '../../src/notify/console-notifier.js'
import type { Notification } from '../../src/events.js'

const note: Notification = {
  id: 'n1',
  ts: 0,
  severity: 'alert',
  text: '任务被中断',
  source: 'turnAborted',
}

describe('ConsoleNotifier', () => {
  it('send 打印级别与正文，返回成功与 messageId', async () => {
    const lines: string[] = []
    const n = new ConsoleNotifier({ log: (line) => lines.push(line) })
    const r = await n.send(note)
    expect(lines).toEqual(['[alert] 任务被中断'])
    expect(r).toEqual({ ok: true, messageId: 'console-n1' })
  })

  it('start / stop 可用（no-op）', async () => {
    const n = new ConsoleNotifier({ log: () => {} })
    await expect(n.start()).resolves.toBeUndefined()
    await expect(n.stop()).resolves.toBeUndefined()
  })

  it('onInbound 不抛（该通道没有入站能力）', () => {
    const n = new ConsoleNotifier({ log: () => {} })
    expect(() => n.onInbound(() => {})).not.toThrow()
  })

  it('默认输出走 console.log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await new ConsoleNotifier().send(note)
      expect(spy).toHaveBeenCalledWith('[alert] 任务被中断')
    } finally {
      spy.mockRestore()
    }
  })
})
