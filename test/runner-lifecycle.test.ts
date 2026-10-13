import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import http from 'node:http'
import type { ClientRequest } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RUNNER_READY, spawnRunner, waitForStdout } from '../runner/child.ts'
import { buildFakeExport } from '../runner/fake-export.ts'
import { HEADER } from '../shared/protocol.ts'
import { sleep } from '../shared/timing.ts'

const START_TIMEOUT_MS = 20000

interface RunningRunner {
  child: ChildProcess
  outDir: string
  stop: () => Promise<void>
}

async function startRunner(port: number): Promise<RunningRunner> {
  const outDir = await mkdtemp(path.join(tmpdir(), 'runner-test-'))
  const child = spawnRunner({
    target: 'local',
    port,
    csvPath: path.join(outDir, 'results.csv'),
    envPath: path.join(outDir, 'env.json'),
    dataDir: outDir,
  })
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

async function localTargetDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('handover-local-'))
}
