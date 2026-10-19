/**
 * 配置加载与默认值。
 *
 * 配置文件为 JSON（codexmonitor.config.json），零解析依赖。
 * 完整字段说明见设计文档 §6。
 */

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

/** 加载配置：读取 JSON（若存在）并与 DEFAULT_CONFIG 深合并，校验必填项。 */
export function loadConfig(_path?: string): Config {
  throw new Error('Not implemented: loadConfig')
}
