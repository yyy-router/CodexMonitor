/** 启动动画：ascii.rest 的 big-text 大字。必须在 Ink 挂载之前播放（它用备用屏幕） */

export const SPLASH_SECONDS = 1.5

/**
 * big-text 的画布是 66 列：按 2 倍像素宽计算，"CODEX" 占 51 列放得下，
 * 完整的 "CODEXMONITOR" 会到 121 列被裁掉。
 */
export const SPLASH_TEXT = 'Codex'

export type SplashDeps = {
  /** 默认懒加载 ascii.rest 并播放；测试注入替身 */
  play?: (seconds: number) => Promise<unknown>
  log?: (line: string) => void
}

const defaultPlay = async (seconds: number): Promise<unknown> => {
  const [{ play }, piece] = await Promise.all([
    import('ascii.rest/terminal'),
    import('ascii.rest/pieces/big-text'),
  ])
  return play(piece, { seconds, options: { text: SPLASH_TEXT } })
}

/** 装饰性：任何失败都吞掉，绝不影响启动 */
export async function showSplash(deps: SplashDeps = {}): Promise<void> {
  const log = deps.log ?? ((): void => {})
  try {
    await (deps.play ?? defaultPlay)(SPLASH_SECONDS)
  } catch (e) {
    log(`启动动画跳过：${e instanceof Error ? e.message : String(e)}`)
  }
}
