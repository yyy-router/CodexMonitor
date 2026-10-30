/** CLI 参数与配置定位：纯函数，便于单测 */

import path from 'node:path'
import { expandHome } from '../paths.js'

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 2,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

export type CliOptions = {
  configPath?: string
  noTui: boolean
  noSplash: boolean
  setup: boolean
  help: boolean
  version: boolean
}

export const USAGE = `CodexMonitor —— 监控本地 Codex 运行状态

用法：
  CodexMonitor [options]

选项：
  --config <path>   配置文件路径（默认 ~/.codexmonitor/config.json）
  --no-tui          纯日志模式
  --no-splash       跳过启动动画
  --setup           重新运行配置向导
  -h, --help        显示帮助
  -v, --version     显示版本
`

export function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = {
    noTui: false,
    noSplash: false,
    setup: false,
    help: false,
    version: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--config': {
        const value = argv[++i]
        if (!value) throw new CliError('--config 需要一个路径参数')
        out.configPath = value
        break
      }
      case '--no-tui':
        out.noTui = true
        break
      case '--no-splash':
        out.noSplash = true
        break
      case '--setup':
        out.setup = true
        break
      case '-h':
      case '--help':
        out.help = true
        break
      case '-v':
      case '--version':
        out.version = true
        break
      default:
        throw new CliError(`未知参数：${arg}`)
    }
  }
  return out
}

export type ResolveDeps = {
  home: string
  cwd: string
  exists: (p: string) => boolean
}

export type ResolvedConfig = { path: string; exists: boolean }

/** --config > ~/.codexmonitor/config.json > ./codexmonitor.config.json */
export function resolveConfigPath(explicit: string | undefined, deps: ResolveDeps): ResolvedConfig {
  if (explicit) {
    const p = expandHome(explicit)
    if (!deps.exists(p)) throw new CliError(`配置文件不存在：${p}`, 1)
    return { path: p, exists: true }
  }
  const homeCfg = path.join(deps.home, '.codexmonitor', 'config.json')
  if (deps.exists(homeCfg)) return { path: homeCfg, exists: true }
  const cwdCfg = path.join(deps.cwd, 'codexmonitor.config.json')
  if (deps.exists(cwdCfg)) return { path: cwdCfg, exists: true }
  return { path: homeCfg, exists: false }
}

/** TUI 需要 stdout 与 stdin 都是交互终端，且未被 --no-tui 关闭 */
export function shouldUseTui(
  opts: Pick<CliOptions, 'noTui'>,
  tty: { stdout: boolean; stdin: boolean },
): boolean {
  return !opts.noTui && tty.stdout && tty.stdin
}
