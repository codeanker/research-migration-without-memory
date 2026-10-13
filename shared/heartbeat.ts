
export const HEARTBEAT_TICK_MS = 100

export interface HeartbeatTick {
  at: string
  counter: number
  pid: number
}

export function formatHeartbeatLine(at: string, counter: number, pid: number): string {
  return at + ' counter=' + counter + ' pid=' + pid
}

export const HEARTBEAT_FORMATTER_SRC = `const formatHeartbeatLine = ${formatHeartbeatLine.toString()}`

const HEARTBEAT_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\S+Z) counter=(\d+) pid=(\d+)$/

export function parseHeartbeatLine(line: string | null | undefined): HeartbeatTick | null {
  const match = HEARTBEAT_LINE_RE.exec((line || '').trim())
  if (!match) return null
  const at = match[1]
  if (!Number.isFinite(Date.parse(at))) return null
  return { at, counter: Number(match[2]), pid: Number(match[3]) }
}

export function lastHeartbeatTick(logContent: string): HeartbeatTick | null {
  const lines = logContent.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const tick = parseHeartbeatLine(lines[i])
    if (tick) return tick
  }
  return null
}
