/** Ink 界面：状态头 + 最近通知 + 快捷键栏。所有图标为纯 ASCII */

import React, { useEffect, useSyncExternalStore } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { Controls } from '../index.js'
import type { WindowState } from '../policy/quota-tracker.js'
import {
  formatClock,
  formatLatency,
  formatRelative,
  formatUptime,
  progressBar,
  severityIcon,
  stripEmoji,
  verdictIcon,
} from './format.js'
import type { TuiStore } from './store.js'

export type AppProps = {
  store: TuiStore
  controls: Controls
  /** 重载配置；返回给用户看的提示文案 */
  onReload: () => Promise<string>
}

const quotaLine = (label: string, w: WindowState | undefined): string =>
  w == null
    ? `${label} --`
    : `${label} [${progressBar(w.usedPercent)}] ${Math.round(w.usedPercent)}%${w.waiting ? ' (等待重置)' : ''}`

export function App({ store, controls, onReload }: AppProps): React.ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { exit } = useApp()

  useEffect(() => {
    const timer = setInterval(() => {
      store.dispatch({ type: 'tick', now: Date.now() })
    }, 1000)
    return () => clearInterval(timer)
  }, [store])

  useInput((input) => {
    const now = Date.now()
    if (input === 'q') {
      exit()
      return
    }
    if (input === 't') {
      store.dispatch({ type: 'toast', text: '正在发送测试通知…', now })
      void controls.sendTest()
      return
    }
    if (input === 'p') {
      if (!state.probeEnabled) {
        store.dispatch({ type: 'toast', text: '探针已关闭', now })
        return
      }
      const paused = !state.probePaused
      controls.setProbePaused(paused)
      store.dispatch({ type: 'probePaused', paused, now })
      store.dispatch({ type: 'toast', text: paused ? '探针已暂停' : '探针已恢复', now })
      return
    }
    if (input === 'r') {
      store.dispatch({ type: 'toast', text: '正在重载配置…', now })
      void onReload().then((text) => {
        store.dispatch({ type: 'toast', text, now: Date.now() })
      })
    }
  })

  const probe = state.probe
  const network = probe
    ? `${verdictIcon(probe.verdict, { paused: state.probePaused, enabled: state.probeEnabled })} ` +
      `L2 ${probe.status == null ? '-' : probe.status} · ${formatLatency(probe.latencyMs)} · ` +
      `${formatRelative(state.now - probe.at)}`
    : `${verdictIcon('ok', { paused: state.probePaused, enabled: state.probeEnabled })} 等待首次探测`

  const recent = state.log.slice(-6)

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>
        CodexMonitor · 通道 {state.channel} · 运行 {formatUptime(state.now - state.startedAt)}
      </Text>
      <Text>网络 {network}</Text>
      <Text>
        {quotaLine('5h', state.quota.fiveHour)}   {quotaLine('7d', state.quota.sevenDay)}
      </Text>
      <Text>
        投递 待发 {state.pendingCount} · 本次运行 {state.deliveredCount} 条 · 最近{' '}
        {state.lastDeliveryOk == null ? '-' : state.lastDeliveryOk ? 'ok' : 'FAIL'}
      </Text>
      <Text dimColor>最近通知</Text>
      {recent.length === 0 ? (
        <Text dimColor>暂无通知</Text>
      ) : (
        recent.map((entry, index) => (
          <Text key={`${entry.at}-${index}`}>
            {formatClock(entry.at)} {severityIcon(entry.severity)} {stripEmoji(entry.text)}
            {entry.ok === false ? ' (FAIL)' : ''}
          </Text>
        ))
      )}
      <Text>
        {state.toast ? state.toast.text : '[t] 测试通知  [p] 暂停探针  [r] 重载配置  [q] 退出'}
      </Text>
    </Box>
  )
}
