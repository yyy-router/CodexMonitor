/** 重载配置 = 重建监控核心（TUI 不退出）。新配置由调用方先加载并校验 */

import type { Monitor } from '../index.js'
import type { Config } from '../config.js'

export type RestartDeps = {
  create: (cfg: Config) => Monitor
}

/** 停旧核心 → 建新核心并启动；失败时抛错，旧核心已停止，由调用方回滚 */
export async function restartMonitor(
  old: Monitor,
  nextCfg: Config,
  deps: RestartDeps,
): Promise<Monitor> {
  await old.stop()
  const monitor = deps.create(nextCfg)
  try {
    await monitor.start()
  } catch (e) {
    // 启动到一半失败：清理掉半启动的核心，避免残留定时器 / 连接
    await monitor.stop().catch(() => {})
    throw e
  }
  return monitor
}
