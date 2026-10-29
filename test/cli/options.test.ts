import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { CliError, parseArgs, resolveConfigPath, shouldUseTui } from '../../src/cli/options.js'

describe('parseArgs', () => {
  it('解析全部参数', () => {
    expect(parseArgs(['--config', 'a.json', '--no-tui', '--no-splash', '--setup'])).toEqual({
      configPath: 'a.json',
      noTui: true,
      noSplash: true,
      setup: true,
      help: false,
      version: false,
    })
  })

  it('-h / -v 别名', () => {
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
  })

  it('空参数返回默认值', () => {
    expect(parseArgs([])).toEqual({
      noTui: false,
      noSplash: false,
      setup: false,
      help: false,
      version: false,
    })
  })

  it('--config 缺值抛 CliError（退出码 2）', () => {
    try {
      parseArgs(['--config'])
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(CliError)
      expect((e as CliError).exitCode).toBe(2)
    }
  })

  it('未知参数抛 CliError', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/未知参数/)
  })
})

describe('resolveConfigPath', () => {
  const homeDir = path.join(path.sep, 'home', 'u')
  const cwdDir = path.join(path.sep, 'work')
  const homeCfg = path.join(homeDir, '.codexmonitor', 'config.json')
  const cwdCfg = path.join(cwdDir, 'codexmonitor.config.json')

  const deps = (existing: string[]) => ({
    home: homeDir,
    cwd: cwdDir,
    exists: (p: string) => existing.includes(p),
  })

  it('--config 存在 → 直接使用', () => {
    const explicit = path.join(path.sep, 'x', 'c.json')
    expect(resolveConfigPath(explicit, deps([explicit]))).toEqual({
      path: explicit,
      exists: true,
    })
  })

  it('--config 不存在 → CliError（退出码 1）', () => {
    try {
      resolveConfigPath(path.join(path.sep, 'x', 'nope.json'), deps([]))
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(CliError)
      expect((e as CliError).exitCode).toBe(1)
    }
  })

  it('home 配置优先于 cwd 配置', () => {
    expect(resolveConfigPath(undefined, deps([homeCfg, cwdCfg]))).toEqual({
      path: homeCfg,
      exists: true,
    })
  })

  it('回退到 cwd 配置', () => {
    expect(resolveConfigPath(undefined, deps([cwdCfg]))).toEqual({ path: cwdCfg, exists: true })
  })

  it('都不存在 → 返回 home 路径且 exists=false（供向导创建）', () => {
    expect(resolveConfigPath(undefined, deps([]))).toEqual({ path: homeCfg, exists: false })
  })
})

describe('shouldUseTui', () => {
  it('默认需要 stdout 与 stdin 都是 TTY', () => {
    expect(shouldUseTui({ noTui: false }, { stdout: true, stdin: true })).toBe(true)
    expect(shouldUseTui({ noTui: false }, { stdout: true, stdin: false })).toBe(false)
    expect(shouldUseTui({ noTui: false }, { stdout: false, stdin: true })).toBe(false)
  })

  it('--no-tui 强制关闭', () => {
    expect(shouldUseTui({ noTui: true }, { stdout: true, stdin: true })).toBe(false)
  })
})
