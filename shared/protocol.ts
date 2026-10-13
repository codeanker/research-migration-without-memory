
export const HEADER = {
  exportMs: 'X-Export-Ms',
  stage: 'X-Stage',
  strategy: 'X-Strategy',
  runIndex: 'X-Run-Index',
  sessionLabel: 'X-Session-Label',
  userAgent: 'X-User-Agent',
  stopAt: 'X-Stop-At',
  lastSourceTickAt: 'X-Last-Source-Tick-At',
  killToExportMs: 'X-Kill-To-Export-Ms',
  stopOffsetTargetMs: 'X-Stop-Offset-Target-Ms',
  stopOffsetActualMs: 'X-Stop-Offset-Actual-Ms',
  clientNow: 'X-Client-Now',
  clientClockSkewMs: 'X-Client-Clock-Skew-Ms',
  positionInCycle: 'X-Position-In-Cycle',
  cycle: 'X-Cycle',
  firstRun: 'X-First-Run',
  firstRunOfCell: 'X-First-Run-Of-Cell',
} as const

export type HeaderName = (typeof HEADER)[keyof typeof HEADER]

export const REQUEST_HEADER_NAMES: HeaderName[] = Object.values(HEADER)

export const CORS_ALLOW_HEADERS = [...REQUEST_HEADER_NAMES, 'Content-Type'].join(', ')

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: HeaderName
): string | undefined {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}
