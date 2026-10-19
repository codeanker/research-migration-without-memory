import type { HeartbeatTick } from '../shared/heartbeat.ts'
import type { ProcessSnapshot, ProcessState } from '../shared/work-state.ts'

export type TargetHandle = object

export interface Tooling {
  unzip: string
  node: string
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

export interface WaitAliveOptions {
  timeoutMs?: number
  pollMs?: number
  baselineLines?: number
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

export interface ClockOffsetOptions {
  samples?: number
}

export abstract class TargetAdapter<H extends TargetHandle = TargetHandle> {
  static NAME = 'unimplemented'

  abstract create(opts?: CreateOptions): Promise<CreateResult<H>>

  abstract writePayload(handle: H, bytes: Buffer): Promise<WritePayloadResult>

  abstract unpack(handle: H): Promise<UnpackResult>

  abstract install(handle: H): Promise<InstallResult>

  abstract restore(handle: H, snapshot: ProcessSnapshot | null): Promise<RestoreResult>

  abstract waitAlive(handle: H, opts?: WaitAliveOptions): Promise<WaitAliveResult>

  abstract readProgress(handle: H): Promise<ProgressResult>

  abstract clockOffset(handle: H, opts?: ClockOffsetOptions): Promise<ClockOffsetResult>

  abstract destroy(handle: H): Promise<void>
}

export class AliveTimeoutError extends Error {
  readonly code = 'ALIVE_TIMEOUT'
  readonly alive_ms: number

  constructor(message: string, aliveMs: number) {
    super(message)
    this.name = 'AliveTimeoutError'
    this.alive_ms = aliveMs
  }
}
