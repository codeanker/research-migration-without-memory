import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

export const RUNNER_READY = 'Listening on'

const DEFAULT_START_TIMEOUT_MS = 60000

interface RunnerOptions {
  target: string
  port: number
  csvPath?: string
  envPath?: string
  dataDir?: string
}

export function spawnRunner({ target, port, csvPath, envPath, dataDir }: RunnerOptions): ChildProcess {
  return spawn('node', ['runner/server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TARGET: target,
      PORT: String(port),
      ...(csvPath ? { CSV_PATH: csvPath } : {}),
      ...(envPath ? { ENV_PATH: envPath } : {}),
      ...(dataDir ? { DATA_DIR: dataDir } : {}),
    },
  })
}

export function streamsOf(
  child: ChildProcess,
  name: string
): { stdout: Readable; stderr: Readable } {
  if (!child.stdout || !child.stderr) {
    throw new Error(`${name} was started without stdout/stderr pipes`)
  }
  return { stdout: child.stdout, stderr: child.stderr }
}

interface WaitOptions {
  name: string
  timeoutMs?: number
  echo?: { stdout: string; stderr: string }
}

export function waitForStdout(
  child: ChildProcess,
  marker: string | RegExp,
  { name, timeoutMs = DEFAULT_START_TIMEOUT_MS, echo }: WaitOptions
): Promise<string> {
  const { stdout, stderr } = streamsOf(child, name)
  return new Promise((resolve, reject) => {
    let buf = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const detach = () => {
      clearTimeout(timer)
      stdout.off('data', onStdout)
      stderr.off('data', onStderr)
      child.off('exit', onExit)
    }
    const read = (prefix: string | undefined) => (chunk: Buffer | string) => {
      const text = chunk.toString()
      if (prefix) process.stdout.write(`${prefix} ${text}`)
      buf += text
      if (typeof marker === 'string' ? buf.includes(marker) : marker.test(buf)) {
        detach()
        resolve(buf)
      }
    }
    const onStdout = read(echo?.stdout)
    const onStderr = read(echo?.stderr)
    const onExit = (code: number | null) => {
      detach()
      reject(new Error(`${name} exited prematurely (code ${code}): ${buf}`))
    }
    timer = setTimeout(() => {
      detach()
      reject(new Error(`${name} did not start within ${timeoutMs}ms: ${buf}`))
    }, timeoutMs)
    stdout.on('data', onStdout)
    stderr.on('data', onStderr)
    child.once('exit', onExit)
  })
}

export function mirror(stream: Readable, prefix: string): void {
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) console.log(`${prefix} ${line}`)
  })
}
