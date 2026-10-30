/** TUI 的监控会话：串行化重载、退出时收敛所有核心，避免并发重载泄漏 */

import type { Monitor } from '../index.js'
import type { Config } from '../config.js'
import { restartMonitor } from './reload.js'

export type SessionDeps = {
  loadConfig: () => Config
  create: (cfg: Config) => Monitor
}

export type Session = {
  /** 当前核心；重载窗口内可能是即将被替换的旧核心 */
  current(): Monitor | undefined
  /** 当前生效的配置；重载成功后更新 */
  currentConfig(): Config | undefined
  /** 串行化：并发调用复用同一个任务；返回给用户看的提示文案 */
  reload(): Promise<string>
  /** 等待在途重载、停止当前核心；幂等 */
  stop(): Promise<void>
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createSession(initialCfg: Config, initial: Monitor, deps: SessionDeps): Session {
  let cfg: Config | undefined = initialCfg
  let monitor: Monitor | undefined = initial
  let reloadTask: Promise<string> | null = null
  let closing = false

  const reload = (): Promise<string> => {
    if (reloadTask) return reloadTask
    if (closing) return Promise.resolve('已停止')

    const task = (async (): Promise<string> => {
      const current = monitor
      const previousCfg = cfg
      if (!current || !previousCfg) return '监控未启动'

      let nextCfg: Config
      try {
        nextCfg = deps.loadConfig()
      } catch (e) {
        return `重载失败：${msgOf(e)}`
      }

      try {
        const next = await restartMonitor(current, nextCfg, { create: deps.create })
        if (closing) {
          // 重载期间用户已退出：新核心不能留在后台；旧核心已被 restartMonitor 停掉
          await next.stop()
          monitor = undefined
          return '已停止'
        }
        monitor = next
        cfg = nextCfg
        return '配置已重载'
      } catch (e) {
        const msg = msgOf(e)
        if (closing) {
          monitor = undefined
          return `重载失败：${msg}`
        }
        try {
          const revived = deps.create(previousCfg)
          await revived.start()
          if (closing) {
            await revived.stop()
            monitor = undefined
            return '已停止'
          }
          monitor = revived
          return `重载失败：${msg}（已按上一次配置继续运行）`
        } catch {
          monitor = undefined
          return `重载失败：${msg}（监控已停止，请检查配置后重启）`
        }
      }
    })()

    reloadTask = task
    void task.finally(() => {
      if (reloadTask === task) reloadTask = null
    })
    return task
  }

  const stop = async (): Promise<void> => {
    closing = true
    if (reloadTask) {
      try {
        await reloadTask
      } catch {
        // reload 内部已收敛错误，这里只等它结束
      }
    }
    const current = monitor
    monitor = undefined
    if (current) await current.stop()
  }

  return {
    current: () => monitor,
    currentConfig: () => cfg,
    reload,
    stop,
  }
}
