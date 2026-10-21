/**
 * 配置加载与默认值。
 *
 * 配置文件为 JSON（codexmonitor.config.json），零解析依赖。
 * 完整字段说明见设计文档 §6。
 */

import { readFileSync } from 'node:fs'

/** 推送通道判别：ilink（微信 iLink）或 feishu */
export type Channel = 'ilink' | 'feishu'

export type Config = {
  codex: {
    /** Codex 会话日志根目录 */
    sessionsDir: string
    /** 并发跟踪的最大会话文件数（§4.1） */
    maxTrackedFiles: number
    /** 长思考只记日志、不推送 */
    stallLogOnly: boolean
  }
  notify: {
    /** 推送通道：默认 ilink；接入飞书时切 feishu */
    channel: Channel
    aggregate: {
      minIntervalMs: number
      maxItems: number
      maxPerDay: number
    }
    thresholds: {
      quotaWarn: number
      quotaCritical: number
      quotaExhausted: number
      quotaWarnCooldownMs: number
      warnEnabled: boolean
    }
  }
  probe: {
    enabled: boolean
    intervalMs: number
    timeoutMs: number
    slowThresholdMs: number
    retryDelayMs: number
    confirmAttempts: number
    recoverAttempts: number
    userAgent: string
    targets: { l2: string; l3: string }
    proxy: { mode: 'auto' | 'manual'; ports: number[] }
  }
  /** iLink 通道专属配置（仅 channel === 'ilink' 时生效） */
  ilink: {
    /** 首次运行由扫码 / 入站消息确定 */
    userId: string
    storageDir: string
    /** 会话额度模型：每次用户激活得 perActivation 条（§2.6），不是 24h 窗口 */
    quota: {
      perActivation: number
      reserveForAlerts: number
      autoReply: boolean
    }
  }
  /** 飞书通道专属配置（仅 channel === 'feishu' 时生效） */
  feishu: {
    appId: string
    appSecret: string
    /** 解析 open_id 用；email 与 mobile 至少填一个 */
    email: string
    mobile: string
  }
  state: {
    dir: string
  }
}

/** 默认配置，逐项对应设计文档 §6 的 codexmonitor.config.json */
export const DEFAULT_CONFIG: Config = {
  codex: {
    sessionsDir: '~/.codex/sessions',
    maxTrackedFiles: 20,
    stallLogOnly: true,
  },
  notify: {
    channel: 'ilink',
    aggregate: { minIntervalMs: 7200000, maxItems: 5, maxPerDay: 4 },
    thresholds: {
      quotaWarn: 80,
      quotaCritical: 95,
      quotaExhausted: 100,
      quotaWarnCooldownMs: 1800000,
      warnEnabled: false,
    },
  },
  probe: {
    enabled: true,
    intervalMs: 15000,
    timeoutMs: 3000,
    slowThresholdMs: 3000,
    retryDelayMs: 3000,
    confirmAttempts: 2,
    recoverAttempts: 2,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    targets: {
      l2: 'https://chatgpt.com/',
      l3: 'https://registry.npmmirror.com/',
    },
    proxy: { mode: 'auto', ports: [7890, 7891, 7892, 7897, 10808, 1080] },
  },
  ilink: {
    userId: '',
    storageDir: '~/.wechatbot',
    quota: { perActivation: 10, reserveForAlerts: 6, autoReply: false },
  },
  feishu: {
    appId: '',
    appSecret: '',
    email: '',
    mobile: '',
  },
  state: { dir: '~/.codexmonitor' },
}

/** 缺省配置文件名（相对 cwd） */
const DEFAULT_PATH = 'codexmonitor.config.json'

/** 读取配置文件的替身：返回 null 表示文件不存在（供测试注入） */
export type ReadFile = (path: string) => string | null

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 深合并：base 为对象时按 key 递归（override 同为对象才递归，否则整体覆盖），
 * 数组与标量整体替换。base 非对象时直接返回 override。
 * base 是对象而 override 是非对象标量时抛类型错误，防止整段被悄悄覆盖。
 */
function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base)) return override
  if (override === undefined) return base
  if (!isPlainObject(override)) {
    throw new Error(
      `配置段类型错误：期望对象，实际 ${Array.isArray(override) ? '数组' : typeof override}`,
    )
  }
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base[key], override[key])
  }
  return out
}

/** 校验必填项：channel 枚举 + feishu 凭证完备性。其余字段超出范围，不逐项校验。 */
function validate(cfg: Config): void {
  const ch = cfg.notify.channel
  if (ch !== 'ilink' && ch !== 'feishu') {
    throw new Error(`notify.channel 必须是 'ilink' 或 'feishu'，实际 '${String(ch)}'`)
  }
  if (ch === 'feishu') {
    const f = cfg.feishu
    // 必填项须为非空字符串：真值判断挡不住 []、{}、空白串等非法类型，会漏进 notifier
    const nonblank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
    const missing: string[] = []
    if (!nonblank(f.appId)) missing.push('feishu.appId')
    if (!nonblank(f.appSecret)) missing.push('feishu.appSecret')
    if (!nonblank(f.email) && !nonblank(f.mobile)) missing.push('feishu.email 或 feishu.mobile')
    if (missing.length > 0) {
      throw new Error(`channel='feishu' 缺少必填项：${missing.join('、')}`)
    }
  }
}

/** 纯函数：与 DEFAULT_CONFIG 深合并并校验必填项（供测试与 main() 复用） */
export function mergeConfig(userConfig: unknown): Config {
  if (!isPlainObject(userConfig)) {
    throw new Error('配置文件顶层必须是对象')
  }
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), userConfig) as Config
  validate(merged)
  return merged
}

/** 默认读取：文件不存在返回 null，其余错误照抛 */
function readFileIfExists(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** 加载配置：读文件（若存在）、深合并、校验必填项。缺省路径 codexmonitor.config.json。 */
export function loadConfig(path?: string, readFileImpl?: ReadFile): Config {
  const file = path ?? DEFAULT_PATH
  const read = readFileImpl ?? readFileIfExists
  const text = read(file)
  if (text === null) return structuredClone(DEFAULT_CONFIG)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`解析配置文件失败 ${file}: ${msg}`)
  }
  return mergeConfig(parsed)
}
