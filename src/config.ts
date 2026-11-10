/**
 * 配置加载与默认值。
 *
 * 配置文件为 JSON（codexmonitor.config.json），零解析依赖。
 * 完整字段说明见设计文档 §6。
 */

import { readFileSync } from 'node:fs'

/** 推送通道判别：ilink（微信 iLink）、feishu、console（本地验证，打印到 stdout） */
export type Channel = 'ilink' | 'feishu' | 'console'

/** 工作时间段：范围外静默推送（仅支持同一天内的 start < end） */
export type WorkHoursConfig = {
  enabled: boolean
  /** HH:MM，含 */
  start: string
  /** HH:MM，不含 */
  end: string
  /** 0=周日 … 6=周六；未列出的日期全天静默 */
  days: number[]
  /** IANA 时区；空串表示系统本地时区 */
  timezone: string
}

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
    workHours: WorkHoursConfig
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
    workHours: {
      enabled: true,
      start: '09:00',
      end: '19:00',
      days: [1, 2, 3, 4, 5],
      timezone: '',
    },
  },
  probe: {
    enabled: true,
    // 实测 L2 正常 0.8–2s、抖动时易破 3s；确认窗口过短会把抖动放大成告警
    intervalMs: 20000,
    timeoutMs: 6000,
    slowThresholdMs: 2500,
    retryDelayMs: 5000,
    confirmAttempts: 3,
    recoverAttempts: 3,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    targets: {
      // Codex 真实端点（config.toml: wire_api = "responses"）；未认证返回 401，
      // 能区分「链路可达」与「被 Cloudflare 拦截（403）」
      l2: 'https://api.openai.com/v1/responses',
      // 辅助信息：直连可达性，不参与代理模式下的故障归因
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

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function clockMinutes(value: string): number | null {
  const m = CLOCK_RE.exec(value)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function validateWorkHours(w: WorkHoursConfig): void {
  if (typeof w.enabled !== 'boolean') {
    throw new Error('notify.workHours.enabled 必须是布尔值')
  }
  const start = clockMinutes(w.start)
  const end = clockMinutes(w.end)
  if (start == null || end == null) {
    throw new Error('notify.workHours.start/end 必须是 HH:MM 格式')
  }
  if (start >= end) {
    throw new Error('notify.workHours.start 必须早于 end（不支持跨午夜时间段）')
  }
  if (
    !Array.isArray(w.days) ||
    w.days.length === 0 ||
    w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    new Set(w.days).size !== w.days.length
  ) {
    throw new Error('notify.workHours.days 必须是 0–6 的非空不重复数组')
  }
  if (w.timezone !== '') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: w.timezone })
    } catch {
      throw new Error(`notify.workHours.timezone 不是合法 IANA 时区：'${w.timezone}'`)
    }
  }
}

/** 校验必填项：channel 枚举 + feishu 凭证完备性 + 工作时间。 */
function validate(cfg: Config): void {
  const ch = cfg.notify.channel
  if (ch !== 'ilink' && ch !== 'feishu' && ch !== 'console') {
    throw new Error(`notify.channel 必须是 'ilink' / 'feishu' / 'console'，实际 '${String(ch)}'`)
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
  validateWorkHours(cfg.notify.workHours)
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
