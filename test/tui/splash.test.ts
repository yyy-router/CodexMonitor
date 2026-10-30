import { describe, it, expect } from 'vitest'
import {
  SPLASH_SECONDS_PER_WORD,
  SPLASH_WORDS,
  showSplash,
} from '../../src/tui/splash.js'

describe('showSplash', () => {
  it('轮换两个词：Codex → Monitor', async () => {
    const calls: Array<{ words: readonly string[]; seconds: number }> = []
    await showSplash({
      play: async (words, seconds) => {
        calls.push({ words, seconds })
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.words).toEqual(['Codex', 'Monitor'])
    expect(calls[0]!.seconds).toBe(SPLASH_SECONDS_PER_WORD)
    expect(SPLASH_SECONDS_PER_WORD).toBe(1.2)
  })

  it('默认播放器可加载；非 TTY 下安全返回且不触发回退', async () => {
    const logs: string[] = []
    await expect(showSplash({ log: (line) => logs.push(line) })).resolves.toBeUndefined()
    // showSplash 吞掉所有异常：只有断言「没有回退日志」才能证明真实播放器加载成功
    expect(logs).toEqual([])
  })

  it('播放失败只记日志，不抛出', async () => {
    const logs: string[] = []
    await expect(
      showSplash({
        play: async () => {
          throw new Error('no alternate screen')
        },
        log: (line) => logs.push(line),
      }),
    ).resolves.toBeUndefined()
    expect(logs[0]).toContain('启动动画跳过')
  })
})
