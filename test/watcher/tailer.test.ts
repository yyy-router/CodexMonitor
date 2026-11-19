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

/** 内存文件系统替身：readRange 按 UTF-8 字节偏移切片，append 模拟文件增长 */
function fakeFs(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial))
  return {
    readRange: (p: string, start: number, end?: number): Buffer | null => {
      const full = store.get(p)
      return full == null ? null : Buffer.from(full, 'utf8').subarray(start, end)
    },
    sizeOf: (p: string): number | null => {
      const full = store.get(p)
      return full == null ? null : Buffer.byteLength(full)
    },
    append: (p: string, text: string): void => store.set(p, (store.get(p) ?? '') + text),
  }
}

type ReadRange = (path: string, start: number, end?: number) => Buffer | null

const opts = (
  listFiles: (dir: string) => SessionFile[],
  readRange: ReadRange,
  statSize: (path: string) => number | null,
) => ({
  sessionsDir: '/sessions',
  maxTrackedFiles: 20,
  parseLine,
  parseSessionMeta,
  listFiles,
  readRange,
  statSize,
})

describe('createTailer', () => {
  it('addFile 后 tick 只读新增字节（不重放已跟踪前的内容）', async () => {
    const f = fakeFs({ 'a.jsonl': meta('sess-1', 'sess-1') + '\n' })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, f.readRange, f.sizeOf))
    tailer.addFile('a.jsonl')
    f.append('a.jsonl', ev('2026-10-14T06:17:25.508Z') + '\n')

    const events = await tailer.tick()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'turnStarted', sessionId: 'sess-1', cwd: '/proj' })
  })

  it('同一批新增字节不重复解析（第二次 tick 无新增返回空）', async () => {
    const f = fakeFs({ 'a.jsonl': meta('sess-1', 'sess-1') + '\n' })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, f.readRange, f.sizeOf))
    tailer.addFile('a.jsonl')
    f.append('a.jsonl', ev('2026-10-14T06:17:25.508Z') + '\n')

    await tailer.tick()
    expect(await tailer.tick()).toEqual([])
  })

  it('addFile 跳过子线程（isRoot false）', async () => {
    const f = fakeFs({
      'child.jsonl': meta('child-1', 'sess-1') + '\n' + ev('2026-10-14T06:17:25.508Z') + '\n',
    })
    const tailer = createTailer(opts(() => [], f.readRange, f.sizeOf))
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
    const tailer = createTailer(opts(listFiles, f.readRange, f.sizeOf))
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
    const tailer = createTailer(opts(listFiles, f.readRange, f.sizeOf))
    await tailer.tick()

    // b 的事件 ts 晚于 a，但先追加到 b（模拟并发乱序到达）
    f.append('b.jsonl', ev('2026-10-14T06:20:00.000Z') + '\n')
    f.append('a.jsonl', ev('2026-10-14T06:19:00.000Z') + '\n')

    const events = await tailer.tick()
    expect(events.map((e) => e.sessionId)).toEqual(['sess-a', 'sess-b'])
  })

  it('文件消失（readRange 返回 null）后不再跟踪', async () => {
    let fileContent: string | null = meta('sess-1', 'sess-1') + '\n'
    const readRange = (p: string, start: number, end?: number) =>
      fileContent == null ? null : Buffer.from(fileContent, 'utf8').subarray(start, end)
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const readSize = (): number | null =>
      fileContent == null ? null : Buffer.byteLength(fileContent)
    const tailer = createTailer(opts(listFiles, readRange, readSize))
    await tailer.tick()

    fileContent += ev('2026-10-14T06:17:25.508Z') + '\n'
    expect(await tailer.tick()).toHaveLength(1)

    fileContent = null // 文件消失（如被压缩为 .jsonl.zst）
    expect(await tailer.tick()).toEqual([])
  })

  it('半行截断：无换行的行暂缓，补全换行后解析', async () => {
    const f = fakeFs({ 'a.jsonl': meta('sess-1', 'sess-1') + '\n' })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, f.readRange, f.sizeOf))
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
    const tailer = createTailer(opts(listFiles, f.readRange, f.sizeOf))
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
    const tailer = createTailer({ ...opts(listFiles, f.readRange, f.sizeOf), maxTrackedFiles: 1 })
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
    const readRange = (p: string, start: number, end?: number) => {
      starts.push(start)
      return f.readRange(p, start, end)
    }
    const tailer = createTailer(opts(listFiles, readRange, f.sizeOf))
    await tailer.tick() // 跟踪 a（readRange start=0）
    await tailer.tick() // 空闲：应从 consumedBytes(>0) 读，得到 ''

    expect(starts[starts.length - 1]).toBeGreaterThan(0)
  })

  it('发现超大文件时只读首尾窗口，不把整文件转成字符串', async () => {
    const BIG = 600 * 1024 * 1024
    const head = Buffer.from(meta('sess-big', 'sess-big') + '\n')
    const tail = Buffer.from(ev('2026-10-14T06:17:25.508Z') + '\n')
    const calls: Array<{ start: number; end?: number }> = []
    const readRange = (p: string, start: number, end?: number): Buffer | null => {
      calls.push({ start, end })
      const stop = end ?? BIG
      if (stop - start > 1024 * 1024) {
        throw new Error('Cannot create a string longer than 0x1fffffe8 characters')
      }
      if (start === 0) return head.subarray(0, stop)
      // 模拟窗口：尾部内容贴在窗口末端，前面用 0 填充，避免把换行挪到窗口开头
      const len = Math.max(0, stop - start)
      const window = Buffer.alloc(len)
      tail.copy(window, Math.max(0, len - tail.length))
      return window
    }
    const listFiles = (): SessionFile[] => [{ path: 'big.jsonl', mtimeMs: 1, size: BIG }]
    const tailer = createTailer(opts(listFiles, readRange, () => BIG))

    await expect(tailer.tick()).resolves.toEqual([])
    expect(calls.some((c) => c.start === 0 && c.end != null)).toBe(true)
    expect(calls.every((c) => c.end != null || c.start > 0)).toBe(true)
  })

  it('首行超过 64 KB 时仍能完整解析 session_meta', async () => {
    const bigMeta = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'sess-big-meta',
        session_id: 'sess-big-meta',
        cwd: '/proj',
        blob: 'x'.repeat(100 * 1024),
      },
    })
    const f = fakeFs({ 'a.jsonl': bigMeta + '\n' })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, f.readRange, f.sizeOf))

    await tailer.tick()
    f.append('a.jsonl', ev('2026-10-14T06:17:25.508Z') + '\n')

    const events = await tailer.tick()
    expect(events).toHaveLength(1)
    expect(events[0]!.sessionId).toBe('sess-big-meta')
  })

  it('stat 之后写入方补全半行：事件不丢失', async () => {
    const metaLine = meta('sess-race', 'sess-race') + '\n'
    const eventLine = ev('2026-10-14T06:17:25.508Z')
    const cutoff = Buffer.byteLength(metaLine + eventLine)
    const f = fakeFs({ 'a.jsonl': metaLine + eventLine + '\n' })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: cutoff }]
    const tailer = createTailer(opts(listFiles, f.readRange, () => cutoff))

    const events = await tailer.tick()
    expect(events).toHaveLength(1)
    expect(events[0]!.sessionId).toBe('sess-race')
  })

  it('未完成行超过尾部窗口：补全后事件不丢失', async () => {
    const bigEvent = JSON.stringify({
      timestamp: '2026-10-14T06:17:25.508Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1', blob: 'x'.repeat(100 * 1024) },
    })
    const f = fakeFs({ 'a.jsonl': meta('sess-long', 'sess-long') + '\n' + bigEvent })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size: 0 }]
    const tailer = createTailer(opts(listFiles, f.readRange, f.sizeOf))

    await tailer.tick()
    f.append('a.jsonl', '\n')

    const events = await tailer.tick()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'turnStarted', sessionId: 'sess-long' })
  })

  it('尾部窗口切在多字节字符中间时基线仍正确', async () => {
    const metaLine = meta('sess-utf8', 'sess-utf8') + '\n'
    const filler = 'é'.repeat(40_000) + '\n'
    const event = ev('2026-10-14T06:17:25.508Z')
    const prefixBytes = Buffer.byteLength(metaLine)
    const fillerBytes = Buffer.byteLength(filler)

    let pad = 0
    while ((prefixBytes + fillerBytes + Buffer.byteLength(event) + pad - 65536) % 2 !== 1) {
      pad += 1
    }
    const content = metaLine + filler + event + ' '.repeat(pad)
    const size = Buffer.byteLength(content)
    const tailStart = size - 65536
    expect(tailStart).toBeGreaterThan(prefixBytes)
    expect(tailStart).toBeLessThan(prefixBytes + fillerBytes)
    expect((tailStart - prefixBytes) % 2).toBe(1)

    const f = fakeFs({ 'a.jsonl': content })
    const listFiles = (): SessionFile[] => [{ path: 'a.jsonl', mtimeMs: 1, size }]
    const tailer = createTailer(opts(listFiles, f.readRange, f.sizeOf))

    await tailer.tick()
    f.append('a.jsonl', '\n')

    const events = await tailer.tick()
    expect(events).toHaveLength(1)
    expect(events[0]!.sessionId).toBe('sess-utf8')
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
