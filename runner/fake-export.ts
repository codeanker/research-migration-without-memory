import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HEARTBEAT_JS, buildProcessSnapshot, packageJsonForStage } from '../browser/src/payload.ts'
import { HEARTBEAT_TICK_MS, formatHeartbeatLine } from '../shared/heartbeat.ts'

const execFileAsync = promisify(execFile)

const LOGGING_OVERHEAD_MS = 0.42

export interface FakeExportOptions {
  lastSourceTickAt: number
  logIntervalMs: number
  priorCounter?: number
  files?: string[]
}

export async function buildFakeExport({
  lastSourceTickAt,
  logIntervalMs,
  priorCounter = 1,
  files,
}: FakeExportOptions): Promise<Buffer> {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), 'fake-export-'))
  try {
    const workDir = path.join(stagingRoot, 'work')
    await mkdir(workDir, { recursive: true })

    const heartbeatLines = Array.from({ length: priorCounter }, (_, i) => {
      const at = new Date(lastSourceTickAt - (priorCounter - 1 - i) * HEARTBEAT_TICK_MS)
      return formatHeartbeatLine(at.toISOString(), i + 1, 1) + '\n'
    }).join('')
    await writeFile(path.join(workDir, 'heartbeat.log'), heartbeatLines)
    await writeFile(
      path.join(workDir, 'state.json'),
      JSON.stringify({
        counter: priorCounter,
        pid: 1,
        updatedAt: new Date(0).toISOString(),
        loggingOverheadMs: LOGGING_OVERHEAD_MS,
      })
    )
    await writeFile(path.join(workDir, 'package.json'), packageJsonForStage('small'))
    await writeFile(path.join(workDir, 'heartbeat.js'), HEARTBEAT_JS)
    await writeFile(
      path.join(workDir, 'process-snapshot.json'),
      buildProcessSnapshot({
        counter: priorCounter,
        command: `node heartbeat.js ${logIntervalMs}`,
        logIntervalMs,
        stateLossTicks: 0,
      })
    )

    const zipPath = path.join(stagingRoot, 'payload.zip')
    const entries = files ? files.map((file) => path.join('work', file)) : ['work']
    await execFileAsync('zip', ['-rqMM', zipPath, ...entries], { cwd: stagingRoot })
    return readFile(zipPath)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}
