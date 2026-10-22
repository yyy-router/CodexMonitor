import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTailer, listSessionFiles } from '../../src/watcher/tailer.js'
import { parseLine, parseSessionMeta } from '../../src/watcher/parse.js'
import type { SessionFile } from '../../src/watcher/discover.js'

/** 构造 session_meta 首行 */
const meta = (id: string, sessionId: string): string =>
  JSON.stringify({ type: 'session_meta', payload: { id, session_id: sessionId, cwd: '/proj' } })

/** 构造一条 event_msg 行 */
const ev = (ts: string): string =>
  JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1' },
  })

/** 内存文件系统替身：readRange 按字节偏移切片，append 模拟文件增长 */
function fakeFs(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial))
  return {
    readRange: (p: string, start: number): string | null => {
      const full = store.get(p)
      return full == null ? null : full.slice(start)
    },
    append: (p: string, text: string): void => store.set(p, (store.get(p) ?? '') + text),
  }
}

type ReadRange = (path: string, start: number) => string | null

const opts = (listFiles: (dir: string) => SessionFile[], readRange: ReadRange) => ({
  sessionsDir: '/sessions',
  maxTrackedFiles: 20,
  parseLine,
  parseSessionMeta,
  listFiles,
  readRange,
})

describe('createTailer', () => {
  it('addFile 后 tick 只读新增字节（不重放已跟踪前的内容）', async () => {
    const f = fakeFs({ 'a.jsonl': meta('sess-1', 'sess-1') + '\n' })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, f.readRange))
    tailer.addFile('a.jsonl')
    f.append('a.jsonl', ev('2026-10-14T06:17:25.508Z') + '\n')

    const events = await tailer.tick()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'turnStarted', sessionId: 'sess-1', cwd: '/proj' })
  })

  it('同一批新增字节不重复解析（第二次 tick 无新增返回空）', async () => {
    const f = fakeFs({ 'a.jsonl': meta('sess-1', 'sess-1') + '\n' })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, f.readRange))
    tailer.addFile('a.jsonl')
    f.append('a.jsonl', ev('2026-10-14T06:17:25.508Z') + '\n')

    await tailer.tick()
    expect(await tailer.tick()).toEqual([])
  })

  it('addFile 跳过子线程（isRoot false）', async () => {
    const f = fakeFs({
      'child.jsonl': meta('child-1', 'sess-1') + '\n' + ev('2026-10-14T06:17:25.508Z') + '\n',
    })
    const tailer = createTailer(opts(() => [], f.readRange))
    tailer.addFile('child.jsonl')

    expect(await tailer.tick()).toEqual([])
  })

  it('tick 自动发现根会话文件并读取新增事件', async () => {
    const f = fakeFs({
      'root.jsonl': meta('sess-1', 'sess-1') + '\n',
      'child.jsonl': meta('child-1', 'sess-1') + '\n',
    })
    const listFiles = (): SessionFile[] => [
      { path: 'root.jsonl', mtimeMs: 200, size: 0 },
      { path: 'child.jsonl', mtimeMs: 100, size: 0 },
    ]
    const tailer = createTailer(opts(listFiles, f.readRange))
    await tailer.tick() // 首轮发现并跟踪（不重放既有内容）

    f.append('root.jsonl', ev('2026-10-14T06:17:25.508Z') + '\n')
    f.append('child.jsonl', ev('2026-10-14T06:18:00.000Z') + '\n')

    const events = await tailer.tick()
    expect(events).toHaveLength(1) // 子线程被过滤，只剩根会话
    expect(events[0].sessionId).toBe('sess-1')
  })

  it('多文件事件按 ts 升序排序', async () => {
    const f = fakeFs({
      'a.jsonl': meta('sess-a', 'sess-a') + '\n',
      'b.jsonl': meta('sess-b', 'sess-b') + '\n',
    })
    const listFiles = (): SessionFile[] => [
      { path: 'a.jsonl', mtimeMs: 200, size: 0 },
      { path: 'b.jsonl', mtimeMs: 100, size: 0 },
    ]
    const tailer = createTailer(opts(listFiles, f.readRange))
    await tailer.tick()

    // b 的事件 ts 晚于 a，但先追加到 b（模拟并发乱序到达）
    f.append('b.jsonl', ev('2026-10-14T06:20:00.000Z') + '\n')
    f.append('a.jsonl', ev('2026-10-14T06:19:00.000Z') + '\n')

    const events = await tailer.tick()
    expect(events.map((e) => e.sessionId)).toEqual(['sess-a', 'sess-b'])
  })

  it('文件消失（readRange 返回 null）后不再跟踪', async () => {
    let fileContent: string | null = meta('sess-1', 'sess-1') + '\n'
    const readRange = (p: string, start: number) =>
      fileContent == null ? null : fileContent.slice(start)
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, readRange))
    await tailer.tick()

    fileContent += ev('2026-10-14T06:17:25.508Z') + '\n'
    expect(await tailer.tick()).toHaveLength(1)

    fileContent = null // 文件消失（如被压缩为 .jsonl.zst）
    expect(await tailer.tick()).toEqual([])
  })

  it('半行截断：无换行的行暂缓，补全换行后解析', async () => {
    const f = fakeFs({ 'a.jsonl': meta('sess-1', 'sess-1') + '\n' })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, f.readRange))
    await tailer.tick()

    f.append('a.jsonl', ev('2026-10-14T06:17:25.508Z')) // 无尾随换行
    expect(await tailer.tick()).toEqual([])

    f.append('a.jsonl', '\n') // 补全
    const events = await tailer.tick()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('turnStarted')
  })

  it('发现时文件以半行结尾，补全后该事件不丢', async () => {
    const f = fakeFs({
      'a.jsonl': meta('sess-1', 'sess-1') + '\n' + ev('2026-10-14T06:17:25.508Z'),
    })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, f.readRange))
    await tailer.tick() // 发现：baseline 应停在半行之前

    f.append('a.jsonl', '\n') // 补全换行
    const events = await tailer.tick()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('turnStarted')
  })

  it('跟踪集不超过 maxTrackedFiles，出现更新会话时淘汰旧的', async () => {
    const f = fakeFs({
      'a.jsonl': meta('sess-a', 'sess-a') + '\n',
      'b.jsonl': meta('sess-b', 'sess-b') + '\n',
    })
    let current: SessionFile[] = [{ path: 'a.jsonl', mtimeMs: 100, size: 0 }]
    const listFiles = (): SessionFile[] => current
    const tailer = createTailer({ ...opts(listFiles, f.readRange), maxTrackedFiles: 1 })
    await tailer.tick() // 跟踪 a

    current = [{ path: 'b.jsonl', mtimeMs: 200, size: 0 }] // b 成为唯一最新
    await tailer.tick() // 跟踪 b，淘汰 a

    f.append('a.jsonl', ev('2026-10-14T06:18:00.000Z') + '\n')
    f.append('b.jsonl', ev('2026-10-14T06:19:00.000Z') + '\n')

    const events = await tailer.tick()
    expect(events).toHaveLength(1) // 只有 b，a 已被淘汰
    expect(events[0].sessionId).toBe('sess-b')
  })

  it('空闲轮询按字节偏移只读新增，不从 0 重读全文件', async () => {
    const f = fakeFs({ 'a.jsonl': meta('sess-1', 'sess-1') + '\n' })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const starts: number[] = []
    const readRange = (p: string, start: number) => {
      starts.push(start)
      return f.readRange(p, start)
    }
    const tailer = createTailer(opts(listFiles, readRange))
    await tailer.tick() // 跟踪 a（readRange start=0）
    await tailer.tick() // 空闲：应从 consumedBytes(>0) 读，得到 ''

    expect(starts[starts.length - 1]).toBeGreaterThan(0)
  })
})

describe('listSessionFiles', () => {
  it('递归扫描只返回 .jsonl，排除 .jsonl.zst 与子目录聚合', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmonitor-tailer-'))
    try {
      fs.mkdirSync(path.join(dir, 'sub'))
      fs.writeFileSync(path.join(dir, 'a.jsonl'), '')
      fs.writeFileSync(path.join(dir, 'b.jsonl.zst'), '')
      fs.writeFileSync(path.join(dir, 'sub', 'c.jsonl'), '')

      const names = listSessionFiles(dir)
        .map((f) => path.basename(f.path))
        .sort()
      expect(names).toEqual(['a.jsonl', 'c.jsonl'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
