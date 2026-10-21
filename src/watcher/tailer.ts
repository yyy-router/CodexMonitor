/**
 * 增量 tail（IO）。
 *
 * 并发跟踪多个会话文件，每个文件维护独立 (offset, size)，只读新增字节；
 * 解析为 CodexEvent，按 ts 升序排序后返回（§4.1）。
 *
 * 通过注入 parseLine / parseSessionMeta 复用 parse.ts，便于单测替身。
 * 文件 IO 通过 listFiles / readFile 注入，默认走真实 fs。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
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
  /** 读取文件内容，null 表示不存在（测试替身；默认 readFileSync utf8） */
  readFile?: (path: string) => string | null
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

function defaultReadFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** 跟踪中的文件：ctx 缓存会话上下文；consumed 为已消费字节数（字符串索引，落在行边界） */
type Tracked = { ctx: SessionContext; consumed: number }

export function createTailer(opts: TailerOptions): Tailer {
  const listFiles = opts.listFiles ?? listSessionFiles
  const readFile = opts.readFile ?? defaultReadFile
  const files = new Map<string, Tracked>()

  /**
   * 纳入一个文件：读首行 session_meta 提取上下文并缓存，只跟踪根会话。
   * 读取基线设为当前内容长度——只消费跟踪之后新增的字节（tail -f 语义），
   * 历史回放与重启回溯读取（EOF-64KB）留到 main() 处理。
   */
  function track(p: string): void {
    const content = readFile(p)
    if (content == null) return
    const ctx = opts.parseSessionMeta(content.split('\n', 1)[0] ?? '')
    if (!ctx || !ctx.isRoot) return
    files.set(p, { ctx, consumed: content.length })
  }

  return {
    addFile(p: string): void {
      track(p)
    },

    async tick(): Promise<CodexEvent[]> {
      // 1. 发现：递归扫描 → 按 mtime 取最新 N 个 → 纳入未跟踪的新文件
      for (const f of selectFiles(listFiles(opts.sessionsDir), opts.maxTrackedFiles)) {
        if (!files.has(f.path)) track(f.path)
      }

      // 2. 增量读取：每个文件只读新增字节，按换行切分，半行暂缓
      const events: CodexEvent[] = []
      for (const [p, s] of [...files.entries()]) {
        const content = readFile(p)
        if (content == null) {
          files.delete(p) // 文件消失（旋转 / 压缩）
          continue
        }
        if (content.length < s.consumed) s.consumed = 0 // 截断 / 回退，重新读取

        const newText = content.slice(s.consumed)
        if (newText === '') continue

        const endsNl = newText.endsWith('\n')
        const lines = newText.split('\n')
        const complete = endsNl ? lines.slice(0, -1) : lines.slice(0, -1)
        const partial = endsNl ? '' : (lines[lines.length - 1] ?? '')
        s.consumed += newText.length - partial.length

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
