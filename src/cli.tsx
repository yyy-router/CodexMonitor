/**
 * 唯一可执行入口：参数 → 配置 → 模式（TUI / 日志）。
 * SEA 里没有 require.main，因此这里**无条件执行**；本文件不被测试导入。
 */

import React from 'react'
import { render } from 'ink'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createMonitor, main, type Controls, type Monitor } from './index.js'
import { loadConfig, type Config } from './config.js'
import {
  CliError,
  parseArgs,
  resolveConfigPath,
  shouldUseTui,
  USAGE,
  type CliOptions,
  type ResolvedConfig,
} from './cli/options.js'
import { createSetupIO, runSetup } from './cli/setup.js'
import { restartMonitor } from './cli/reload.js'
import { App } from './tui/app.js'
import { createInitialState, createTuiStore } from './tui/store.js'
import { showSplash } from './tui/splash.js'
import { ConsoleNotifier } from './notify/console-notifier.js'

declare const __APP_VERSION__: string

/** esbuild 打包时注入；tsc 产物里没有该常量，用 typeof 兜底 */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

const TEMPLATE = `请创建 ~/.codexmonitor/config.json，例如：
{
  "notify": { "channel": "feishu" },
  "feishu": {
    "appId": "cli_xxxxxxxx",
    "appSecret": "xxxxxxxx",
    "email": "you@corp.com",
    "mobile": ""
  }
}`

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** TUI 模式：装配 store / monitor / 重载，退出时优雅停止 */
async function runTui(cfg: Config, configPath: string): Promise<number> {
  const store = createTuiStore(
    createInitialState({
      channel: cfg.notify.channel,
      probeEnabled: cfg.probe.enabled,
      now: Date.now(),
      thresholds: {
        warn: cfg.notify.thresholds.quotaWarn,
        critical: cfg.notify.thresholds.quotaCritical,
      },
    }),
  )

  let currentCfg = cfg
  let monitor: Monitor | undefined

  const build = (next: Config): Monitor =>
    createMonitor(next, {
      // 控制台通道在 TUI 下不能写 stdout，通知本身已通过 delivered 事件进入面板
      notifier:
        next.notify.channel === 'console' ? new ConsoleNotifier({ log: () => {} }) : undefined,
      log: (line) => store.dispatch({ type: 'toast', text: line, now: Date.now() }),
      onEvent: (event) => store.dispatch({ type: 'event', event, now: Date.now() }),
    })

  const controls: Controls = {
    sendTest: async () => {
      if (monitor) await monitor.sendTest()
    },
    setProbePaused: (paused) => {
      monitor?.setProbePaused(paused)
    },
    stop: async () => {
      if (monitor) await monitor.stop()
    },
  }

  const onReload = async (): Promise<string> => {
    const current = monitor
    if (!current) return '监控未启动'

    let nextCfg: Config
    try {
      // 先校验新配置：失败时旧核心仍在运行，无需回滚
      nextCfg = loadConfig(configPath)
    } catch (e) {
      return `重载失败：${msgOf(e)}`
    }

    try {
      monitor = await restartMonitor(current, nextCfg, { create: build })
      currentCfg = nextCfg
      return '配置已重载'
    } catch (e) {
      const msg = msgOf(e)
      try {
        // 用旧配置重建核心（不回读坏文件）
        monitor = build(currentCfg)
        await monitor.start()
        return `重载失败：${msg}（已按上一次配置继续运行）`
      } catch {
        monitor = undefined
        return `重载失败：${msg}（监控已停止，请检查配置后重启）`
      }
    }
  }

  monitor = build(cfg)
  try {
    await monitor.start()
  } catch (e) {
    console.error(`[codexmonitor] 启动失败：${msgOf(e)}`)
    return 1
  }

  try {
    const app = render(<App store={store} controls={controls} onReload={onReload} />)
    await app.waitUntilExit()
  } finally {
    await controls.stop()
  }
  return 0
}

async function run(): Promise<number> {
  let opts: CliOptions
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(msgOf(e))
    console.error(`[codexmonitor] ${err.message}`)
    console.error(USAGE)
    return err.exitCode
  }

  if (opts.help) {
    console.log(USAGE)
    return 0
  }
  if (opts.version) {
    console.log(VERSION)
    return 0
  }

  let resolved: ResolvedConfig
  try {
    resolved = resolveConfigPath(opts.configPath, {
      home: homedir(),
      cwd: process.cwd(),
      exists: existsSync,
    })
  } catch (e) {
    console.error(`[codexmonitor] ${msgOf(e)}`)
    return 1
  }

  const tui = shouldUseTui(opts, {
    stdout: process.stdout.isTTY === true,
    stdin: process.stdin.isTTY === true,
  })

  let cfg: Config
  if (!resolved.exists || opts.setup) {
    if (process.stdin.isTTY !== true) {
      if (resolved.exists) {
        console.error('[codexmonitor] --setup 需要交互式终端')
      } else {
        console.error(`[codexmonitor] 未找到配置文件：${resolved.path}`)
        console.error(TEMPLATE)
      }
      return 1
    }
    try {
      cfg = await runSetup(resolved.path, createSetupIO())
    } catch (e) {
      console.error(`[codexmonitor] 配置向导中止：${msgOf(e)}`)
      return 1
    }
  } else {
    try {
      cfg = loadConfig(resolved.path)
    } catch (e) {
      console.error(`[codexmonitor] ${msgOf(e)}`)
      return 1
    }
  }

  if (!tui) {
    if (!opts.noTui) console.log('[codexmonitor] 非交互终端，已切换为日志模式')
    await main(cfg)
    return 0
  }

  if (!opts.noSplash) {
    await showSplash({ log: (line) => console.log(`[codexmonitor] ${line}`) })
  }
  return runTui(cfg, resolved.path)
}

void run()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    console.error(`[codexmonitor] 启动失败：${msgOf(e)}`)
    process.exitCode = 1
  })
