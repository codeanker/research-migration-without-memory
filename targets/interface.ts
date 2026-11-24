import type { HeartbeatTick } from '../shared/heartbeat.ts'
import type { ProcessState } from '../shared/work-state.ts'

export type TargetHandle = object

export interface Tooling {
  unzip: string
  node: string
  npm: string
}

export interface TargetMeta {
  targetNodeVersion?: string | null
  tooling?: Tooling | null
}

export interface CreateResult<H extends TargetHandle = TargetHandle> {
  handle: H
  boot_ms: number
  meta?: TargetMeta
}

export interface CreateOptions {
  lifetimeMs?: number
}

export interface WritePayloadResult {
  upload_ms: number
}

export interface UnpackResult {
  unpack_ms: number
  heartbeat_baseline_lines: number
}

export interface InstallResult {
  install_ms: number
}

export interface RestoreResult {
  restart_ms: number
  restore_issued_at: number
}

export interface WaitAliveResult {
  alive_ms: number
  first_tick_at: string
  first_tick_counter: number
  restore_mark_ns: bigint | null
  detect_at: number
}

export interface ProgressResult {
  last_tick: HeartbeatTick | null
  lines: number
  state: ProcessState | null
}

export interface ClockOffsetResult {
  offset_ms: number
  rtt_ms: number
  samples: number
}

export class AliveTimeoutError extends Error {
  readonly alive_ms: number

  constructor(message: string, aliveMs: number) {
    super(message)
    this.name = 'AliveTimeoutError'
    this.alive_ms = aliveMs
  }
}
