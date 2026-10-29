import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSetupIO, runSetup, type Prompter, type SetupIO } from '../../src/cli/setup.js'

const dirs: string[] = []

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codexmonitor-setup-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const fakePrompter = (ask: string[], secret: string[] = []): Prompter => {
  const asks = [...ask]
  const secrets = [...secret]
  return {
    ask: async () => asks.shift() ?? '',
    askSecret: async () => secrets.shift() ?? '',
    close: () => {},
  }
}

const makeIO = (opts: {
  existing?: string | null
  prompter: Prompter
}): { io: SetupIO; writes: Array<{ path: string; text: string }>; out: string[] } => {
  const writes: Array<{ path: string; text: string }> = []
  const out: string[] = []
  const io: SetupIO = {
    exists: () => opts.existing != null,
    read: () => opts.existing ?? '',
    write: (p, text) => writes.push({ path: p, text }),
    mkdirp: () => {},
    prompter: opts.prompter,
    out: (line) => out.push(line),
  }
  return { io, writes, out }
}

describe('runSetup', () => {
  it('选控制台 → 写最小配置，无需凭证', async () => {
    const { io, writes } = makeIO({ prompter: fakePrompter(['2']) })
    const cfg = await runSetup('/tmp/cfg/config.json', io)

    expect(cfg.notify.channel).toBe('console')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!.text)).toEqual({ notify: { channel: 'console' } })
  })

  it('选飞书 → 收集四项并写入', async () => {
    const { io, writes } = makeIO({
      prompter: fakePrompter(['1', 'cli_x', 'me@x.com'], ['s3cret']),
    })
    const cfg = await runSetup('/tmp/cfg/config.json', io)

    expect(cfg.notify.channel).toBe('feishu')
    expect(cfg.feishu).toEqual({
      appId: 'cli_x',
      appSecret: 's3cret',
      email: 'me@x.com',
      mobile: '',
    })
    expect(writes[0]!.path).toBe('/tmp/cfg/config.json')
    expect(JSON.parse(writes[0]!.text).feishu.appSecret).toBe('s3cret')
  })

  it('邮箱与手机号都空 → 提示后重问', async () => {
    const { io, writes, out } = makeIO({
      prompter: fakePrompter(
        ['1', 'cli_x', '', '', '1', 'cli_x', 'me@x.com'],
        ['s3cret', 's3cret'],
      ),
    })
    const cfg = await runSetup('/tmp/cfg/config.json', io)

    expect(out.some((l) => l.includes('邮箱与手机号至少填一个'))).toBe(true)
    expect(cfg.feishu.email).toBe('me@x.com')
    expect(writes).toHaveLength(1)
  })

  it('校验失败不写盘，重问后成功', async () => {
    const { io, writes, out } = makeIO({
      prompter: fakePrompter(['1', 'cli_x', 'me@x.com', '1', 'cli_x', 'me@x.com'], ['', 's3cret']),
    })
    const cfg = await runSetup('/tmp/cfg/config.json', io)

    expect(out.some((l) => l.includes('配置不完整'))).toBe(true)
    expect(cfg.feishu.appSecret).toBe('s3cret')
    expect(writes).toHaveLength(1)
  })

  it('--setup 重配：回车保留旧值（密钥不回显旧值）', async () => {
    const existing = JSON.stringify({
      notify: { channel: 'feishu' },
      feishu: { appId: 'old_id', appSecret: 'old_secret', email: 'old@x.com', mobile: '' },
    })
    const { io, writes } = makeIO({
      existing,
      prompter: fakePrompter(['', '', 'new@x.com'], ['']),
    })
    const cfg = await runSetup('/tmp/cfg/config.json', io)

    expect(cfg.feishu).toEqual({
      appId: 'old_id',
      appSecret: 'old_secret',
      email: 'new@x.com',
      mobile: '',
    })
    expect(writes).toHaveLength(1)
  })
})

describe('createSetupIO', () => {
  it('原子写入：内容落盘且不残留 .tmp', () => {
    const dir = makeDir()
    const file = path.join(dir, 'nested', 'config.json')
    const io = createSetupIO()

    io.mkdirp(path.dirname(file))
    io.write(file, '{"a":1}\n')

    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })
})
