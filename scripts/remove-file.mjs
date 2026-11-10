/**
 * 删除单个文件，遇到 Windows 短暂占用（杀毒扫描、句柄未释放）时按固定间隔重试。
 * fs.rmSync 的 maxRetries 只在 recursive 模式下生效，单文件删除需要显式重试。
 */

import { rmSync } from 'node:fs'

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** 同步等待：构建脚本是顺序执行的，这里不需要异步 */
const defaultSleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const codeOf = (error) =>
  typeof error === 'object' && error !== null ? error.code : undefined

/**
 * @param {string} filePath
 * @param {{ retries?: number, delayMs?: number, remove?: typeof rmSync, sleep?: (ms: number) => void }} [options]
 */
export function removeFileWithRetry(filePath, options = {}) {
  const { retries = 5, delayMs = 200, remove = rmSync, sleep = defaultSleep } = options

  for (let attempt = 0; ; attempt += 1) {
    try {
      remove(filePath, { force: true })
      return
    } catch (error) {
      if (!RETRYABLE.has(codeOf(error)) || attempt >= retries) throw error
      sleep(delayMs)
    }
  }
}
