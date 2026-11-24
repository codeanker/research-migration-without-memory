import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ShellTargetAdapter } from './shell-adapter.ts'
import type { ExecOptions, ExecResult, ShellHandle } from './shell-adapter.ts'
import type { ClockOffsetResult, CreateResult } from './interface.ts'
import { timed } from '../shared/timing.ts'

const execFileAsync = promisify(execFile)
const MAX_STDOUT_BYTES = 8 * 1024 * 1024

interface LocalHandle extends ShellHandle {
  children: ChildProcess[]
}

interface ExecFileFailure {
  code?: number | string
  stdout?: string
  stderr?: string
}

export class LocalAdapter extends ShellTargetAdapter<LocalHandle> {
  override async createTarget(): Promise<CreateResult<LocalHandle>> {
    const { value: home, ms: boot_ms } = await timed(() =>
      mkdtemp(path.join(tmpdir(), 'handover-local-'))
    )
    return {
      handle: { home, children: [] },
      boot_ms,
      meta: { targetNodeVersion: process.version },
    }
  }

  override async exec(
    handle: LocalHandle,
    script: string,
    { background = false }: ExecOptions = {}
  ): Promise<ExecResult> {
    if (background) {
      const child = spawn('bash', ['-c', script], { stdio: 'ignore' })
      handle.children.push(child)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', script], {
        maxBuffer: MAX_STDOUT_BYTES,
      })
      return { exitCode: 0, stdout, stderr }
    } catch (err) {
      const failure = err as ExecFileFailure
      if (typeof failure.code === 'number') {
        return { exitCode: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
      }
      throw err
    }
  }

  override async writeFileToTarget(
    _handle: LocalHandle,
    targetPath: string,
    bytes: Buffer
  ): Promise<void> {
    await writeFile(targetPath, bytes)
  }

  override async clockOffset(): Promise<ClockOffsetResult> {
    return { offset_ms: 0, rtt_ms: 0, samples: 0 }
  }

  override async destroy(handle: LocalHandle): Promise<void> {
    for (const child of handle.children) {
      if (!child.killed) child.kill()
    }
    await rm(handle.home, { recursive: true, force: true })
  }
}
