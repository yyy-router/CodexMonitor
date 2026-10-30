/** 右侧通知流：时间 / 级别 / 正文，正文去掉 emoji 并按宽度截断 */

import React from 'react'
import { Box, Text } from 'ink'
import { formatClock, severityIcon, stripEmoji } from '../format.js'
import { severityBold, severityColor } from '../theme.js'
import type { TuiState } from '../store.js'

const MAX_ROWS = 6

export function NotificationList({
  state,
  width,
}: {
  state: TuiState
  width: number
}): React.ReactElement {
  const recent = state.log.slice(-MAX_ROWS)

  return (
    <Box flexDirection="column" width={width}>
      <Text bold dimColor>
        最近通知
      </Text>
      {recent.length === 0 ? (
        <Text dimColor>暂无通知</Text>
      ) : (
        recent.map((entry, index) => (
          <Box key={`${entry.at}-${index}`} width={width}>
            <Text wrap="truncate">
              <Text dimColor>{formatClock(entry.at)} </Text>
              <Text color={severityColor(entry.severity)} bold={severityBold(entry.severity)}>
                {severityIcon(entry.severity)}
              </Text>
              {' '}
              {stripEmoji(entry.text)}
              {entry.ok === false ? ' (FAIL)' : ''}
            </Text>
          </Box>
        ))
      )}
    </Box>
  )
}
