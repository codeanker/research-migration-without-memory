import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import http from 'node:http'
import type { ClientRequest } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RUNNER_READY, spawnRunner, waitForStdout } from '../runner/child.ts'
import { buildFakeExport } from '../runner/fake-export.ts'
import { HEADER } from '../shared/protocol.ts'
import { deltaIncludes } from '../shared/push.ts'
import { sleep } from '../shared/timing.ts'

const START_TIMEOUT_MS = 20000
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
    if (!child.killed) child.kill('SIGKILL')
    await rm(outDir, { recursive: true, force: true })
  }
  try {
    await waitForStdout(child, RUNNER_READY, { name: 'runner', timeoutMs: START_TIMEOUT_MS })
  } catch (err) {
    await stop()
    throw err
  }
  return { child, outDir, stop }
}

test('a second POST /run is refused with 409 while one run is in flight', async () => {
  const port = 8811
  const runner = await startRunner(port)
  let held: ClientRequest | undefined
  try {
    held = http.request(
      {
        port,
        path: '/run',
        method: 'POST',
        headers: { [HEADER.exportMs]: '1', [HEADER.stage]: 'smoke' },
      },
      (res) => res.resume()
    )
    held.on('error', () => {})
    held.write('x')

    await sleep(300)
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

test('SIGTERM in the middle of a run destroys the target that is still alive', async () => {
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
      ...(token ? { [HEADER.prepareToken]: token } : {}),
    },
    body: zip,
  })
}

async function newTargetDirs(before: string[]): Promise<string[]> {
  return (await localTargetDirs()).filter((n) => !before.includes(n))
}

test('SIGTERM after /prepare destroys the prepared target', async () => {
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

test('each prepared target has its own TTL, a used one never expires, an unused one is destroyed', async () => {
  const port = 8815
  const before = await localTargetDirs()
  const runner = await startRunner(port)
  try {
    const preparedAtA = performance.now()
    const tokenA = await prepareToken(port, 1)
    const runA = await runDelta(port, 2, 'precopy', tokenA)
    const rowA = (await runA.json()) as { error?: string }
    assert.equal(runA.status, 200, rowA.error)

    const tokenB = await prepareToken(port, 1)
    const untilDeadlineA = preparedAtA + TTL_MS + 100 - performance.now()
    if (untilDeadlineA > 0) await sleep(untilDeadlineA)
    const runB = await runDelta(port, 2, 'precopy', tokenB)
    const rowB = (await runB.json()) as { error?: string }
    assert.equal(runB.status, 200, rowB.error)
    assert.deepEqual(await newTargetDirs(before), [])

    await prepareToken(port, 1)
    assert.equal((await newTargetDirs(before)).length, 1)
    await sleep(TTL_MS + 500)
    assert.deepEqual(await newTargetDirs(before), [], 'the unused prepared target outlived its TTL')
  } finally {
    await runner.stop()
  }
})

test('a broken /prepare and a /run with a bad or missing token leave no target and no prepare row', async () => {
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

async function localTargetDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('handover-local-'))
}
