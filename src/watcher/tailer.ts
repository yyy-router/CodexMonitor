/**
 * 增量 tail（IO）。
 *
 * 并发跟踪多个会话文件，每个文件维护独立的字节偏移，只读新增字节；
 * 解析为 CodexEvent，按 ts 升序排序后返回（§4.1）。
 *
 * 通过注入 parseLine / parseSessionMeta 复用 parse.ts，便于单测替身。
 * 文件 IO 通过 listFiles / readRange 注入，默认走真实 fs（字节偏移读取，避免每轮重读全文件）。
 */

import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { selectFiles, type SessionFile } from './discover.js'
import type { CodexEvent, SessionContext } from '../events.js'

export type TailerOptions = {
  /** 会话日志根目录（~/.codex/sessions） */
  sessionsDir: string
  maxTrackedFiles: number
  /** 单行 JSONL → 事件（依赖注入，来自 watcher/parse.ts） */
  parseLine: (line: string, ctx: SessionContext) => CodexEvent[]
  /** 提取会话上下文（session_meta 首行） */
  parseSessionMeta: (line: string) => SessionContext | null
  /** 可注入时钟，便于测试 */
  now?: () => number
  /** 递归扫描会话文件（测试替身；默认 listSessionFiles） */
  listFiles?: (sessionsDir: string) => SessionFile[]
  /** 从字节偏移 start 读到文件尾（utf8）；null 表示文件不存在（测试替身；默认 readRangeSync） */
  readRange?: (path: string, start: number) => string | null
}

export type Tailer = {
  /** 读一轮新增字节 → 解析 → 按 ts 升序返回事件 */
  tick(): Promise<CodexEvent[]>
  /** 手动纳入一个文件跟踪（文件旋转 / 新会话） */
  addFile(path: string): void
}

/**
 * 递归扫描会话目录，只返回活跃的 `*.jsonl` 文件（严格后缀，排除 `.jsonl.zst` 压缩历史）。
 * 目录不存在时返回空数组。
 */
export function listSessionFiles(sessionsDir: string): SessionFile[] {
  const out: SessionFile[] = []
  let entries: string[]
  try {
    entries = readdirSync(sessionsDir, { recursive: true }) as string[]
  } catch {
    return out
  }
  for (const rel of entries) {
    if (!rel.endsWith('.jsonl')) continue // 排除 .jsonl.zst 与无关文件
    const full = path.join(sessionsDir, rel)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size })
  }
  return out
}

/** 从字节偏移 start 读文件尾；start ≥ size 时返回 ''（无新增）；文件不存在返回 null */
function defaultReadRange(p: string, start: number): string | null {
  let fd: number | undefined
  try {
    const size = statSync(p).size
    if (start >= size) return ''
    fd = openSync(p, 'r')
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  } finally {
    if (fd != null) closeSync(fd)
  }
}

/** 跟踪中的文件：ctx 缓存会话上下文；consumedBytes 为已消费字节偏移（落在行边界） */
type Tracked = { ctx: SessionContext; consumedBytes: number }

/** 计算跟踪基线（字节偏移）：落到最后一个完整行边界，保留尾部半行，避免发现时写了一半的事件被丢 */
function baselineBytes(content: string): number {
  if (content.endsWith('\n')) return Buffer.byteLength(content)
  const idx = content.lastIndexOf('\n')
  return idx === -1 ? 0 : Buffer.byteLength(content.slice(0, idx + 1))
}

export function createTailer(opts: TailerOptions): Tailer {
  const listFiles = opts.listFiles ?? listSessionFiles
  const readRange = opts.readRange ?? defaultReadRange
  const files = new Map<string, Tracked>()

  /**
   * 纳入一个文件：读首行 session_meta 提取上下文并缓存，只跟踪根会话。
   * 读取基线设在最后一个完整行边界——只消费跟踪之后新增的字节（tail -f 语义），
   * 若发现时最后一行写到一半，保留该半行等补全；历史回放与重启回溯（EOF-64KB）留到 main()。
   */
  function track(p: string): void {
    const content = readRange(p, 0)
    if (content == null) return
    const ctx = opts.parseSessionMeta(content.split('\n', 1)[0] ?? '')
    if (!ctx || !ctx.isRoot) return
    files.set(p, { ctx, consumedBytes: baselineBytes(content) })
  }

  return {
    addFile(p: string): void {
      track(p)
    },

    async tick(): Promise<CodexEvent[]> {
      // 1. 发现：递归扫描 → 按 mtime 取最新 N 个 → 纳入未跟踪的新文件
      const selected = selectFiles(listFiles(opts.sessionsDir), opts.maxTrackedFiles)
      const selectedPaths = new Set(selected.map((f) => f.path))
      for (const f of selected) {
        if (!files.has(f.path)) track(f.path)
      }
      // 收缩：淘汰已不在最新 N 里的文件，保证 files.size ≤ maxTrackedFiles
      for (const p of [...files.keys()]) {
        if (!selectedPaths.has(p)) files.delete(p)
      }

      // 2. 增量读取：按字节偏移只读新增，按换行切分，半行暂缓
      const events: CodexEvent[] = []
      for (const [p, s] of [...files.entries()]) {
        const newText = readRange(p, s.consumedBytes)
        if (newText == null) {
          files.delete(p) // 文件消失（旋转 / 压缩）
          continue
        }
        if (newText === '') continue

        const endsNl = newText.endsWith('\n')
        const lines = newText.split('\n')
        const complete = lines.slice(0, -1)
        const partial = endsNl ? '' : (lines[lines.length - 1] ?? '')
        s.consumedBytes += Buffer.byteLength(newText) - Buffer.byteLength(partial)

        for (const line of complete) {
          if (line === '') continue
          events.push(...opts.parseLine(line, s.ctx))
        }
      }

      events.sort((a, b) => a.ts - b.ts)
      return events
    },
  }
}
