
export interface ProcessState {
  counter?: number
  pid?: number
  updatedAt?: string
  loggingOverheadMs?: number | null
}

export interface ProcessSnapshot {
  command?: string
  cwd?: string
  counter?: number | null
  logIntervalMs?: number | null
  stateLossTicks?: number | null
}
