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
  /**
   * 从字节偏移 start 读到 end（缺省为文件尾），utf8；null 表示文件不存在。
   * 发现文件时只读首尾窗口，避免把超大文件整体转成字符串。
   */
  readRange?: (path: string, start: number, end?: number) => string | null
  /** 文件字节数；null 表示文件不存在（测试替身；默认 statSync） */
  statSize?: (path: string) => number | null
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

/** 发现文件时只读首尾各 64 KB：首部取 session_meta，尾部定位最后一个完整行 */
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024

function defaultStatSize(p: string): number | null {
  try {
    return statSync(p).size
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** 从字节偏移 start 读到 end（缺省文件尾）；start ≥ size 时返回 ''；文件不存在返回 null */
function defaultReadRange(p: string, start: number, end?: number): string | null {
  let fd: number | undefined
  try {
    const size = statSync(p).size
    if (start >= size) return ''
    const stop = end == null ? size : Math.min(end, size)
    if (stop <= start) return ''
    fd = openSync(p, 'r')
    const buf = Buffer.alloc(stop - start)
    const read = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, read).toString('utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  } finally {
    if (fd != null) closeSync(fd)
  }
}

/** 跟踪中的文件：ctx 缓存会话上下文；consumedBytes 为已消费字节偏移（落在行边界） */
type Tracked = { ctx: SessionContext; consumedBytes: number }

export function createTailer(opts: TailerOptions): Tailer {
  const listFiles = opts.listFiles ?? listSessionFiles
  const readRange = opts.readRange ?? defaultReadRange
  const statSize = opts.statSize ?? defaultStatSize
  const files = new Map<string, Tracked>()

  /**
   * 纳入一个文件：只读首部窗口取 session_meta，只读尾部窗口定位最后一个完整行。
   * 不把整个文件转成字符串：会话日志可能远超 V8 单字符串上限（约 512 MB）。
   * 基线设在最后一个完整行边界——只消费跟踪之后新增的字节（tail -f 语义），
   * 若发现时最后一行写到一半，保留该半行等补全。
   */
  function track(p: string): void {
    const size = statSize(p)
    if (size == null) return

    const head = readRange(p, 0, Math.min(size, HEAD_BYTES))
    if (head == null) return
    const ctx = opts.parseSessionMeta(head.split('\n', 1)[0] ?? '')
    if (!ctx || !ctx.isRoot) return

    const tailStart = Math.max(0, size - TAIL_BYTES)
    const tail = readRange(p, tailStart)
    if (tail == null) return

    let consumedBytes = size
    if (!tail.endsWith('\n')) {
      const idx = tail.lastIndexOf('\n')
      if (idx >= 0) consumedBytes = tailStart + Buffer.byteLength(tail.slice(0, idx + 1))
      else if (tailStart === 0) consumedBytes = 0
      // 尾部窗口内没有换行且不是文件开头：无法定位行边界，直接从 EOF 开始，避免重读超长行
    }
    files.set(p, { ctx, consumedBytes })
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
