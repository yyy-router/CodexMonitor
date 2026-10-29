/**
 * 组装 + 生命周期 + tick 循环（§3）。
 *
 * createMonitor() 是可停止、可重建的监控核心；main() 是「等信号退出」的薄壳。
 * TUI / 脚本通过 createMonitor 返回的 Controls 做少量操作（测试推送、暂停探针、停止）。
 */

import { pathToFileURL } from 'node:url'
import { loadConfig, type Config } from './config.js'
import { classify } from './policy/classify.js'
import { createAggregator } from './policy/aggregator.js'
import { createQuotaTracker } from './policy/quota-tracker.js'
import { createQuotaGuard } from './policy/quota-guard.js'
import { createPolicyEngine } from './policy/engine.js'
import { createTailer } from './watcher/tailer.js'
import { parseLine, parseSessionMeta } from './watcher/parse.js'
import { FeishuNotifier } from './notify/feishu-notifier.js'
import { ConsoleNotifier } from './notify/console-notifier.js'
import { createDeliveryLog } from './notify/delivery-log.js'
import { createStateStore } from './store/state-store.js'
import { detectProxy } from './probe/proxy-detect.js'
import { probeOnce, type ProbeResult } from './probe/targets.js'
import { createRuntime, type RuntimeEvent } from './runtime.js'
import { expandHome } from './paths.js'
import type { Notifier } from './notify/notifier.js'

/** tick 循环间隔：决定聚合 flush 与额度倒计时的检查频率 */
const TICK_INTERVAL_MS = 1000

export { expandHome }

export type MainDeps = {
  /** 注入通道（测试替身 / ConsoleNotifier）；缺省按配置创建 */
  notifier?: Notifier
  /** 注入探测实现，缺省走真实网络 */
  probe?: () => Promise<ProbeResult>
  now?: () => number
  log?: (line: string) => void
  /** 测试注入：触发后优雅退出；缺省监听 SIGINT / SIGTERM */
  signal?: AbortSignal
  /** tick 循环间隔（毫秒），默认 1000；集成测试可缩短 */
  tickIntervalMs?: number
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 按配置创建推送通道；iLink 本轮不实现，明确报错而不是静默降级 */
export function createNotifier(cfg: Config): Notifier {
  switch (cfg.notify.channel) {
    case 'feishu':
      return new FeishuNotifier({
        appId: cfg.feishu.appId,
        appSecret: cfg.feishu.appSecret,
        email: cfg.feishu.email,
        mobile: cfg.feishu.mobile,
      })
    case 'console':
      return new ConsoleNotifier()
    case 'ilink':
      throw new Error(
        "iLink 通道尚未实现（本轮不兼容 iLink），请把 notify.channel 设为 'feishu' 或 'console'",
      )
  }
}

/** 默认停止信号：SIGINT / SIGTERM */
function createStopSignal(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    },
  }
}

/** 控制面：TUI / 脚本可调用的少量操作 */
export type Controls = {
  /** 发一条测试通知，走真实投递链路 */
  sendTest(): Promise<void>
  /** 暂停 / 恢复探针；恢复时立即补跑一轮 */
  setProbePaused(paused: boolean): void
  /** 优雅停止：清定时器、等在飞任务、落盘、停通道；幂等 */
  stop(): Promise<void>
}

export type MonitorDeps = Omit<MainDeps, 'signal'> & {
  /** 运行时事件观察者（TUI 数据源） */
  onEvent?: (e: RuntimeEvent) => void
}

export type Monitor = Controls & {
  start(): Promise<void>
}

/** 组装全部模块并启动常驻循环；返回的控制面用于操作与停止 */
export function createMonitor(cfg: Config, deps: MonitorDeps = {}): Monitor {
  const now = deps.now ?? ((): number => Date.now())
  const log = deps.log ?? ((line: string): void => console.log(`[codexmonitor] ${line}`))

  const notifier = deps.notifier ?? createNotifier(cfg)
  const thresholds = cfg.notify.thresholds
  const quota = createQuotaTracker({ thresholds })
  const policy = createPolicyEngine({
    classify: (ev) => classify(ev, thresholds),
    aggregator: createAggregator(cfg.notify.aggregate),
    quotaTracker: quota,
    // 只有 iLink 有会话额度模型；飞书 / 控制台不设防
    quotaGuard: cfg.notify.channel === 'ilink' ? createQuotaGuard(cfg.ilink.quota) : undefined,
  })

  const stateDir = expandHome(cfg.state.dir)
  const stateStore = createStateStore(stateDir)
  const deliveryLog = createDeliveryLog(stateDir)
  const tailer = createTailer({
    sessionsDir: expandHome(cfg.codex.sessionsDir),
    maxTrackedFiles: cfg.codex.maxTrackedFiles,
    parseLine,
    parseSessionMeta,
  })

  const probe =
    deps.probe ??
    (async (): Promise<ProbeResult> => probeOnce(await detectProxy(cfg.probe.proxy), cfg.probe))

  const runtime = createRuntime({
    cfg,
    notifier,
    policy,
    quota,
    stateStore,
    deliveryLog,
    probe,
    now,
    log,
    onEvent: deps.onEvent,
  })

  let stopped = false
  let started = false
  let paused = false
  let stopPromise: Promise<void> | undefined
  let ticking = false
  let tickTimer: NodeJS.Timeout | undefined
  let probeTimer: NodeJS.Timeout | undefined
  const inFlight = new Set<Promise<void>>()

  const track = (task: Promise<void>): void => {
    inFlight.add(task)
    const done = (): void => {
      inFlight.delete(task)
    }
    task.then(done, done)
  }

  const clearProbe = (): void => {
    if (probeTimer) {
      clearTimeout(probeTimer)
      probeTimer = undefined
    }
  }

  const onTick = async (): Promise<void> => {
    try {
      const events = await tailer.tick()
      if (events.length > 0) await runtime.ingest(events)
      await runtime.tick()
    } catch (e) {
      log(`tick 失败：${errText(e)}`)
    }
  }

  const scheduleProbe = (delayMs: number): void => {
    if (stopped || paused || !cfg.probe.enabled) return
    clearProbe()
    probeTimer = setTimeout(() => {
      probeTimer = undefined
      if (stopped || paused) return
      track(onProbe())
    }, delayMs)
  }

  const onProbe = async (): Promise<void> => {
    if (stopped || paused) return
    let delay = cfg.probe.intervalMs
    try {
      const { verdict, state } = await runtime.probeRound()
      const healthy = verdict === 'ok' || verdict === 'slow'
      // 正常态下出现故障：先快速重试确认，而不是等满一个间隔（§4.2）
      delay = !healthy && state === 'normal' ? cfg.probe.retryDelayMs : cfg.probe.intervalMs
    } catch (e) {
      log(`探针失败：${errText(e)}`)
      delay = cfg.probe.retryDelayMs
    }
    scheduleProbe(delay)
  }

  /** 幂等且并发安全：所有调用方等到同一个停止完成 */
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopped = true
    stopPromise = (async () => {
      if (tickTimer) clearInterval(tickTimer)
      clearProbe()
      // 等本轮 tick / 探针 / 测试推送跑完，避免「已停止」之后还有消息发出、状态还在写
      await Promise.allSettled([...inFlight])
      try {
        await runtime.stop()
      } catch (e) {
        log(`停止时出错：${errText(e)}`)
      }
      log('已停止')
    })()
    return stopPromise
  }

  const start = async (): Promise<void> => {
    if (started) return
    started = true
    await runtime.start()
    if (stopped) return
    tickTimer = setInterval(() => {
      if (stopped || ticking) return
      ticking = true
      track(
        onTick().finally(() => {
          ticking = false
        }),
      )
    }, deps.tickIntervalMs ?? TICK_INTERVAL_MS)
    if (cfg.probe.enabled) scheduleProbe(cfg.probe.intervalMs)
    log(`已启动（通道：${cfg.notify.channel}）`)
  }

  return {
    start,
    stop,
    async sendTest() {
      // 停止后不再发送；在途的推送纳入 inFlight，stop() 会等它结束
      if (stopped) return
      const task = runtime.sendTest()
      track(task)
      await task
    },
    setProbePaused(next: boolean) {
      if (stopped || !cfg.probe.enabled) return
      paused = next
      if (paused) clearProbe()
      else scheduleProbe(0)
    },
  }
}

/** 组装并常驻，收到停止信号后 resolve（现有行为，集成测试依赖） */
export async function main(config?: Config, deps: MainDeps = {}): Promise<void> {
  const cfg = config ?? loadConfig()
  const signalCtl = deps.signal
    ? { signal: deps.signal, dispose: (): void => {} }
    : createStopSignal()
  const { signal: _signal, ...monitorDeps } = deps
  const monitor = createMonitor(cfg, monitorDeps)

  try {
    await monitor.start()
  } catch (e) {
    // 启动失败也要移除信号监听，否则宿主进程会残留指向废弃 controller 的 handler
    signalCtl.dispose()
    throw e
  }

  if (signalCtl.signal.aborted) {
    await monitor.stop()
    signalCtl.dispose()
    return
  }

  await new Promise<void>((resolve) => {
    signalCtl.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  await monitor.stop()
  signalCtl.dispose()
}

/**
 * 仅在直接执行 dist/index.js 时启动；被测试 import 时不触发。
 * 接入 dist/cli.js 后（PR 2）删除。
 */
const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  void main().catch((e) => {
    console.error(`[codexmonitor] 启动失败：${errText(e)}`)
    process.exitCode = 1
  })
}
