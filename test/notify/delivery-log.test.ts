import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDeliveryLog, type DeliveryLogEntry } from '../../src/notify/delivery-log.js'

const dirs: string[] = []

const makeTmpDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codexmonitor-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const entry = (over: Partial<DeliveryLogEntry> = {}): DeliveryLogEntry => ({
  ts: 1,
  severity: 'info',
  source: 'turnCompleteAggregated',
  text: '完成',
  ok: true,
  ...over,
})

describe('createDeliveryLog', () => {
  it('追加 JSONL：每次一条，内容可解析', () => {
    const dir = makeTmpDir()
    const log = createDeliveryLog(dir)
    log.record(entry({ ts: 1 }))
    log.record(entry({ ts: 2, severity: 'alert', source: 'turnAborted', text: '中断', ok: false, errcode: -2 }))

    const lines = readFileSync(path.join(dir, 'delivery.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ts: 1, ok: true })
    expect(JSON.parse(lines[1]!)).toMatchObject({ ts: 2, errcode: -2, ok: false })
  })

  it('目录不存在时自动创建（含多级）', () => {
    const dir = path.join(makeTmpDir(), 'a', 'b')
    createDeliveryLog(dir).record(entry())
    expect(existsSync(path.join(dir, 'delivery.jsonl'))).toBe(true)
  })

  it('写盘失败不抛异常（日志不得影响主流程）', () => {
    const base = makeTmpDir()
    const blocker = path.join(base, 'blocked')
    writeFileSync(blocker, 'x')
    const log = createDeliveryLog(path.join(blocker, 'nested'))
    expect(() => log.record(entry())).not.toThrow()
  })
})
