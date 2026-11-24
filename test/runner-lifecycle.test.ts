import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import http from 'node:http'
import type { ClientRequest } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RUNNER_READY, spawnRunner, waitForStdout } from '../runner/child.ts'
import { parseCsv } from '../runner/csv.ts'
import { buildFakeExport } from '../runner/fake-export.ts'
import { HEADER } from '../shared/protocol.ts'
import { deltaIncludes } from '../shared/push.ts'
import { sleep, withTimeout } from '../shared/timing.ts'

const START_TIMEOUT_MS = 20000
const STOP_TIMEOUT_MS = 25000
const TTL_MS = 1000
const LOG_INTERVAL_MS = 1000

interface RunningRunner {
  child: ChildProcess
  outDir: string
  stop: () => Promise<void>
}

async function startRunner(port: number, ttlMs = TTL_MS): Promise<RunningRunner> {
  const outDir = await mkdtemp(path.join(tmpdir(), 'runner-test-'))
  process.env.PREPARE_TTL_MS = String(ttlMs)
  const child = spawnRunner({
    target: 'local',
    port,
    csvPath: path.join(outDir, 'results.csv'),
    envPath: path.join(outDir, 'env.json'),
    dataDir: outDir,
  })
  delete process.env.PREPARE_TTL_MS
  const stop = async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill('SIGTERM')
        await withTimeout(exited, STOP_TIMEOUT_MS, 'runner did not exit after SIGTERM').catch((err: unknown) => {
          child.kill('SIGKILL')
          throw err
        })
      }
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }
  try {
    await waitForStdout(child, RUNNER_READY, { name: 'runner', timeoutMs: START_TIMEOUT_MS })
  } catch (err) {
    await stop()
    throw err
  }
  return { child, outDir, stop }
}

test('concurrent /run gets 409', async () => {
  const port = 8811
  const runner = await startRunner(port)
  let held: ClientRequest | undefined
  try {
    const first = http.request(
      {
        port,
        path: '/run',
        method: 'POST',
        headers: { [HEADER.exportMs]: '1', [HEADER.stage]: 'smoke', Expect: '100-continue' },
      },
      (res) => res.resume()
    )
    held = first
    first.on('error', () => {})
    const continued = new Promise((resolve) => first.once('continue', resolve))
    first.flushHeaders()
    await continued

    const second = await fetch(`http://localhost:${port}/run`, {
      method: 'POST',
      headers: { [HEADER.exportMs]: '1', [HEADER.stage]: 'smoke' },
      body: 'x',
    })
    assert.equal(second.status, 409)
    const body = (await second.json()) as { error?: string }
    assert.match(body.error ?? '', /already in progress/)
  } finally {
    held?.destroy()
    await runner.stop()
  }
})

test('SIGTERM during run', async () => {
  const port = 8812
  const logIntervalMs = 4000
  const before = await localTargetDirs()
  const runner = await startRunner(port)
  const stopAt = Date.now()
  const zipBytes = await buildFakeExport({ lastSourceTickAt: stopAt - 30, logIntervalMs })
  try {
    const request = fetch(`http://localhost:${port}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        [HEADER.exportMs]: '1',
        [HEADER.stage]: 'smoke',
        [HEADER.runIndex]: '1',
        [HEADER.stopAt]: new Date(stopAt).toISOString(),
        [HEADER.lastSourceTickAt]: new Date(stopAt - 30).toISOString(),
        [HEADER.killToExportMs]: '1',
        [HEADER.clientNow]: new Date().toISOString(),
      },
      body: zipBytes,
    }).catch(() => null)

    await sleep(1500)
    const during = (await localTargetDirs()).filter((n) => !before.includes(n))
    assert.equal(during.length, 1, `expected one live target, saw ${during.length}`)

    runner.child.kill('SIGTERM')
    await new Promise((resolve) => runner.child.once('exit', resolve))
    await request

    const after = (await localTargetDirs()).filter((n) => !before.includes(n))
    assert.deepEqual(after, [], 'the target of the interrupted run was left behind')
  } finally {
    await runner.stop()
  }
})

async function prepare(port: number, strategy: string, body: Uint8Array): Promise<Response> {
  return fetch(`http://localhost:${port}/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      [HEADER.stage]: 'smoke',
      [HEADER.strategy]: strategy,
      [HEADER.runIndex]: '1',
    },
    body,
  })
}

async function prepareToken(port: number, priorCounter: number): Promise<string> {
  const zip = await buildFakeExport({
    priorCounter,
    logIntervalMs: LOG_INTERVAL_MS,
    lastSourceTickAt: Date.now(),
  })
  const response = await prepare(port, 'precopy', zip)
  const body = (await response.json()) as { token?: string; error?: string }
  assert.equal(response.status, 200, body.error)
  assert.ok(body.token)
  return body.token
}

async function runDelta(
  port: number,
  priorCounter: number,
  strategy: string,
  token?: string
): Promise<Response> {
  const stopAt = Date.now()
  const zip = await buildFakeExport({
    priorCounter,
    logIntervalMs: LOG_INTERVAL_MS,
    lastSourceTickAt: stopAt - 30,
    files: deltaIncludes(['heartbeat.log']),
  })
  return fetch(`http://localhost:${port}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      [HEADER.exportMs]: '1',
      [HEADER.stage]: 'smoke',
      [HEADER.strategy]: strategy,
      [HEADER.runIndex]: '1',
      [HEADER.stopAt]: new Date(stopAt).toISOString(),
      [HEADER.lastSourceTickAt]: new Date(stopAt - 30).toISOString(),
      [HEADER.killToExportMs]: '1',
      [HEADER.clientNow]: new Date().toISOString(),
      [HEADER.pushExportMs]: '10',
      [HEADER.prepareMs]: '200',
      [HEADER.prepareToStopMs]: '30',
      [HEADER.pushSourceTicks]: '7',
      [HEADER.pushExpectedTicks]: '8',
      ...(token ? { [HEADER.prepareToken]: token } : {}),
    },
    body: zip,
  })
}

async function newTargetDirs(before: string[]): Promise<string[]> {
  return (await localTargetDirs()).filter((n) => !before.includes(n))
}

test('SIGTERM after /prepare', async () => {
  const port = 8814
  const before = await localTargetDirs()
  const runner = await startRunner(port, 60000)
  try {
    await prepareToken(port, 1)
    assert.equal((await newTargetDirs(before)).length, 1)

    runner.child.kill('SIGTERM')
    await new Promise((resolve) => runner.child.once('exit', resolve))

    assert.deepEqual(await newTargetDirs(before), [], 'the prepared target was left behind')
  } finally {
    await runner.stop()
  }
})

test('prepare TTL', async () => {
  const port = 8815
  const before = await localTargetDirs()
  const runner = await startRunner(port)
  try {
    const tokenA = await prepareToken(port, 1)
    const runA = await runDelta(port, 2, 'precopy', tokenA)
    const rowA = (await runA.json()) as Record<string, unknown>
    assert.equal(runA.status, 200, String(rowA.error))
    assert.equal(rowA.error, '')
    assert.equal(rowA.resume_verified, true)
    assert.equal(rowA.delta_files, 3)
    assert.ok(Number(rowA.push_bytes) > Number(rowA.payload_bytes), `push_bytes ${rowA.push_bytes}`)
    assert.equal(rowA.push_export_ms, 10)
    assert.equal(rowA.prepare_ms, 200)
    assert.equal(rowA.prepare_to_stop_ms, 30)
    assert.equal(rowA.push_source_ticks, 7)
    assert.equal(rowA.push_expected_ticks, 8)
    assert.equal(rowA.boot_ms, '')
    const reused = await runDelta(port, 2, 'precopy', tokenA)
    assert.equal(reused.status, 500)
    assert.match(((await reused.json()) as { error: string }).error, /needs a valid/)

    await prepareToken(port, 1)
    const deadlineB = performance.now() + TTL_MS
    const dirsB = await newTargetDirs(before)
    assert.equal(dirsB.length, 1)
    await sleep(600)
    const tokenC = await prepareToken(port, 1)
    assert.equal((await newTargetDirs(before)).length, 2)
    await sleep(deadlineB + 200 - performance.now())
    const left = await newTargetDirs(before)
    assert.equal(left.length, 1, 'the unused prepared target outlived its TTL')
    assert.ok(!left.includes(dirsB[0]), 'the expiry destroyed the wrong target')
    const runC = await runDelta(port, 2, 'precopy', tokenC)
    const rowC = (await runC.json()) as { error?: string }
    assert.equal(runC.status, 200, rowC.error)
    assert.deepEqual(await newTargetDirs(before), [])
  } finally {
    await runner.stop()
  }
})

test('bad prepare and token', async () => {
  const port = 8816
  const before = await localTargetDirs()
  const runner = await startRunner(port)
  try {
    const csvPath = path.join(runner.outDir, 'results.csv')
    const header = await readFile(csvPath, 'utf8')

    const broken = await prepare(port, 'precopy', new TextEncoder().encode('not a zip'))
    assert.equal(broken.status, 500)
    assert.equal(await readFile(csvPath, 'utf8'), header)
    assert.deepEqual(await newTargetDirs(before), [])

    const unknown = await runDelta(port, 2, 'precopy', 'no-such-token')
    assert.equal(unknown.status, 500)
    assert.match(((await unknown.json()) as { error: string }).error, /needs a valid/)
    assert.deepEqual(await newTargetDirs(before), [])

    const missing = await runDelta(port, 2, 'precopy')
    assert.equal(missing.status, 500)
    assert.match(((await missing.json()) as { error: string }).error, /needs a valid/)
    assert.deepEqual(await newTargetDirs(before), [])

    const token = await prepareToken(port, 1)
    const withFull = await runDelta(port, 2, 'full', token)
    assert.equal(withFull.status, 500)
    assert.match(((await withFull.json()) as { error: string }).error, /has no push phase/)
    const mismatch = await runDelta(port, 2, 'manifest-push', token)
    assert.equal(mismatch.status, 500)
    assert.match(((await mismatch.json()) as { error: string }).error, /was issued for smoke\/precopy/)
    assert.equal((await newTargetDirs(before)).length, 1, 'a refused /run destroyed the prepared target')
    await sleep(TTL_MS + 500)
    assert.deepEqual(await newTargetDirs(before), [])
  } finally {
    await runner.stop()
  }
})

test('run row', async () => {
  const port = 8817
  const runner = await startRunner(port)
  try {
    const stopAt = Date.now()
    const zip = await buildFakeExport({ priorCounter: 5, logIntervalMs: LOG_INTERVAL_MS, lastSourceTickAt: stopAt - 30 })
    const response = await fetch(`http://localhost:${port}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        [HEADER.exportMs]: '50',
        [HEADER.stage]: 'smoke',
        [HEADER.strategy]: 'full',
        [HEADER.runIndex]: '1',
        [HEADER.stopAt]: new Date(stopAt).toISOString(),
        [HEADER.lastSourceTickAt]: new Date(stopAt - 30).toISOString(),
        [HEADER.killToExportMs]: '1',
        [HEADER.clientNow]: new Date().toISOString(),
      },
      body: zip,
    })
    const row = (await response.json()) as Record<string, unknown>
    assert.equal(response.status, 200, String(row.error))
    assert.equal(row.error, '')
    assert.equal(row.sanity_warnings, '')
    assert.equal(row.counter_expected, 5)
    assert.equal(row.counter_actual, 5)
    assert.equal(row.log_interval_ms, LOG_INTERVAL_MS)
    assert.equal(row.state_loss_ticks, 0)
    assert.equal(row.state_restored, true)
    assert.equal(row.resume_verified, true)
    assert.equal(row.host_stall_ms, 0)
    assert.ok(Number(row.ingest_ms) > 0, `ingest_ms ${row.ingest_ms}`)
    assert.ok(
      Number(row.adapter_overhead_ms) > 0 && Number(row.adapter_overhead_ms) < Number(row.total_wall_ms),
      `adapter_overhead_ms ${row.adapter_overhead_ms}`
    )
    assert.equal(row.payload_bytes, zip.length)

    const n = (column: string) => Number(row[column])
    const at = (column: string) => Date.parse(String(row[column]))
    assert.equal(n('interruption_ms'), at('first_tick_at') - stopAt)
    assert.equal(n('interruption_gap_ms'), n('interruption_ms') + 30)
    assert.equal(
      n('restore_dispatch_ms'),
      Number(BigInt(String(row.restore_mark_ns)) / 1000000n) - at('restore_issued_at')
    )
    const pollRest = at('detect_at') - at('first_tick_at')
    assert.ok(Math.abs(n('alive_to_tick_ms') - (n('alive_ms') - pollRest)) <= 1, `alive_to_tick_ms ${row.alive_to_tick_ms}`)
    assert.ok(
      Math.abs(n('total_wall_to_tick_ms') - (n('total_wall_ms') - pollRest)) <= 1,
      `total_wall_to_tick_ms ${row.total_wall_to_tick_ms}`
    )
    assert.ok(
      Math.abs(n('total_sum_ms') - n('export_ms') - n('total_wall_ms')) <= 2,
      `total_sum_ms ${row.total_sum_ms}, total_wall_ms ${row.total_wall_ms}`
    )

    const { rows } = parseCsv(await readFile(path.join(runner.outDir, 'results.csv'), 'utf8'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].run_id, row.run_id)
    assert.equal(rows[0].counter_expected, '5')
    assert.equal(rows[0].interruption_ms, String(row.interruption_ms))
  } finally {
    await runner.stop()
  }
})

async function localTargetDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('handover-local-'))
}
