import { WebContainer } from '@webcontainer/api'
import {
  HEARTBEAT_JS,
  buildProcessSnapshot,
  lockfileForStage,
  packageJsonForStage,
  stageNeedsInstall,
} from './payload'
import { HEADER } from '../../shared/protocol.ts'
import { lastHeartbeatTick, type HeartbeatTick } from '../../shared/heartbeat.ts'
import { assertMeasurementStage, assertStrategy } from '../../shared/stages.ts'
import { sleep } from '../../shared/timing.ts'
import {
  deltaIncludes,
  dirtyNodeModules,
  expectedTicks,
  isPushStrategy,
  pushInstalls,
} from '../../shared/push.ts'
import type { CsvRowJson, RunOutcome, RunRequest, RunnerError } from '../../shared/browser-api.ts'

export type { RunOutcome }

export type RunConfig = RunRequest & {
  onLog?: (msg: string) => void
}

const DEFAULT_WARMUP_STATE_WRITES = 3
const STATE_POLL_MS = 100
const FIRST_STATE_WRITE_TIMEOUT_MS = 60_000
const FRESH_STATE_TIMEOUT_MS = 1000

export function isBrowserUsable(): boolean {
  return window.crossOriginIsolated === true
}

export async function runOnce(config: RunConfig): Promise<RunOutcome> {
  const {
    stage,
    strategy = '',
    runIndex,
    sessionLabel = '',
    runnerUrl,
    logIntervalMs,
    stopOffsetMs = null,
    warmupStateWrites = DEFAULT_WARMUP_STATE_WRITES,
    positionInCycle = null,
    cycle = null,
    firstRun = false,
    firstRunOfCell = false,
  } = config
  const log = config.onLog ?? (() => {})

  if (!isBrowserUsable()) {
    throw new Error('crossOriginIsolated is false - WebContainer cannot boot (needs Chromium + COOP/COEP)')
  }
  const payloadStage = assertMeasurementStage(stage)
  const payloadStrategy = assertStrategy(strategy)

  const clientClockSkewMs = await measureClockSkew(runnerUrl, log)

  const lockfile = lockfileForStage(payloadStage)
  const container = await WebContainer.boot()
  try {
    await container.mount({
      work: {
        directory: {
          'package.json': { file: { contents: packageJsonForStage(payloadStage) } },
          ...(lockfile === null ? {} : { 'package-lock.json': { file: { contents: lockfile } } }),
          'heartbeat.js': { file: { contents: HEARTBEAT_JS } },
        },
      },
    })

    if (stageNeedsInstall(payloadStage)) {
      log(`Stage "${stage}" needs dependencies, running npm ci...`)
      const installProc = await container.spawn('npm', ['ci'], { cwd: '/work' })
      const installExit = await installProc.exit
      if (installExit !== 0) throw new Error(`npm ci failed with exit code ${installExit}`)
    }

    const command = `node heartbeat.js ${logIntervalMs}`
    const proc = await container.spawn('node', ['heartbeat.js', String(logIntervalMs)], { cwd: '/work' })

    const warmup = await waitForStateWrites(
      container,
      '/work/state.json',
      warmupStateWrites,
      logIntervalMs * (warmupStateWrites + 2) + 5000
    )
    console.info(
      `[warmup] first state write after ${warmup.startupMs.toFixed(0)}ms, ` +
        `${warmup.writes} writes seen`
    )

    const push = isPushStrategy(payloadStrategy)
      ? await runPushPhase(container, { stage, strategy: payloadStrategy, runIndex, sessionLabel, runnerUrl })
      : null

    if (stopOffsetMs !== null) {
      const stopBase = push ? push.freshUpdatedAt : warmup.lastUpdatedAt
      const waited = await waitForStopOffset(stopBase, logIntervalMs, stopOffsetMs)
      log(`Stop offset ${stopOffsetMs.toFixed(0)}ms into the interval, waited ${waited.toFixed(0)}ms`)
    }

    const stopAt = Date.now()
    const tStop = performance.now()
    proc.kill()
    await proc.exit

    const persisted = await readState(container)
    const lastTick = await readLastHeartbeatTick(container)
    const trueCounter = lastTick?.counter ?? null
    const stateLossTicks =
      typeof trueCounter === 'number' ? trueCounter - persisted.counter : null
    const stopOffsetActualMs = persisted.updatedAt
      ? stopAt - Date.parse(persisted.updatedAt)
      : null

    await container.fs.writeFile(
      '/work/process-snapshot.json',
      buildProcessSnapshot({ counter: persisted.counter, command, logIntervalMs, stateLossTicks })
    )

    const kill_to_export_ms = performance.now() - tStop
    const t0 = performance.now()
    let zip: Uint8Array
    if (push) {
      const dirty = [...push.dirty]
      const dirtyModules = dirtyNodeModules(dirty)
      console.info(`[push] guard: ${dirtyModules.length} node_modules paths in the dirty set`)
      if (dirtyModules.length > 0) {
        throw new Error(
          `node_modules changed during the push phase, the prepared target would mix states: ` +
            dirtyModules.sort().join(', ')
        )
      }
      const includes = deltaIncludes(dirty)
      console.info(`[push] dirty set at the stop: ${dirty.sort().join(', ') || '-'}`)
      zip = await container.export('work', { format: 'zip', includes })
    } else {
      zip = await container.export('work', {
        format: 'zip',
        excludes: payloadStrategy === 'manifest' ? ['node_modules/**'] : [],
      })
    }
    const export_ms = performance.now() - t0
    log(
      `Export done: ${export_ms.toFixed(1)}ms, ${zip.byteLength} bytes, ` +
        `kill to export: ${kill_to_export_ms.toFixed(1)}ms, ` +
        `counter at export: ${persisted.counter} (true: ${trueCounter}, ` +
        `state_loss_ticks: ${stateLossTicks}, stop offset actual: ` +
        `${stopOffsetActualMs === null ? '-' : stopOffsetActualMs.toFixed(0) + 'ms'})`
    )

    const response = await fetch(runnerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        [HEADER.exportMs]: String(export_ms),
        [HEADER.stage]: stage,
        [HEADER.strategy]: payloadStrategy,
        [HEADER.runIndex]: String(runIndex),
        [HEADER.sessionLabel]: sessionLabel,
        [HEADER.userAgent]: navigator.userAgent,
        [HEADER.stopAt]: new Date(stopAt).toISOString(),
        [HEADER.lastSourceTickAt]: lastTick?.at ?? '',
        [HEADER.killToExportMs]: String(kill_to_export_ms),
        [HEADER.stopOffsetTargetMs]: stopOffsetMs === null ? '' : String(stopOffsetMs),
        [HEADER.stopOffsetActualMs]: stopOffsetActualMs === null ? '' : String(stopOffsetActualMs),
        [HEADER.firstRun]: String(firstRun),
        [HEADER.firstRunOfCell]: String(firstRunOfCell),
        [HEADER.positionInCycle]: positionInCycle === null ? '' : String(positionInCycle),
        [HEADER.cycle]: cycle === null ? '' : String(cycle),
        [HEADER.clientClockSkewMs]:
          clientClockSkewMs === null ? '' : clientClockSkewMs.toFixed(2),
        ...(push
          ? {
              [HEADER.prepareToken]: push.token,
              [HEADER.pushExportMs]: String(push.pushExportMs),
              [HEADER.prepareMs]: String(push.prepareMs),
              [HEADER.prepareToStopMs]: String(stopAt - push.preparedAt),
              [HEADER.pushSourceTicks]: push.sourceTicks === null ? '' : String(push.sourceTicks),
              [HEADER.pushExpectedTicks]: push.sourceTicks === null ? '' : String(push.expectedTicks),
            }
          : {}),
        [HEADER.clientNow]: new Date().toISOString(),
      },
      body: zip as BodyInit,
    })
    const row = (await response.json()) as CsvRowJson
    if (!response.ok) {
      const reported = typeof row.error === 'string' && row.error ? row.error : response.statusText
      const err: RunnerError = new Error(`Runner reported an error: ${reported}`)
      err.row = row
      throw err
    }
    return { row, stop_offset_target_ms: stopOffsetMs, stop_offset_actual_ms: stopOffsetActualMs }
  } finally {
    container.teardown()
  }
}

interface PushPhaseRequest {
  stage: string
  strategy: string
  runIndex: number | string
  sessionLabel: string
  runnerUrl: string
}

interface PushPhase {
  token: string
  dirty: Set<string>
  pushExportMs: number
  prepareMs: number
  preparedAt: number
  freshUpdatedAt: string
  sourceTicks: number | null
  expectedTicks: number
}

async function runPushPhase(container: WebContainer, request: PushPhaseRequest): Promise<PushPhase> {
  const prepareStart = performance.now()
  const tickBefore = await readLastHeartbeatTick(container)
  const dirty = new Set<string>()
  container.fs.watch('/work', { recursive: true }, (_event, filename) => {
    dirty.add(typeof filename === 'string' ? filename : new TextDecoder().decode(filename))
  })
  console.info('[push] watch started on /work')
  const t0 = performance.now()
  const zip = await container.export('work', {
    format: 'zip',
    excludes: pushInstalls(request.strategy) ? ['node_modules/**'] : [],
  })
  const pushExportMs = performance.now() - t0
  console.info(`[push] push export done: ${pushExportMs.toFixed(1)}ms, ${zip.byteLength} bytes`)

  const prepareUrl = new URL('/prepare', new URL(request.runnerUrl, location.href)).toString()
  const response = await fetch(prepareUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      [HEADER.stage]: request.stage,
      [HEADER.strategy]: request.strategy,
      [HEADER.runIndex]: String(request.runIndex),
      [HEADER.sessionLabel]: request.sessionLabel,
    },
    body: zip as BodyInit,
  })
  const body = (await response.json()) as { token?: string; error?: string }
  const prepareMs = performance.now() - prepareStart
  const preparedAt = Date.now()
  if (!response.ok || !body.token) {
    throw new Error(`Runner reported an error on /prepare: ${body.error ?? response.statusText}`)
  }
  const tickAfter = await readLastHeartbeatTick(container)
  const expected = expectedTicks(performance.now() - prepareStart)
  const sourceTicks = tickBefore && tickAfter ? tickAfter.counter - tickBefore.counter : null
  console.info(
    `[push] prepared in ${prepareMs.toFixed(0)}ms, source ticks ${sourceTicks ?? '-'} of ` +
      `${expected} expected`
  )

  const freshUpdatedAt = await readFreshStateUpdatedAt(container)
  return {
    token: body.token,
    dirty,
    pushExportMs,
    prepareMs,
    preparedAt,
    freshUpdatedAt,
    sourceTicks,
    expectedTicks: expected,
  }
}

async function readFreshStateUpdatedAt(container: WebContainer): Promise<string> {
  const deadline = performance.now() + FRESH_STATE_TIMEOUT_MS
  for (;;) {
    const updatedAt = await readStateUpdatedAt(container, '/work/state.json')
    if (updatedAt) return updatedAt
    if (performance.now() >= deadline) {
      throw new Error(`state.json gave no updatedAt within ${FRESH_STATE_TIMEOUT_MS}ms after /prepare`)
    }
    await sleep(STATE_POLL_MS)
  }
}

const CLOCK_SKEW_SAMPLES = 3

async function measureClockSkew(
  runnerUrl: string,
  log: (msg: string) => void
): Promise<number | null> {
  let best: { skewMs: number; rttMs: number } | null = null
  const clockUrl = new URL('/clock', new URL(runnerUrl, location.href)).toString()
  for (let i = 0; i < CLOCK_SKEW_SAMPLES; i++) {
    try {
      const t1 = Date.now()
      const response = await fetch(clockUrl, { cache: 'no-store' })
      const t2 = Date.now()
      if (!response.ok) return null
      const { now } = (await response.json()) as { now: number }
      const rttMs = t2 - t1
      const skewMs = t1 + rttMs / 2 - now
      if (!best || rttMs < best.rttMs) best = { skewMs, rttMs }
    } catch {
      return null
    }
  }
  if (!best) return null
  log(`Clock skew against the runner: ${best.skewMs.toFixed(1)}ms (rtt ${best.rttMs}ms)`)
  return best.skewMs
}

interface WarmupResult {
  writes: number
  lastUpdatedAt: string
  startupMs: number
}

async function waitForStateWrites(
  container: WebContainer,
  path: string,
  minWrites: number,
  cadenceTimeoutMs: number,
  firstWriteTimeoutMs = FIRST_STATE_WRITE_TIMEOUT_MS
): Promise<WarmupResult> {
  const seenTimestamps = new Set<string>()
  let lastUpdatedAt = ''
  const t0 = performance.now()
  let startupMs = 0
  let deadline = t0 + firstWriteTimeoutMs
  while (performance.now() < deadline) {
    const updatedAt = await readStateUpdatedAt(container, path)
    if (updatedAt && !seenTimestamps.has(updatedAt)) {
      if (seenTimestamps.size === 0) {
        startupMs = performance.now() - t0
        deadline = performance.now() + cadenceTimeoutMs
      }
      seenTimestamps.add(updatedAt)
      lastUpdatedAt = updatedAt
    }
    if (seenTimestamps.size >= minWrites) {
      return { writes: seenTimestamps.size, lastUpdatedAt, startupMs }
    }
    await sleep(STATE_POLL_MS)
  }
  if (seenTimestamps.size === 0) {
    throw new Error(
      `${path} was never written within ${firstWriteTimeoutMs}ms - the heartbeat process did ` +
        'not start'
    )
  }
  throw new Error(
    `${path} reached only ${seenTimestamps.size} of ${minWrites} writes within ` +
      `${cadenceTimeoutMs}ms after the first write (last write ${lastUpdatedAt}) - the ` +
      'heartbeat process stopped writing'
  )
}

async function waitForStopOffset(
  lastUpdatedAt: string,
  logIntervalMs: number,
  stopOffsetMs: number
): Promise<number> {
  const lastWriteMs = Date.parse(lastUpdatedAt)
  if (!Number.isFinite(lastWriteMs)) {
    throw new Error(`state.json has no usable updatedAt ("${lastUpdatedAt}"), stop offset impossible`)
  }
  let deadline = lastWriteMs + logIntervalMs + stopOffsetMs
  const t0 = Date.now()
  while (deadline <= t0) deadline += logIntervalMs
  await sleep(deadline - t0)
  return Date.now() - t0
}

async function readStateUpdatedAt(container: WebContainer, path: string): Promise<string | null> {
  try {
    const raw = await container.fs.readFile(path, 'utf-8')
    return (JSON.parse(raw) as { updatedAt?: string }).updatedAt ?? null
  } catch {
    return null
  }
}

interface StateFile {
  counter: number
  updatedAt?: string
}

async function readState(container: WebContainer): Promise<StateFile> {
  const raw = await container.fs.readFile('/work/state.json', 'utf-8')
  return JSON.parse(raw) as StateFile
}

async function readLastHeartbeatTick(container: WebContainer): Promise<HeartbeatTick | null> {
  const raw = await container.fs.readFile('/work/heartbeat.log', 'utf-8')
  return lastHeartbeatTick(raw)
}
