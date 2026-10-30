/** 左侧状态卡：额度（含重置倒计时）与投递统计 */

import React from 'react'
import { Box, Text } from 'ink'
import type { WindowState } from '../../policy/quota-tracker.js'
import { formatCountdown, progressBar } from '../format.js'
import { quotaColor } from '../theme.js'
import type { TuiState } from '../store.js'

type QuotaRowProps = {
  label: string
  window: WindowState | undefined
  now: number
  warnAt: number
  criticalAt: number
}

function QuotaRow({ label, window: w, now, warnAt, criticalAt }: QuotaRowProps): React.ReactElement {
  if (w == null) return <Text dimColor>{label} --</Text>

  const pct = Math.round(w.usedPercent)
  const resetMs = w.resetsAt == null ? null : w.resetsAt * 1000 - now
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{label} </Text>
        <Text color={quotaColor(pct, warnAt, criticalAt)}>[{progressBar(w.usedPercent)}]</Text>
        <Text> {pct}%</Text>
      </Text>
      {resetMs != null &&
        (resetMs <= 0 ? (
          <Text dimColor>   已到重置时间</Text>
        ) : (
          <Text dimColor>   重置 {formatCountdown(resetMs)} 后</Text>
        ))}
    </Box>
  )
}

export function StatusPanel({
  state,
  width,
}: {
  state: TuiState
  width?: number
}): React.ReactElement {
  return (
    <Box flexDirection="column" width={width}>
      <Text bold dimColor>
        额度
      </Text>
      <QuotaRow
        label="5h"
        window={state.quota.fiveHour}
        now={state.now}
        warnAt={state.quotaWarnAt}
        criticalAt={state.quotaCriticalAt}
      />
      <QuotaRow
        label="7d"
        window={state.quota.sevenDay}
        now={state.now}
        warnAt={state.quotaWarnAt}
        criticalAt={state.quotaCriticalAt}
      />
      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>
          投递
        </Text>
        <Text>
          待发 {state.pendingCount} · 已发 {state.deliveredCount} ·{' '}
          {state.lastDeliveryOk == null ? '-' : state.lastDeliveryOk ? 'ok' : 'FAIL'}
        </Text>
      </Box>
    </Box>
  )
}
