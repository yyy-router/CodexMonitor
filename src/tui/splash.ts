/** 启动动画：ascii.rest 的 glitch 大字，两个词轮换。必须在 Ink 挂载之前播放（它用备用屏幕） */

/** 轮换显示的两个词（glitch 的画布 64 列，"CodexMonitor" 连写会超宽） */
export const SPLASH_WORDS = ['Codex', 'Monitor'] as const

/** 每个词的时长：glitch 的第一段撕裂爆发在 0.8~1.2s，正好收在这里 */
export const SPLASH_SECONDS_PER_WORD = 1.2

export type SplashDeps = {
  /** 默认懒加载 ascii.rest 逐词播放；测试注入替身 */
  play?: (words: readonly string[], secondsPerWord: number) => Promise<unknown>
  log?: (line: string) => void
}

const defaultPlay = async (words: readonly string[], seconds: number): Promise<void> => {
  const [{ play }, piece] = await Promise.all([
    import('ascii.rest/terminal'),
    import('ascii.rest/pieces/glitch'),
  ])
  // play 的 options 在开播时固定，无法中途换字，所以每个词各播一次
  for (const text of words) {
    await play(piece, { seconds, options: { text } })
  }
}

/** 装饰性：任何失败都吞掉，绝不影响启动 */
export async function showSplash(deps: SplashDeps = {}): Promise<void> {
  const log = deps.log ?? ((): void => {})
  try {
    await (deps.play ?? defaultPlay)(SPLASH_WORDS, SPLASH_SECONDS_PER_WORD)
  } catch (e) {
    log(`启动动画跳过：${e instanceof Error ? e.message : String(e)}`)
  }
}
