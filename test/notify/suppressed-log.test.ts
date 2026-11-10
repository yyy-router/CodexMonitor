import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSuppressedLog, type SuppressedEntry } from '../../src/notify/suppressed-log.js'

const dirs: string[] = []
const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codexmonitor-suppressed-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const entry = (ts: number): SuppressedEntry => ({
  ts,
  severity: 'info',
  source: 'turnCompleteAggregated',
  text: `通知${ts}`,
  reason: 'workHours',
})

describe('createSuppressedLog', () => {
  it('追加写入并按条数读取最近记录', () => {
    const dir = makeDir()
    const log = createSuppressedLog(dir)
    log.record(entry(1))
    log.record(entry(2))
    log.record(entry(3))

    expect(log.read(2).map((e) => e.ts)).toEqual([2, 3])
    expect(log.read(10)).toHaveLength(3)
    expect(readFileSync(path.join(dir, 'suppressed.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('文件不存在时返回空数组', () => {
    const dir = makeDir()
    expect(createSuppressedLog(dir).read(10)).toEqual([])
  })

  it('跳过损坏的行', () => {
    const dir = makeDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'suppressed.jsonl'),
      `${JSON.stringify(entry(1))}\nnot-json\n${JSON.stringify(entry(2))}\n`,
      'utf8',
    )
    expect(createSuppressedLog(dir).read(10).map((e) => e.ts)).toEqual([1, 2])
  })
})
