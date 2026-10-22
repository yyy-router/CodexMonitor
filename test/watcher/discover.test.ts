import { describe, it, expect } from 'vitest'
import { selectFiles, type SessionFile } from '../../src/watcher/discover.js'

const f = (path: string, mtimeMs: number): SessionFile => ({ path, mtimeMs, size: 0 })

describe('selectFiles', () => {
  it('按 mtimeMs 降序排序', () => {
    const files = [f('a.jsonl', 100), f('b.jsonl', 300), f('c.jsonl', 200)]
    expect(selectFiles(files, 3).map((x) => x.path)).toEqual(['b.jsonl', 'c.jsonl', 'a.jsonl'])
  })

  it('只取前 maxTracked 个（封顶）', () => {
    const files = [f('a.jsonl', 100), f('b.jsonl', 300), f('c.jsonl', 200)]
    expect(selectFiles(files, 2).map((x) => x.path)).toEqual(['b.jsonl', 'c.jsonl'])
  })

  it('maxTracked 大于文件数时返回全部（仍排序）', () => {
    const files = [f('a.jsonl', 100), f('b.jsonl', 300)]
    expect(selectFiles(files, 5).map((x) => x.path)).toEqual(['b.jsonl', 'a.jsonl'])
  })

  it('空列表返回空数组', () => {
    expect(selectFiles([], 5)).toEqual([])
  })

  it('maxTracked 为 0 返回空数组', () => {
    expect(selectFiles([f('a.jsonl', 100)], 0)).toEqual([])
  })

  it('不修改入参数组（纯函数）', () => {
    const files = [f('a.jsonl', 100), f('b.jsonl', 300)]
    const before = files.map((x) => x.path)
    selectFiles(files, 1)
    expect(files.map((x) => x.path)).toEqual(before)
  })
})
