import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { openConfigInEditor, resolveEditor } from '../../src/cli/editor.js'

type ChildBehavior = 'exit' | 'error'

const childThat = (behavior: ChildBehavior, exitCode = 0): EventEmitter => {
  const child = new EventEmitter()
  queueMicrotask(() => {
    if (behavior === 'exit') {
      child.emit('exit', exitCode, null)
      return
    }
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
  })
  return child
}

const spawnStub = (behavior: (command: string) => ChildBehavior) => {
  const calls: Array<{ command: string; args: string[] }> = []
  const spawn = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args })
    return childThat(behavior(command))
  })
  return { spawn, calls }
}

describe('resolveEditor', () => {
  it('EDITOR 优先于 VISUAL', () => {
    expect(resolveEditor({ EDITOR: 'vim', VISUAL: 'nano' })).toEqual({
      command: 'vim',
      args: [],
    })
  })

  it('没有 EDITOR 时使用 VISUAL', () => {
    expect(resolveEditor({ EDITOR: '', VISUAL: 'nano' })).toEqual({
      command: 'nano',
      args: [],
    })
  })

  it('两者都为空时使用 notepad.exe', () => {
    expect(resolveEditor({})).toEqual({ command: 'notepad.exe', args: [] })
  })

  it('解析带引号路径与参数', () => {
    expect(resolveEditor({ EDITOR: '"C:\\Program Files\\Code.exe" --wait -n' })).toEqual({
      command: 'C:\\Program Files\\Code.exe',
      args: ['--wait', '-n'],
    })
  })

  it('解析参数中嵌入的引号片段', () => {
    expect(
      resolveEditor({ EDITOR: 'code --wait --user-data-dir="C:\\Editor Data" --opt=\'a b\'' }),
    ).toEqual({
      command: 'code',
      args: ['--wait', '--user-data-dir=C:\\Editor Data', '--opt=a b'],
    })
  })
})

describe('openConfigInEditor', () => {
  it('启动编辑器并把配置路径作为最后一个参数', async () => {
    const { spawn, calls } = spawnStub(() => 'exit')

    const result = await openConfigInEditor('C:/cfg/config.json', {
      env: { EDITOR: 'vim' },
      spawn: spawn as never,
    })

    expect(calls).toEqual([{ command: 'vim', args: ['C:/cfg/config.json'] }])
    expect(result).toEqual({ ok: true, editor: 'vim', fellBack: false })
  })

  it('首选编辑器启动失败时回退 notepad', async () => {
    const { spawn, calls } = spawnStub((command) => (command === 'code' ? 'error' : 'exit'))

    const result = await openConfigInEditor('cfg.json', {
      env: { EDITOR: 'code --wait' },
      spawn: spawn as never,
    })

    expect(calls).toEqual([
      { command: 'code', args: ['--wait', 'cfg.json'] },
      { command: 'notepad.exe', args: ['cfg.json'] },
    ])
    expect(result).toEqual({ ok: true, editor: 'notepad.exe', fellBack: true })
  })

  it('首选与回退都无法启动时返回错误原因', async () => {
    const { spawn } = spawnStub(() => 'error')

    const result = await openConfigInEditor('cfg.json', {
      env: { EDITOR: 'vim' },
      spawn: spawn as never,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('vim')
  })

  it('编辑器非 0 退出码仍视为完成编辑', async () => {
    const spawn = vi.fn(() => childThat('exit', 1))

    const result = await openConfigInEditor('cfg.json', {
      env: { EDITOR: 'vim' },
      spawn: spawn as never,
    })

    expect(result).toEqual({ ok: true, editor: 'vim', fellBack: false })
  })

  it('未设置环境变量时启动 notepad', async () => {
    const { spawn, calls } = spawnStub(() => 'exit')

    await openConfigInEditor('cfg.json', { env: {}, spawn: spawn as never })

    expect(calls).toEqual([{ command: 'notepad.exe', args: ['cfg.json'] }])
  })
})
