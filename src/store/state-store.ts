/**
 * 运行时状态持久化（~/.codexmonitor/）。
 *
 * 额度状态必须落盘 —— 进程不可能连续存活 7 天（§4.4）。
 *
 * 每个键一个文件（`<dir>/<key>.json`），写入走 tmp + rename 原子替换，
 * 避免进程中途被杀留下半截 JSON。文件缺失或内容损坏时 load 返回 null，
 * 让调用方按「首次运行」处理而不是崩溃。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type StateStore = {
  load<T>(key: string): T | null
  save<T>(key: string, value: T): void
}

/** 键会直接拼进文件名，只允许安全字符，杜绝路径穿越与 Windows 数据流语法 */
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/

export function createStateStore(dir: string): StateStore {
  const fileFor = (key: string): string => {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`非法状态键：'${key}'（只允许字母、数字、. _ -）`)
    }
    return path.join(dir, `${key}.json`)
  }

  return {
    load<T>(key: string): T | null {
      // 非法键是编程错误，放在 try 外，不能被「读不到就返回 null」吞掉
      const file = fileFor(key)
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T
      } catch {
        // 文件不存在 / 内容损坏都按「无状态」处理
        return null
      }
    },

    save<T>(key: string, value: T): void {
      const file = fileFor(key)
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(value), 'utf8')
      renameSync(tmp, file)
    },
  }
}
