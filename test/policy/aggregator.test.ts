import { describe, it, expect } from 'vitest'
import { createAggregator, type AggregatorConfig, type CompletedItem } from '../../src/policy/aggregator.js'

const cfg: AggregatorConfig = { minIntervalMs: 1000, maxItems: 5, maxPerDay: 4 }

const item = (project: string, summary: string, ts: number): CompletedItem => ({
  project,
  summary,
  durationMs: 0,
  ts,
})

describe('createAggregator', () => {
  it('空池不产出', () => {
    const a = createAggregator(cfg)
    expect(a.maybeFlush(0)).toBeNull()
  })

  it('有内容且首次 flush → 产出 info 聚合通知', () => {
    const a = createAggregator(cfg)
    a.add(item('大论文', '改引用', 1), 0)
    const n = a.maybeFlush(0)
    expect(n).not.toBeNull()
    expect(n!.severity).toBe('info')
    expect(n!.source).toBe('turnCompleteAggregated')
    expect(n!.text).toContain('大论文')
  })

  it('距上次发送 < minIntervalMs 不重复发', () => {
    const a = createAggregator(cfg)
    a.add(item('p', 't1', 1), 0)
    expect(a.maybeFlush(0)).not.toBeNull() // 首次发

    a.add(item('p', 't2', 2), 0)
    expect(a.maybeFlush(999)).toBeNull() // 间隔未到
    expect(a.maybeFlush(1000)).not.toBeNull() // 间隔已到
  })

  it('超过 maxItems 时只保留最新 N 条', () => {
    const a = createAggregator(cfg) // maxItems = 5
    for (let i = 0; i < 6; i++) a.add(item('p', `t${i}`, i), 0)
    const n = a.maybeFlush(0)
    expect(n!.text).toContain('5 个任务完成')
    expect(n!.text).toContain('t5') // 最新保留
    expect(n!.text).not.toContain('t0') // 最旧被丢
  })

  it('每日上限 maxPerDay 内不发超量', () => {
    const a = createAggregator({ minIntervalMs: 1000, maxItems: 5, maxPerDay: 2 })
    a.add(item('p', 't1', 1), 0)
    expect(a.maybeFlush(0)).not.toBeNull()
    a.add(item('p', 't2', 2), 0)
    expect(a.maybeFlush(1000)).not.toBeNull()

    a.add(item('p', 't3', 3), 0)
    expect(a.maybeFlush(2000)).toBeNull() // 当日已满
  })

  it('跨 UTC 日重置每日计数', () => {
    const a = createAggregator({ minIntervalMs: 1000, maxItems: 5, maxPerDay: 1 })
    a.add(item('p', 't1', 1), 0)
    expect(a.maybeFlush(0)).not.toBeNull()
    a.add(item('p', 't2', 2), 0)
    expect(a.maybeFlush(1000)).toBeNull() // 同日已满

    a.add(item('p', 't3', 3), 0)
    expect(a.maybeFlush(86400000)).not.toBeNull() // 跨日重置
  })

  it('两个项目的任务合并进一条消息并标注项目名', () => {
    const a = createAggregator(cfg)
    a.add(item('大论文', '改引用', 1), 0)
    a.add(item('Tools', '修脚本', 2), 0)
    const n = a.maybeFlush(0)
    expect(n!.text).toContain('2 个任务完成')
    expect(n!.text).toContain('大论文')
    expect(n!.text).toContain('Tools')
  })

  it('flush 后清空池，不再重复产出', () => {
    const a = createAggregator(cfg)
    a.add(item('p', 't1', 1), 0)
    expect(a.maybeFlush(0)).not.toBeNull()
    expect(a.maybeFlush(1000)).toBeNull() // 池已空
  })

  it('超长 summary 被截断，聚合消息长度受控（≤ 2000 字符）', () => {
    const a = createAggregator(cfg)
    a.add(item('p', 'x'.repeat(3000), 1), 0)
    const n = a.maybeFlush(0)
    expect(n!.text.length).toBeLessThanOrEqual(2000)
    expect(n!.text).toContain('…') // 有截断标记
  })

  it('add 时 trim 到 maxItems，待聚合数不超上限（防内存累积）', () => {
    const a = createAggregator({ minIntervalMs: 1000, maxItems: 3, maxPerDay: 4 })
    for (let i = 0; i < 10; i++) a.add(item('p', `t${i}`, i), 0)
    expect(a.pendingCount()).toBe(3)
  })
})
