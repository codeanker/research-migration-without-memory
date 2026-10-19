import 'dotenv/config'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendCsvRow, ensureCsvHeader, makeEmptyRow } from './csv.ts'
import type { Row } from './csv.ts'
import {
  writeEnvInfo,
  recordBrowserUserAgent,
  recordTargetMeta,
  recordClockInfo,
} from './env-info.ts'
import {
  checkTimingSanity,
  computeInterruption,
  pollRestMs,
  resumeCheckMessage,
  loadedCounter,
  stateRestored,
  tickCorrectedDurations,
} from './timing.ts'
import type { TimingContext } from './timing.ts'
import { epochMsOf, errorMessage, num, numberOrBlank } from './util.ts'
import { loadAdapter } from '../targets/registry.ts'
import { AliveTimeoutError, TargetAdapter } from '../targets/interface.ts'
import type { CreateOptions, TargetHandle, WaitAliveResult } from '../targets/interface.ts'
import { sleep, timed, withTimeout } from '../shared/timing.ts'
import { CORS_ALLOW_HEADERS, HEADER, headerValue } from '../shared/protocol.ts'
import { assertStrategy, isKnownStage, isMeasurementStage, KNOWN_STAGES } from '../shared/stages.ts'
import type { ProcessSnapshot, ProcessState } from '../shared/work-state.ts'
import { stageNeedsInstall } from '../browser/src/payload.ts'
import { isPushStrategy, pushInstalls, zipListingTotals } from '../shared/push.ts'

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data')
const CSV_PATH = process.env.CSV_PATH
  ? path.resolve(process.env.CSV_PATH)
  : path.join(DATA_DIR, 'results.csv')
const ENV_PATH = process.env.ENV_PATH
  ? path.resolve(process.env.ENV_PATH)
  : path.join(DATA_DIR, 'env.json')
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787
const TARGET_NAME = process.env.TARGET || 'e2b'
const PREPARE_TTL_MS = process.env.PREPARE_TTL_MS ? Number(process.env.PREPARE_TTL_MS) : 60000
if (!Number.isFinite(PREPARE_TTL_MS) || PREPARE_TTL_MS <= 0 || PREPARE_TTL_MS > 2 ** 31 - 1) {
  throw new Error(`PREPARE_TTL_MS must be a positive number of ms, got "${process.env.PREPARE_TTL_MS}"`)
}

const PREPARED_LIFETIME_MS = 600000
const RESUME_CHECK_MARGIN_MS = 400
const RESUME_CHECK_FALLBACK_INTERVAL_MS = 1000
const SHUTDOWN_TIMEOUT_MS = 20000

const STALL_POLL_MS = 1000
const STALL_THRESHOLD_MS = 5000

const adapter = await loadAdapter(TARGET_NAME)
const adapterName = (adapter.constructor as typeof TargetAdapter).NAME

await mkdir(DATA_DIR, { recursive: true })
await mkdir(path.dirname(CSV_PATH), { recursive: true })
await removeStaleUploads()
await ensureCsvHeader(CSV_PATH)
await writeEnvInfo(ENV_PATH, { adapterName })

let runCounter = 0
let targetMetaRecorded = false
let activeRun: Promise<void> | null = null
const liveHandles = new Set<TargetHandle>()

interface PreparedTarget {
  handle: TargetHandle
  run_id: string
  stage: string
  strategy: string
  push_bytes: number
  push_boot_ms: number
  push_upload_ms: number
  push_unpack_ms: number
  push_install_ms: number | ''
  expiry?: ReturnType<typeof setTimeout>
}
const preparedTargets = new Map<string, PreparedTarget>()
let shuttingDown = false

let stallSinceLastRunMs = 0
let lastWatchdogTickMs = Date.now()
const stallWatchdog = setInterval(() => {
  const now = Date.now()
  const jumpMs = now - lastWatchdogTickMs - STALL_POLL_MS
  lastWatchdogTickMs = now
  if (jumpMs > STALL_THRESHOLD_MS) {
    stallSinceLastRunMs += jumpMs
    console.warn(
      `[runner] wall clock jumped ${(jumpMs / 1000).toFixed(1)}s - the host was suspended. ` +
        'The run this falls into is marked with host_stall_ms.'
    )
  }
}, STALL_POLL_MS)
stallWatchdog.unref()

function takeHostStallMs(): number {
  const stall = stallSinceLastRunMs
  stallSinceLastRunMs = 0
  return stall
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  if (req.method === 'GET' && req.url === '/clock') {
    res
      .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify({ now: Date.now() }))
    return
  }
  const handler =
    req.method !== 'POST' ? null : req.url === '/run' ? handleRun : req.url === '/prepare' ? handlePrepare : null
  if (handler) {
    if (activeRun) {
      res
        .writeHead(409, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'a run is already in progress on this runner' }))
      return
    }
    activeRun = handler(req, res)
      .catch((err: unknown) => {
        console.error('[runner] writing the result failed:', err)
        if (!res.headersSent) {
          res
            .writeHead(500, { 'content-type': 'application/json' })
            .end(
              JSON.stringify({ error: `runner could not record the run: ${errorMessage(err)}` })
            )
        }
      })
      .finally(() => {
        activeRun = null
      })
    await activeRun
    return
  }
  res.writeHead(404).end('not found')
})

server.listen(PORT, () => {
  console.log(`[runner] Adapter: ${adapterName}`)
  console.log(`[runner] Listening on http://localhost:${PORT}, POST /prepare and /run`)
  console.log(`[runner] CSV: ${CSV_PATH}`)
  console.log(`[runner] env: ${ENV_PATH}`)
})

function assertRunnable(stage: string, strategy: string): void {
  if (!isKnownStage(stage)) {
    throw new Error(
      `unknown stage "${stage}" (known: ${KNOWN_STAGES.join(', ')}) - a typo here would label ` +
        'a whole cell wrongly, so the run is refused instead of measured'
    )
  }
  if (isMeasurementStage(stage) || strategy) assertStrategy(strategy)
}

async function createTarget(
  opts?: CreateOptions
): Promise<Awaited<ReturnType<TargetAdapter['create']>>> {
  const created = await adapter.create(opts)
  liveHandles.add(created.handle)
  if (!targetMetaRecorded && created.meta) {
    targetMetaRecorded = true
    recordTargetMeta(ENV_PATH, created.meta).catch((err: unknown) =>
      console.error('[runner] could not update env.json with target meta:', err)
    )
  }
  return created
}

function needsInstall(stage: string): boolean {
  return isMeasurementStage(stage) && stageNeedsInstall(stage)
}

async function handlePrepare(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const stage = headerValue(req.headers, HEADER.stage) || 'unknown'
  const strategy = headerValue(req.headers, HEADER.strategy) || ''
  const runIndex = headerValue(req.headers, HEADER.runIndex) || ''
  const run_id = [stage, strategy, runIndex].filter(Boolean).join('-')
  let handle: TargetHandle | null = null
  try {
    assertRunnable(stage, strategy)
    if (!isPushStrategy(strategy)) {
      throw new Error(`strategy "${strategy}" has no push phase, /prepare is only for push strategies`)
    }
    const body = await readBody(req)
    const created = await createTarget({ lifetimeMs: PREPARED_LIFETIME_MS })
    const targetHandle = created.handle
    handle = targetHandle
    const written = await adapter.writePayload(targetHandle, body)
    const unpacked = await adapter.unpack(targetHandle)
    const installed =
      pushInstalls(strategy) && needsInstall(stage) ? await adapter.install(targetHandle) : null
    const prepared: PreparedTarget = {
      handle: targetHandle,
      run_id,
      stage,
      strategy,
      push_bytes: body.length,
      push_boot_ms: created.boot_ms,
      push_upload_ms: written.upload_ms,
      push_unpack_ms: unpacked.unpack_ms,
      push_install_ms: installed ? installed.install_ms : '',
    }
    const token = randomUUID()
    preparedTargets.set(token, prepared)
    prepared.expiry = setTimeout(() => void expirePrepared(token), PREPARE_TTL_MS)
    const { handle: _handle, run_id: _runId, expiry: _expiry, ...values } = prepared
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token, ...values }))
  } catch (err: unknown) {
    console.error(`[runner] Prepare ${run_id} failed:`, err)
    if (handle) {
      liveHandles.delete(handle)
      try {
        await adapter.destroy(handle)
      } catch (destroyErr: unknown) {
        console.error(`[runner] destroy() failed for prepare ${run_id}:`, destroyErr)
      }
    }
    res
      .writeHead(500, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: `prepare failed: ${errorMessage(err)}` }))
  }
}

async function expirePrepared(token: string): Promise<void> {
  const prepared = preparedTargets.get(token)
  preparedTargets.delete(token)
  if (!prepared || !liveHandles.has(prepared.handle)) return
  const expiredAt = new Date().toISOString()
  try {
    const { ms } = await timed(() => adapter.destroy(prepared.handle))
    console.warn(
      `[runner] prepared target of ${prepared.run_id} expired unused after ${PREPARE_TTL_MS}ms ` +
        `at ${expiredAt}, destroyed in ${ms.toFixed(0)}ms`
    )
  } catch (err: unknown) {
    console.error(`[runner] destroy() failed for expired prepare ${prepared.run_id} at ${expiredAt}:`, err)
  } finally {
    liveHandles.delete(prepared.handle)
  }
}

function takePrepared(token: string | undefined, stage: string, strategy: string): PreparedTarget | null {
  if (!isPushStrategy(strategy)) {
    if (token) throw new Error(`strategy "${strategy}" has no push phase but came with ${HEADER.prepareToken}`)
    return null
  }
  const prepared = token ? preparedTargets.get(token) : undefined
  if (!token || !prepared) {
    throw new Error(`strategy "${strategy}" needs a valid ${HEADER.prepareToken} from /prepare`)
  }
  if (prepared.stage !== stage || prepared.strategy !== strategy) {
    throw new Error(
      `${HEADER.prepareToken} was issued for ${prepared.stage}/${prepared.strategy}, not ${stage}/${strategy}`
    )
  }
  preparedTargets.delete(token)
  clearTimeout(prepared.expiry)
  return prepared
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const t_wall_start = performance.now()
  const headersAt = Date.now()
  runCounter += 1

  const exportMsHeader = headerValue(req.headers, HEADER.exportMs)
  const stage = headerValue(req.headers, HEADER.stage) || 'unknown'
  const strategy = headerValue(req.headers, HEADER.strategy) || ''
  const runIndex = headerValue(req.headers, HEADER.runIndex) || String(runCounter)
  const run_id = [stage, strategy, runIndex].filter(Boolean).join('-')

  const stop_at = headerValue(req.headers, HEADER.stopAt) || ''
  const last_source_tick_at = headerValue(req.headers, HEADER.lastSourceTickAt) || ''
  const stopAtMs = epochMsOf(stop_at)
  const lastSourceTickMs = epochMsOf(last_source_tick_at)
  const clientNowMs = epochMsOf(headerValue(req.headers, HEADER.clientNow))

  const row = makeEmptyRow()
  Object.assign(row, {
    run_id,
    run_at: new Date().toISOString(),
    session_label: headerValue(req.headers, HEADER.sessionLabel) || '',
    target: adapterName,
    stage,
    strategy,
    first_run: headerValue(req.headers, HEADER.firstRun) === 'true',
    first_run_of_cell: headerValue(req.headers, HEADER.firstRunOfCell) === 'true',
    expect_failure: false,
    position_in_cycle: numberOrBlank(headerValue(req.headers, HEADER.positionInCycle)),
    cycle: numberOrBlank(headerValue(req.headers, HEADER.cycle)),
    kill_to_export_ms: numberOrBlank(headerValue(req.headers, HEADER.killToExportMs)),
    heartbeat_resumed: false,
    state_restored: false,
    stop_offset_target_ms: numberOrBlank(headerValue(req.headers, HEADER.stopOffsetTargetMs)),
    stop_offset_actual_ms: numberOrBlank(headerValue(req.headers, HEADER.stopOffsetActualMs)),
    stop_at,
    last_source_tick_at,
    client_clock_skew_ms: numberOrBlank(headerValue(req.headers, HEADER.clientClockSkewMs)),
    client_header_delay_ms: clientNowMs === null ? '' : headersAt - clientNowMs,
  } satisfies Partial<Row>)

  let handle: TargetHandle | null = null
  let tempZipPath: string | null = null
  let baselineLines = 0
  let restoreIssuedAt: number | null = null
  let aliveResult: WaitAliveResult | null = null
  let adapterOverheadMs = 0
  let ingestMs = 0

  const callAdapter = async <T extends object>(innerKey: keyof T, fn: () => Promise<T>) => {
    const { value, ms } = await timed(fn)
    const reported = value[innerKey]
    const inner = typeof reported === 'number' ? reported : ms
    adapterOverheadMs += ms - inner
    return value
  }
  const ingest = async <T>(fn: () => Promise<T>) => {
    const { value, ms } = await timed(fn)
    ingestMs += ms
    return value
  }

  const userAgent = headerValue(req.headers, HEADER.userAgent)
  if (userAgent) {
    recordBrowserUserAgent(ENV_PATH, userAgent).catch((err: unknown) =>
      console.error('[runner] could not update env.json with User-Agent:', err)
    )
  }

  try {
    assertRunnable(stage, strategy)
    if (!exportMsHeader) throw new Error(`Header ${HEADER.exportMs} missing`)
    const export_ms = Number(exportMsHeader)
    if (!Number.isFinite(export_ms)) throw new Error(`${HEADER.exportMs} invalid: ${exportMsHeader}`)
    row.export_ms = export_ms

    const body = await ingest(() => readBody(req))
    row.payload_bytes = body.length

    const uploadPath = path.join(DATA_DIR, `.upload-${run_id}-${process.pid}.zip`)
    tempZipPath = uploadPath
    await ingest(() => writeFile(uploadPath, body))
    const snapshot = await ingest(() =>
      extractJsonFromZip<ProcessSnapshot>(uploadPath, 'work/process-snapshot.json')
    )
    row.counter_expected = typeof snapshot?.counter === 'number' ? snapshot.counter : ''
    row.log_interval_ms = typeof snapshot?.logIntervalMs === 'number' ? snapshot.logIntervalMs : ''
    row.state_loss_ticks =
      typeof snapshot?.stateLossTicks === 'number' ? snapshot.stateLossTicks : ''

    const prepared = takePrepared(headerValue(req.headers, HEADER.prepareToken), stage, strategy)
    let targetHandle: TargetHandle
    if (prepared) {
      targetHandle = prepared.handle
      handle = targetHandle
      Object.assign(row, {
        push_bytes: prepared.push_bytes,
        push_boot_ms: prepared.push_boot_ms,
        push_upload_ms: prepared.push_upload_ms,
        push_unpack_ms: prepared.push_unpack_ms,
        push_install_ms: prepared.push_install_ms,
        push_export_ms: numberOrBlank(headerValue(req.headers, HEADER.pushExportMs)),
        prepare_ms: numberOrBlank(headerValue(req.headers, HEADER.prepareMs)),
        prepare_to_stop_ms: numberOrBlank(headerValue(req.headers, HEADER.prepareToStopMs)),
        push_source_ticks: numberOrBlank(headerValue(req.headers, HEADER.pushSourceTicks)),
        push_expected_ticks: numberOrBlank(headerValue(req.headers, HEADER.pushExpectedTicks)),
      } satisfies Partial<Row>)
    } else {
      const created = await callAdapter('boot_ms', () => createTarget())
      targetHandle = created.handle
      handle = targetHandle
      row.boot_ms = created.boot_ms
    }

    const written = await callAdapter('upload_ms', () => adapter.writePayload(targetHandle, body))
    row.upload_ms = written.upload_ms

    const unpacked = await callAdapter('unpack_ms', () => adapter.unpack(targetHandle))
    row.unpack_ms = unpacked.unpack_ms
    baselineLines = unpacked.heartbeat_baseline_lines

    if (strategy === 'manifest' && needsInstall(stage)) {
      const installed = await callAdapter('install_ms', () => adapter.install(targetHandle))
      row.install_ms = installed.install_ms
    }

    const restored = await callAdapter('restart_ms', () => adapter.restore(targetHandle, snapshot))
    row.restart_ms = restored.restart_ms
    restoreIssuedAt = restored.restore_issued_at
    row.restore_issued_at = new Date(restoreIssuedAt).toISOString()

    try {
      aliveResult = await callAdapter('alive_ms', () =>
        adapter.waitAlive(targetHandle, { baselineLines })
      )
      row.alive_ms = aliveResult.alive_ms
      row.first_tick_at = aliveResult.first_tick_at
      row.first_tick_counter = aliveResult.first_tick_counter
      row.detect_at = new Date(aliveResult.detect_at).toISOString()
      row.restore_mark_ns = aliveResult.restore_mark_ns ? String(aliveResult.restore_mark_ns) : ''
      row.heartbeat_resumed = true
      row.counter_actual = loadedCounter(row.first_tick_counter)
      row.state_restored = stateRestored(row.counter_expected, row.counter_actual)
      if (!row.state_restored) {
        row.error = appendError(
          row.error,
          `counter_expected=${row.counter_expected} counter_actual=${row.counter_actual} ` +
            `(first_tick_counter=${row.first_tick_counter})`
        )
      }
    } catch (err: unknown) {
      row.alive_ms = err instanceof AliveTimeoutError ? err.alive_ms : ''
      throw err
    }

    row.total_wall_ms = performance.now() - t_wall_start
    row.ingest_ms = ingestMs
    row.adapter_overhead_ms = adapterOverheadMs

    if (prepared) {
      try {
        const { stdout } = await execFileAsync('unzip', ['-l', uploadPath])
        const delta = zipListingTotals(stdout)
        row.delta_files = delta.files
        row.delta_bytes = delta.bytes
      } catch (err: unknown) {
        row.error = appendError(row.error, `delta listing: ${errorMessage(err)}`)
      }
    }

    try {
      const sourceState = await extractJsonFromZip<ProcessState>(uploadPath, 'work/state.json')
      row.logging_overhead_ms =
        typeof sourceState?.loggingOverheadMs === 'number' ? sourceState.loggingOverheadMs : ''
    } catch (err: unknown) {
      row.error = appendError(row.error, errorMessage(err))
    }

    const clock = await adapter.clockOffset(targetHandle)
    row.target_clock_offset_ms = clock.offset_ms
    row.target_clock_rtt_ms = clock.rtt_ms
    recordClockInfo(ENV_PATH, {
      offsetMs: clock.offset_ms,
      rttMs: clock.rtt_ms,
      samples: clock.samples,
      clientSkewMs: row.client_clock_skew_ms,
    }).catch((err: unknown) =>
      console.error('[runner] could not update env.json with clock info:', err)
    )

    const interruption = computeInterruption({
      stopAtMs,
      lastSourceTickMs,
      firstTickAt: aliveResult.first_tick_at,
      offsetMs: clock.offset_ms,
      restoreIssuedAt,
      restoreMarkNs: aliveResult.restore_mark_ns,
    })
    row.interruption_ms = interruption.interruption_ms
    row.interruption_gap_ms = interruption.interruption_gap_ms
    row.interruption_split_ms = interruption.interruption_split_ms
    row.restore_dispatch_ms = interruption.restore_dispatch_ms

    const pollRest = pollRestMs({
      firstTickAt: aliveResult.first_tick_at,
      offsetMs: clock.offset_ms,
      detectAt: aliveResult.detect_at,
    })
    const corrected = tickCorrectedDurations({
      aliveMs: row.alive_ms,
      totalWallMs: row.total_wall_ms,
      pollRest,
    })
    row.alive_to_tick_ms = corrected.alive_to_tick_ms
    row.total_wall_to_tick_ms = corrected.total_wall_to_tick_ms

    row.total_sum_ms =
      num(row.export_ms) +
      num(row.ingest_ms) +
      num(row.upload_ms) +
      num(row.boot_ms) +
      num(row.unpack_ms) +
      num(row.install_ms) +
      num(row.restart_ms) +
      num(row.alive_ms) +
      num(row.adapter_overhead_ms)

    recordSanityWarnings(row, { detectAt: aliveResult.detect_at, restoreIssuedAt })

    await verifyResume({ handle: targetHandle, row, baselineLines })

    await finalizeRun({ handle: targetHandle, tempZipPath: uploadPath, row })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(row))
    return
  } catch (err: unknown) {
    if (!row.total_wall_ms) row.total_wall_ms = performance.now() - t_wall_start
    if (!row.ingest_ms) row.ingest_ms = ingestMs
    if (!row.adapter_overhead_ms) row.adapter_overhead_ms = adapterOverheadMs
    row.error = appendError(row.error, errorMessage(err))
    console.error(`[runner] Run ${run_id} failed:`, err)
    await finalizeRun({ handle, tempZipPath, row })
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify(row))
  }
}

function recordSanityWarnings(row: Row, context: TimingContext): string[] {
  const warnings = checkTimingSanity(row, context)
  for (const message of warnings) {
    console.warn(`[runner] Timing sanity check for ${row.run_id}: ${message}`)
  }
  row.sanity_warnings = warnings.join('; ')
  return warnings
}

async function verifyResume({
  handle,
  row,
  baselineLines,
}: {
  handle: TargetHandle
  row: Row
  baselineLines: number
}): Promise<void> {
  const intervalMs =
    typeof row.log_interval_ms === 'number'
      ? row.log_interval_ms
      : RESUME_CHECK_FALLBACK_INTERVAL_MS
  const waitedMs = intervalMs + RESUME_CHECK_MARGIN_MS
  try {
    await sleep(waitedMs)
    const progress = await adapter.readProgress(handle)

    row.resume_tick_counter = progress.last_tick?.counter ?? ''
    row.resume_state_counter =
      typeof progress.state?.counter === 'number' ? progress.state.counter : ''

    const ticksKeptComing =
      typeof row.resume_tick_counter === 'number' &&
      typeof row.first_tick_counter === 'number' &&
      row.resume_tick_counter > row.first_tick_counter &&
      progress.lines > baselineLines + 1
    const stateKeptGrowing =
      typeof row.resume_state_counter === 'number' &&
      typeof row.counter_expected === 'number' &&
      row.resume_state_counter > row.counter_expected

    row.resume_verified = ticksKeptComing && stateKeptGrowing
    if (!row.resume_verified) {
      row.error = appendError(
        row.error,
        resumeCheckMessage({
          row,
          baselineLines,
          progressLines: progress.lines,
          ticksKeptComing,
          stateKeptGrowing,
          waitedMs,
        })
      )
      console.warn(`[runner] Resume check for ${row.run_id} failed: ${row.error}`)
    }
  } catch (err: unknown) {
    row.resume_verified = false
    row.error = appendError(row.error, `resume check: ${errorMessage(err)}`)
    console.warn(
      `[runner] Resume check for ${row.run_id} could not be carried out: ${errorMessage(err)}`
    )
  }
}

async function finalizeRun({
  handle,
  tempZipPath,
  row,
}: {
  handle: TargetHandle | null
  tempZipPath: string | null
  row: Row
}): Promise<void> {
  if (handle) {
    liveHandles.delete(handle)
    try {
      await adapter.destroy(handle)
    } catch (err: unknown) {
      console.error(`[runner] destroy() failed for ${row.run_id}:`, err)
    }
  }
  if (tempZipPath) await rm(tempZipPath, { force: true })
  const hostStallMs = takeHostStallMs()
  row.host_stall_ms = hostStallMs
  if (hostStallMs > 0) {
    console.warn(
      `[runner] ${row.run_id} overlapped ${(hostStallMs / 1000).toFixed(1)}s of suspended host. ` +
        'The run is kept and marked, not discarded.'
    )
  }
  await appendCsvRow(CSV_PATH, row)
}

async function removeStaleUploads(): Promise<void> {
  try {
    const stale = (await readdir(DATA_DIR)).filter((name) => name.startsWith('.upload-'))
    await Promise.all(
      stale.map((name) => rm(path.join(DATA_DIR, name), { recursive: true, force: true }))
    )
    if (stale.length > 0) console.warn(`[runner] removed ${stale.length} leftover upload(s)`)
  } catch (err: unknown) {
    console.warn(`[runner] could not clean up leftover uploads: ${errorMessage(err)}`)
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function extractJsonFromZip<T>(zipPath: string, entryName: string): Promise<T> {
  try {
    const { stdout } = await execFileAsync('unzip', ['-p', zipPath, entryName])
    return JSON.parse(stdout) as T
  } catch (err: unknown) {
    throw new Error(`could not read ${entryName} from archive: ${errorMessage(err)}`)
  }
}

function appendError(existing: string, message: string): string {
  return existing ? `${existing}; ${message}` : message
}

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  server.close()
  const handles = [...liveHandles]
  liveHandles.clear()
  if (handles.length > 0) {
    console.warn(`[runner] ${signal}: destroying ${handles.length} live target handle(s) ...`)
    const results = await Promise.allSettled(
      handles.map((handle) =>
        withTimeout(
          adapter.destroy(handle),
          SHUTDOWN_TIMEOUT_MS,
          `destroy() did not finish within ${SHUTDOWN_TIMEOUT_MS}ms`
        )
      )
    )
    const failed = results.filter((r) => r.status === 'rejected')
    for (const failure of failed) {
      console.error(`[runner] cleanup on ${signal} failed: ${errorMessage(failure.reason)}`)
    }
    if (failed.length > 0) {
      console.error(
        `[runner] ${failed.length} target(s) may still be running - check the E2B dashboard.`
      )
    } else {
      console.warn(`[runner] ${signal}: cleanup done.`)
    }
  }
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
