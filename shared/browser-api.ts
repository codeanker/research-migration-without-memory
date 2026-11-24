export interface RunRequest {
  stage: string
  strategy: string
  runIndex: number | string
  sessionLabel?: string
  runnerUrl: string
  logIntervalMs: number
  stopOffsetMs: number
  warmupStateWrites?: number
  positionInCycle?: number | null
  cycle?: number | null
  firstRun?: boolean
  firstRunOfCell?: boolean
}

export type CsvRowJson = Record<string, unknown>

export interface RunOutcome {
  row: CsvRowJson
  stop_offset_actual_ms: number | null
}

export interface HandoverApi {
  runOnce: (request: RunRequest) => Promise<RunOutcome>
}

export type RunnerError = Error & { row?: CsvRowJson }
