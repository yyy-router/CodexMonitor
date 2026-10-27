import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStateStore } from '../../src/store/state-store.js'

const dirs: string[] = []

const makeTmpDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codexmonitor-state-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createStateStore', () => {
  it('save 后 load 取回同一对象', () => {
    const store = createStateStore(makeTmpDir())
    store.save('quota', { fiveHour: { usedPercent: 42 } })
    expect(store.load('quota')).toEqual({ fiveHour: { usedPercent: 42 } })
  })

  it('键不存在 → null', () => {
    expect(createStateStore(makeTmpDir()).load('missing')).toBeNull()
  })

  it('再次 save 覆盖旧值', () => {
    const dir = makeTmpDir()
    const store = createStateStore(dir)
    store.save('quota', { v: 1 })
    store.save('quota', { v: 2 })
    expect(store.load('quota')).toEqual({ v: 2 })
    expect(readFileSync(path.join(dir, 'quota.json'), 'utf8')).toBe('{"v":2}')
  })

  it('文件损坏 → 返回 null 不抛', () => {
    const dir = makeTmpDir()
    writeFileSync(path.join(dir, 'broken.json'), '{ not json')
    expect(createStateStore(dir).load('broken')).toBeNull()
  })

  it('目录不存在时自动创建', () => {
    const dir = path.join(makeTmpDir(), 'nested', 'state')
    createStateStore(dir).save('quota', 1)
    expect(existsSync(path.join(dir, 'quota.json'))).toBe(true)
  })

  it('非法键（路径穿越 / 分隔符 / 空串）抛错', () => {
    const store = createStateStore(makeTmpDir())
    expect(() => store.load('../evil')).toThrow()
    expect(() => store.save('a/b', 1)).toThrow()
    expect(() => store.save('', 1)).toThrow()
  })
})
