import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { removeFileWithRetry } from '../../scripts/remove-file.mjs'

const failWith = (code: string): (() => never) => () => {
  throw Object.assign(new Error(code), { code })
}

describe('removeFileWithRetry', () => {
  it('文件不存在时静默返回', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cxm-'))
    try {
      expect(() => removeFileWithRetry(path.join(dir, 'missing.exe'))).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('首次删除成功时不重试', () => {
    const remove = vi.fn()
    const sleep = vi.fn()
    removeFileWithRetry('CodexMonitor.exe', { remove, sleep })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('被短暂占用时退避重试到成功', () => {
    const remove = vi
      .fn()
      .mockImplementationOnce(failWith('EPERM'))
      .mockImplementationOnce(failWith('EBUSY'))
      .mockImplementationOnce(() => {})
    const sleep = vi.fn()

    removeFileWithRetry('CodexMonitor.exe', { remove, sleep, retries: 5, delayMs: 25 })

    expect(remove).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(25)
  })

  it('重试耗尽后抛出最后一次错误', () => {
    const remove = vi.fn(failWith('EPERM'))
    const sleep = vi.fn()

    expect(() => removeFileWithRetry('CodexMonitor.exe', { remove, sleep, retries: 2 })).toThrow(
      'EPERM',
    )
    expect(remove).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('不可重试的错误立即抛出', () => {
    const remove = vi.fn(failWith('EIO'))
    const sleep = vi.fn()

    expect(() => removeFileWithRetry('CodexMonitor.exe', { remove, sleep })).toThrow('EIO')
    expect(remove).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
