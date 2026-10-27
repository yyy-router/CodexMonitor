import { describe, it, expect } from 'vitest'
import { splitLongMessage } from '../../src/notify/notifier.js'

const stripWhitespace = (s: string): string => s.replace(/\s+/g, '')

/** 是否存在落单的 UTF-16 代理项（emoji 被从中间切断） */
const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

describe('splitLongMessage', () => {
  it('未超长 → 原样返回单元素', () => {
    expect(splitLongMessage('hello 世界', 100)).toEqual(['hello 世界'])
  })

  it('恰好等于上限 → 不切分', () => {
    const text = 'x'.repeat(50)
    expect(splitLongMessage(text, 50)).toEqual([text])
  })

  it('优先按空行（\\n\\n）切分', () => {
    const a = 'a'.repeat(90)
    const b = 'b'.repeat(90)
    expect(splitLongMessage(`${a}\n\n${b}`, 150)).toEqual([a, b])
  })

  it('没有空行时按换行切分', () => {
    const a = 'a'.repeat(90)
    const b = 'b'.repeat(90)
    expect(splitLongMessage(`${a}\n${b}`, 150)).toEqual([a, b])
  })

  it('没有换行时按空格切分', () => {
    const a = 'a'.repeat(90)
    const b = 'b'.repeat(90)
    expect(splitLongMessage(`${a} ${b}`, 150)).toEqual([a, b])
  })

  it('没有任何分隔符 → 硬切，每片不超过上限', () => {
    const chunks = splitLongMessage('x'.repeat(400), 150)
    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => c.length)).toEqual([150, 150, 100])
  })

  it('每片都不超过 maxLen，且内容不丢失', () => {
    const text = ('段落内容'.repeat(20) + '\n\n').repeat(30)
    const chunks = splitLongMessage(text, 100)
    expect(chunks.every((c) => c.length <= 100)).toBe(true)
    expect(stripWhitespace(chunks.join(''))).toBe(stripWhitespace(text))
  })

  it('不产生空片', () => {
    const chunks = splitLongMessage(`\n\n${'x'.repeat(300)}\n\n`, 100)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((c) => c.trim() !== '')).toBe(true)
  })

  it('全空白内容 → 不产出任何分片', () => {
    expect(splitLongMessage('   \n\n   ', 5)).toEqual([])
  })

  it('硬切不切断 emoji 代理对', () => {
    const text = '😀'.repeat(100)
    const chunks = splitLongMessage(text, 9)
    expect(chunks.every((c) => c.length <= 9)).toBe(true)
    expect(chunks.some(hasLoneSurrogate)).toBe(false)
    expect(chunks.join('')).toBe(text)
  })

  it('非法 maxLen 抛 RangeError', () => {
    expect(() => splitLongMessage('x', 0)).toThrow(RangeError)
    expect(() => splitLongMessage('x', -1)).toThrow(RangeError)
    expect(() => splitLongMessage('x', 1.5)).toThrow(RangeError)
  })
})
