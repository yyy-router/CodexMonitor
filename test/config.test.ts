import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, mergeConfig, DEFAULT_CONFIG } from '../src/config.js'

describe('mergeConfig', () => {
  it('空对象返回完整默认配置', () => {
    expect(mergeConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('部分覆盖：只给 feishu 段，其余保持默认', () => {
    const r = mergeConfig({
      notify: { channel: 'feishu' },
      feishu: { appId: 'a', appSecret: 's', email: 'e@x.com' },
    })
    expect(r.notify.channel).toBe('feishu')
    expect(r.codex).toEqual(DEFAULT_CONFIG.codex)
    expect(r.probe).toEqual(DEFAULT_CONFIG.probe)
    expect(r.ilink).toEqual(DEFAULT_CONFIG.ilink)
    expect(r.feishu).toEqual({ appId: 'a', appSecret: 's', email: 'e@x.com', mobile: '' })
  })

  it('嵌套深合并：只改 aggregate.maxItems，其余字段保留默认', () => {
    const r = mergeConfig({ notify: { aggregate: { maxItems: 99 } } })
    expect(r.notify.aggregate).toEqual({
      minIntervalMs: DEFAULT_CONFIG.notify.aggregate.minIntervalMs,
      maxItems: 99,
      maxPerDay: DEFAULT_CONFIG.notify.aggregate.maxPerDay,
    })
  })

  it('数组整体替换而非合并', () => {
    const r = mergeConfig({ probe: { proxy: { ports: [1, 2] } } })
    expect(r.probe.proxy.ports).toEqual([1, 2])
  })

  it('mergeConfig 不污染 DEFAULT_CONFIG', () => {
    const r = mergeConfig({ notify: { aggregate: { maxItems: 99 } } })
    expect(DEFAULT_CONFIG.notify.aggregate.maxItems).toBe(5)
    expect(r.notify.aggregate).not.toBe(DEFAULT_CONFIG.notify.aggregate)
  })

  it('channel 非法值抛错', () => {
    expect(() => mergeConfig({ notify: { channel: 'wechat' } })).toThrow(/channel/)
  })

  it("channel='feishu' 缺 appSecret 抛错", () => {
    expect(() =>
      mergeConfig({ notify: { channel: 'feishu' }, feishu: { appId: 'a' } }),
    ).toThrow(/appSecret/)
  })

  it("channel='feishu' 缺 email 且缺 mobile 抛错", () => {
    expect(() =>
      mergeConfig({ notify: { channel: 'feishu' }, feishu: { appId: 'a', appSecret: 's' } }),
    ).toThrow(/email/)
  })

  it("channel='feishu' 用 mobile（无 email）通过", () => {
    const r = mergeConfig({
      notify: { channel: 'feishu' },
      feishu: { appId: 'a', appSecret: 's', mobile: '+8613800138000' },
    })
    expect(r.notify.channel).toBe('feishu')
    expect(r.feishu.mobile).toBe('+8613800138000')
  })

  it("channel='ilink'（默认）无需凭证即通过", () => {
    const r = mergeConfig({ ilink: { userId: 'u1' } })
    expect(r.ilink.userId).toBe('u1')
    expect(r.notify.channel).toBe('ilink')
  })

  it('顶层非对象（null / 数组 / 标量）抛错', () => {
    expect(() => mergeConfig(null)).toThrow()
    expect(() => mergeConfig([])).toThrow()
    expect(() => mergeConfig('x')).toThrow()
  })

  it('配置段给标量（对象位置）抛错', () => {
    expect(() => mergeConfig({ notify: 'feishu' })).toThrow(/对象/)
  })
})

describe('loadConfig', () => {
  it('文件不存在返回默认配置（深拷贝，非同一引用）', () => {
    const r = loadConfig('nope.json', () => null)
    expect(r).toEqual(DEFAULT_CONFIG)
    expect(r).not.toBe(DEFAULT_CONFIG)
  })

  it('缺省 path 用 codexmonitor.config.json', () => {
    let got = ''
    loadConfig(undefined, (p) => {
      got = p
      return null
    })
    expect(got).toBe('codexmonitor.config.json')
  })

  it('非法 JSON 抛错且信息含路径', () => {
    expect(() => loadConfig('bad.json', () => '{ not json')).toThrow(/bad\.json/)
  })

  it('合法 JSON 深合并进默认配置', () => {
    const reader = () =>
      JSON.stringify({
        notify: { channel: 'feishu' },
        feishu: { appId: 'a', appSecret: 's', email: 'e@x.com' },
      })
    const r = loadConfig('ok.json', reader)
    expect(r.notify.channel).toBe('feishu')
    expect(r.feishu.email).toBe('e@x.com')
    expect(r.codex).toEqual(DEFAULT_CONFIG.codex)
  })

  it('无注入 reader 时，真实文件不存在返回默认（ENOENT 兜底）', () => {
    const r = loadConfig(path.join(os.tmpdir(), `codexmonitor-nonexistent-${process.pid}.json`))
    expect(r).toEqual(DEFAULT_CONFIG)
  })
})
