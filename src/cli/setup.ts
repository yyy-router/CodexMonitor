/** 首次运行 / --setup 配置向导：交互式收集凭证并原子写入配置文件 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { mergeConfig, type Config } from '../config.js'
import { createPrompter, type Prompter } from './prompter.js'

export type SetupIO = {
  exists(p: string): boolean
  read(p: string): string
  write(p: string, text: string): void
  mkdirp(dir: string): void
  prompter: Prompter
  out(line: string): void
}

const trim = (s: string): string => s.trim()
const orPrev = (value: string, prev: string): string => (value !== '' ? value : prev)

type Previous = {
  channel?: 'feishu' | 'console'
  appId?: string
  appSecret?: string
  email?: string
  mobile?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function readPrevious(io: SetupIO, configPath: string): Previous {
  if (!io.exists(configPath)) return {}
  try {
    const raw = JSON.parse(io.read(configPath)) as Record<string, unknown>
    const notify = raw.notify as Record<string, unknown> | undefined
    const feishu = raw.feishu as Record<string, unknown> | undefined
    const channel = notify?.channel
    return {
      channel: channel === 'feishu' || channel === 'console' ? channel : undefined,
      appId: str(feishu?.appId),
      appSecret: str(feishu?.appSecret),
      email: str(feishu?.email),
      mobile: str(feishu?.mobile),
    }
  } catch {
    return {}
  }
}

function save(io: SetupIO, configPath: string, raw: unknown): void {
  io.mkdirp(path.dirname(configPath))
  io.write(configPath, `${JSON.stringify(raw, null, 2)}\n`)
}

export async function runSetup(configPath: string, io: SetupIO): Promise<Config> {
  const prev = readPrevious(io, configPath)

  io.out('CodexMonitor 配置向导')
  io.out('飞书凭证可在 open.feishu.cn/app 的「凭证与基础信息」获取')

  for (;;) {
    const answer = trim(
      await io.prompter.ask(
        `选择通道（1=飞书，2=控制台）${prev.channel ? ` [当前：${prev.channel}]` : ''}：`,
      ),
    )
    const channel =
      answer === '2'
        ? 'console'
        : answer === '1'
          ? 'feishu'
          : answer === ''
            ? prev.channel === 'console'
              ? 'console'
              : 'feishu'
            : null
    if (channel === null) {
      io.out('请输入 1 或 2')
      continue
    }

    if (channel === 'console') {
      const raw = { notify: { channel: 'console' } }
      save(io, configPath, raw)
      io.out(`已启用控制台通道，配置写入 ${configPath}`)
      return mergeConfig(raw)
    }

    const appId = orPrev(
      trim(await io.prompter.ask(`App ID${prev.appId ? ` [${prev.appId}]` : ''}：`)),
      prev.appId ?? '',
    )
    const appSecret = orPrev(
      trim(await io.prompter.askSecret('App Secret（输入不回显，回车保留原值）：')),
      prev.appSecret ?? '',
    )
    const email = orPrev(
      trim(await io.prompter.ask(`邮箱（可留空${prev.email ? ` [${prev.email}]` : ''}）：`)),
      prev.email ?? '',
    )
    let mobile = ''
    if (email === '') {
      mobile = orPrev(
        trim(await io.prompter.ask(`手机号${prev.mobile ? ` [${prev.mobile}]` : ''}：`)),
        prev.mobile ?? '',
      )
      if (mobile === '') {
        io.out('邮箱与手机号至少填一个')
        continue
      }
    }

    const raw = { notify: { channel: 'feishu' }, feishu: { appId, appSecret, email, mobile } }
    let cfg: Config
    try {
      cfg = mergeConfig(raw)
    } catch (e) {
      io.out(`配置不完整：${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    save(io, configPath, raw)
    io.out(`配置已写入 ${configPath}`)
    io.out('该文件包含密钥，请勿提交到仓库或外传')
    return cfg
  }
}

/** 真实文件系统：临时文件 + rename 原子替换，避免中途失败留下半截配置 */
export function createSetupIO(): SetupIO {
  return {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    write: (p, text) => {
      const tmp = `${p}.tmp`
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, p)
    },
    mkdirp: (dir) => {
      mkdirSync(dir, { recursive: true })
    },
    prompter: createPrompter(),
    out: (line) => console.log(line),
  }
}
