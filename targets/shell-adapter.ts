import path from 'node:path'
import { AliveTimeoutError } from './interface.ts'
import type {
  ClockOffsetResult,
  CreateOptions,
  CreateResult,
  InstallResult,
  ProgressResult,
  RestoreResult,
  Tooling,
  UnpackResult,
  WaitAliveResult,
  WritePayloadResult,
} from './interface.ts'
import { parseHeartbeatLine } from '../shared/heartbeat.ts'
import type { HeartbeatTick } from '../shared/heartbeat.ts'
import type { ProcessSnapshot, ProcessState } from '../shared/work-state.ts'
import { sleep, timed, withTimeout } from '../shared/timing.ts'

const PAYLOAD_FILE = 'payload.zip'
const RESTORE_MARK_FILE = 'restore-mark'
const WORK_DIR = 'work'
const HEARTBEAT_FILE = 'heartbeat.log'
const STATE_FILE = 'state.json'
const CLOCK_SAMPLES = 5
const DEFAULT_EXEC_TIMEOUT_MS = 60000
const WAIT_ALIVE_TIMEOUT_MS = 20000
const WAIT_ALIVE_POLL_MS = 300
const INSTALL_TIMEOUT_MS = 120000

export interface ShellHandle {
  home: string
}

export interface ExecOptions {
  background?: boolean
  timeoutMs?: number
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export abstract class ShellTargetAdapter<H extends ShellHandle = ShellHandle> {
  tooling: Tooling | null = null

  abstract createTarget(opts?: CreateOptions): Promise<CreateResult<H>>

  abstract exec(handle: H, script: string, opts?: ExecOptions): Promise<ExecResult>

  abstract writeFileToTarget(handle: H, targetPath: string, bytes: Buffer): Promise<void>

  abstract destroy(handle: H): Promise<void>

  async create(opts?: CreateOptions): Promise<CreateResult<H>> {
    const created = await this.createTarget(opts)
    this.tooling ??= await this.checkTooling(created.handle)
    return { ...created, meta: { ...(created.meta ?? {}), tooling: this.tooling } }
  }

  async checkTooling(handle: H): Promise<Tooling> {
    const script =
      `printf 'UNZIP=%s\\n' "$(command -v unzip)"; printf 'NODE=%s\\n' "$(command -v node)"; ` +
      `printf 'NPM=%s\\n' "$(command -v npm)"`
    const res = await this.run(handle, script)
    const unzip = matchValue(res.stdout, 'UNZIP')
    const node = matchValue(res.stdout, 'NODE')
    const npm = matchValue(res.stdout, 'NPM')
    if (!unzip || !node || !npm) {
      throw new Error(`target image lacks a tool: unzip="${unzip}", node="${node}", npm="${npm}"`)
    }
    return { unzip, node, npm }
  }

  async writePayload(handle: H, bytes: Buffer): Promise<WritePayloadResult> {
    const { ms } = await timed(() => this.writeFileToTarget(handle, payloadPath(handle), bytes))
    return { upload_ms: ms }
  }

  async unpack(handle: H): Promise<UnpackResult> {
    const script =
      `cd ${handle.home} && ` +
      `unzip -oq ${payloadPath(handle)} && ` +
      `printf 'BASELINE_LINES=%s\\n' "$(wc -l < ${WORK_DIR}/${HEARTBEAT_FILE} 2>/dev/null || echo 0)"`
    const { value: result, ms: unpack_ms } = await timed(() => this.run(handle, script))
    if (result.exitCode !== 0) {
      throw new Error(`unpack failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
    }
    const baseline = matchValue(result.stdout, 'BASELINE_LINES')
    if (baseline === null || !/^\d+$/.test(baseline)) {
      throw new Error(
        `unpack did not report a heartbeat baseline line count. stdout: ${result.stdout}`
      )
    }
    return { unpack_ms, heartbeat_baseline_lines: Number(baseline) }
  }

  async install(handle: H): Promise<InstallResult> {
    const script = `cd ${path.posix.join(handle.home, WORK_DIR)} && npm ci --no-audit --no-fund`
    const { value: result, ms: install_ms } = await timed(() =>
      this.run(handle, script, { timeoutMs: INSTALL_TIMEOUT_MS })
    )
    if (result.exitCode !== 0) {
      throw new Error(`install failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
    }
    return { install_ms }
  }

  async restore(handle: H, snapshot: ProcessSnapshot): Promise<RestoreResult> {
    const cwd = path.posix.join(handle.home, snapshot.cwd)
    const command = snapshot.command
    const script = `date +%s%N > ${markPath(handle)}; cd ${cwd} && exec ${command}`
    const restore_issued_at = Date.now()
    const { ms } = await timed(() => this.run(handle, script, { background: true }))
    return { restart_ms: ms, restore_issued_at }
  }

  async waitAlive(handle: H, baselineLines: number): Promise<WaitAliveResult> {
    const t0 = performance.now()
    const heartbeatPath = path.posix.join(handle.home, WORK_DIR, HEARTBEAT_FILE)
    const firstNewLine = baselineLines + 1
    const script =
      `printf 'MARK=%s\\n' "$(cat ${markPath(handle)} 2>/dev/null)"; ` +
      `printf 'LINE=%s\\n' "$(sed -n '${firstNewLine}p' ${heartbeatPath} 2>/dev/null)"`
    let detected: { tick: HeartbeatTick; at: number } | null = null
    let restore_mark_ns: bigint | null = null
    let lastRaw = ''
    while (performance.now() - t0 < WAIT_ALIVE_TIMEOUT_MS) {
      const res = await this.run(handle, script)
      lastRaw = res.stdout
      const mark = matchValue(lastRaw, 'MARK')
      if (mark && /^\d+$/.test(mark)) restore_mark_ns = BigInt(mark)
      const parsed = parseHeartbeatLine(matchValue(lastRaw, 'LINE'))
      if (parsed) {
        detected = { tick: parsed, at: Date.now() }
        break
      }
      await sleep(WAIT_ALIVE_POLL_MS)
    }
    const alive_ms = performance.now() - t0
    if (!detected) {
      throw new AliveTimeoutError(
        `No heartbeat line ${firstNewLine} within ${WAIT_ALIVE_TIMEOUT_MS}ms - the resumed process wrote no ` +
          `new tick (last poll: ${lastRaw.trim() || 'empty'})`,
        alive_ms
      )
    }
    return {
      alive_ms,
      first_tick_at: detected.tick.at,
      first_tick_counter: detected.tick.counter,
      restore_mark_ns,
      detect_at: detected.at,
    }
  }

  async readProgress(handle: H): Promise<ProgressResult> {
    const work = path.posix.join(handle.home, WORK_DIR)
    const script =
      `cd ${work} 2>/dev/null || exit 0; ` +
      `printf 'LINES=%s\\n' "$(wc -l < ${HEARTBEAT_FILE} 2>/dev/null || echo 0)"; ` +
      `printf 'LAST=%s\\n' "$(tail -n 2 ${HEARTBEAT_FILE} 2>/dev/null | head -n 1)"; ` +
      `printf 'STATE=%s\\n' "$(tr -d '\\n' < ${STATE_FILE} 2>/dev/null)"`
    const res = await this.run(handle, script)
    const stdout = res.stdout
    const lines = matchValue(stdout, 'LINES')
    const rawState = matchValue(stdout, 'STATE')
    let state: ProcessState | null = null
    if (rawState) {
      try {
        state = JSON.parse(rawState) as ProcessState
      } catch {
        state = null
      }
    }
    return {
      last_tick: parseHeartbeatLine(matchValue(stdout, 'LAST')),
      lines: lines !== null && /^\d+$/.test(lines) ? Number(lines) : 0,
      state,
    }
  }

  async clockOffset(handle: H): Promise<ClockOffsetResult> {
    let best: { offset_ms: number; rtt_ms: number } | null = null
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      const t1 = Date.now()
      const res = await this.run(handle, 'date +%s%N')
      const t2 = Date.now()
      const raw = res.stdout.trim()
      if (!/^\d+$/.test(raw)) continue
      const rtt_ms = t2 - t1
      const target_ms = Number(BigInt(raw) / 1000000n)
      const offset_ms = target_ms - (t1 + rtt_ms / 2) // Cristian's algorithm
      if (!best || rtt_ms < best.rtt_ms) best = { offset_ms, rtt_ms }
    }
    if (!best) throw new Error('clockOffset: no usable `date +%s%N` reading from the target')
    return { ...best, samples: CLOCK_SAMPLES }
  }

  async run(handle: H, script: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
    return withTimeout(
      this.exec(handle, script, { ...opts, timeoutMs }),
      timeoutMs,
      `target command exceeded ${timeoutMs}ms: ${script.slice(0, 120)}`
    )
  }
}

function payloadPath(handle: ShellHandle): string {
  return path.posix.join(handle.home, PAYLOAD_FILE)
}

function markPath(handle: ShellHandle): string {
  return path.posix.join(handle.home, RESTORE_MARK_FILE)
}

function matchValue(stdout: string | null | undefined, key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(stdout || '')
  return match ? match[1].trim() : null
}
