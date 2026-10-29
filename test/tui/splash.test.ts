import { describe, it, expect } from 'vitest'
import { SPLASH_SECONDS, showSplash } from '../../src/tui/splash.js'

describe('showSplash', () => {
  it('以固定时长调用播放器', async () => {
    let got = 0
    await showSplash({
      play: async (seconds) => {
        got = seconds
      },
    })
    expect(got).toBe(SPLASH_SECONDS)
    expect(SPLASH_SECONDS).toBe(1.5)
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
