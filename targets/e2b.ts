import { Sandbox } from 'e2b'
import { ShellTargetAdapter } from './shell-adapter.ts'
import type { ExecOptions, ExecResult, ShellHandle } from './shell-adapter.ts'
import type { CreateOptions, CreateResult } from './interface.ts'
import { timed } from '../shared/timing.ts'

const DEFAULT_HOME = '/home/user'

export interface E2BHandle extends ShellHandle {
  sandbox: Sandbox
}

interface SandboxProbe {
  home: string
  targetNodeVersion: string | null
}

export class E2BAdapter extends ShellTargetAdapter<E2BHandle> {
  static override NAME = 'e2b'
  probe: SandboxProbe | null = null

  override async createTarget(opts?: CreateOptions): Promise<CreateResult<E2BHandle>> {
    const apiKey = process.env.E2B_API_KEY
    if (!apiKey) {
      throw new Error('E2B_API_KEY is not set (only from environment variable, see README)')
    }
    const { value: sandbox, ms: boot_ms } = await timed(() =>
      Sandbox.create(opts?.lifetimeMs ? { apiKey, timeoutMs: opts.lifetimeMs } : { apiKey })
    )
    this.probe ??= await probeSandbox(sandbox)
    const { home, targetNodeVersion } = this.probe
    return { handle: { sandbox, home }, boot_ms, meta: { targetNodeVersion } }
  }

  override async exec(
    handle: E2BHandle,
    script: string,
    { background = false, timeoutMs }: ExecOptions = {}
  ): Promise<ExecResult> {
    if (background) {
      await handle.sandbox.commands.run(script, { background: true })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const res = await handle.sandbox.commands.run(script, { timeoutMs })
    return { exitCode: res.exitCode, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }

  override async writeFileToTarget(
    handle: E2BHandle,
    targetPath: string,
    bytes: Buffer
  ): Promise<void> {
    await handle.sandbox.files.write(targetPath, new Blob([bytes]))
  }

  override async destroy(handle: E2BHandle): Promise<void> {
    await handle.sandbox.kill()
  }
}

async function probeSandbox(sandbox: Sandbox): Promise<SandboxProbe> {
  let targetNodeVersion: string | null = null
  try {
    const res = await sandbox.commands.run('node --version')
    if (res.exitCode === 0) targetNodeVersion = res.stdout.trim()
  } catch {}

  let home = DEFAULT_HOME
  try {
    const res = await sandbox.commands.run('pwd')
    if (res.exitCode === 0 && res.stdout.trim()) home = res.stdout.trim()
  } catch {}
  return { home, targetNodeVersion }
}
