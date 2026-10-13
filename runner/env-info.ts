import { writeFile } from 'node:fs/promises'
import { hostname, platform, release, arch } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson } from './util.ts'
import type { CsvNumber } from './csv.ts'
import type { TargetMeta, Tooling } from '../targets/interface.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface EnvClockInfo {
  measured_at: string
  target_clock_offset_ms: number
  target_clock_rtt_ms: number
  target_clock_samples: number
  client_clock_skew_ms: number | null
}

export interface EnvInfo {
  started_at: string
  node_version: string
  os: { platform: string; kernel_release: string; arch: string; hostname: string }
  adapter: string
  target_node_version: string | null
  target_node_version_note: string
  node_version_aligned: boolean | null
  node_version_note: string
  target_tooling: Tooling | null
  target_tooling_note: string
  e2b_region: string | null
  e2b_region_note: string | null
  browser: string | null
  browser_note: string
  clock: EnvClockInfo | null
  clock_note: string
  package_versions: {
    root: string | null
    e2b: string | null
    browser_app: string | null
    vite: string | null
    '@webcontainer/api': string | null
  }
}

interface PackageJson {
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

let writeChain: Promise<void> = Promise.resolve()

export function updateEnvInfo(
  envPath: string,
  mutator: (info: EnvInfo) => boolean | void
): Promise<void> {
  writeChain = writeChain.then(async () => {
    const info = await readJson<EnvInfo>(envPath)
    if (!info) return
    if (mutator(info) === false) return
    await writeFile(envPath, JSON.stringify(info, null, 2))
  })
  return writeChain
}

export async function writeEnvInfo(
  envPath: string,
  { adapterName }: { adapterName: string }
): Promise<void> {
  const rootPkg = await readJson<PackageJson>(path.join(__dirname, '..', 'package.json'))
  const browserPkg = await readJson<PackageJson>(
    path.join(__dirname, '..', 'browser', 'package.json')
  )
  const e2bPkg = await readJson<PackageJson>(
    path.join(__dirname, '..', 'node_modules', 'e2b', 'package.json')
  )

  const previous = await readJson<EnvInfo>(envPath)
  if (previous?.clock) {
    console.warn(
      `[runner] ${envPath} is being replaced. The previous file carried a clock block from ` +
        `adapter=${previous.adapter} started_at=${previous.started_at} ` +
        `(offset ${previous.clock.target_clock_offset_ms}ms, rtt ${previous.clock.target_clock_rtt_ms}ms). ` +
        'If that session was not committed, its "Data basis" numbers are gone now.'
    )
  }

  const info: EnvInfo = {
    started_at: new Date().toISOString(),
    node_version: process.version,
    os: { platform: platform(), kernel_release: release(), arch: arch(), hostname: hostname() },
    adapter: adapterName,
    target_node_version: null,
    target_node_version_note: 'populated from the target environment on the first adapter.create()',
    node_version_aligned: null,
    node_version_note:
      'Source and target deliberately run on different Node versions: the E2B default template ' +
      'is fixed to v20.x and cannot be changed without a custom template, the source follows the devcontainer image. ' +
      'node_version_aligned compares process.version with target_node_version by major version, ' +
      'once both are known. See README, section "Limits of the measurement".',
    target_tooling: null,
    target_tooling_note:
      'unzip and node as resolved inside the target on the first adapter.create(). Evidence that ' +
      'the image brought them: installing a missing tool per run would land inside a measured ' +
      'phase.',
    e2b_region: null,
    e2b_region_note:
      adapterName === 'e2b'
        ? 'not determinable: SandboxInfo from the e2b SDK (as of e2b@' +
          (e2bPkg?.version ?? '?') +
          ') contains no region field'
        : null,
    browser: null,
    browser_note: 'populated from X-User-Agent on the first POST /run, if set',
    clock: null,
    clock_note:
      'populated after the first successful run. The interruption time is measured across two ' +
      'clocks: the stop timestamp comes from the browser, the first tick timestamp from the target. ' +
      'offset from the fastest of 5 `date +%s%N` round trips, error smaller or equal rtt/2 + 1 ms (Cristian 1989). ' +
      'client_clock_skew_ms is the browser clock against the runner clock, from the fastest of 3 ' +
      '/clock round trips before the WebContainer boot; both run on the same host, the value ' +
      'documents that instead of assuming it. Per-run values are in results.csv.',
    package_versions: {
      root: rootPkg?.version ?? null,
      e2b: e2bPkg?.version ?? null,
      browser_app: browserPkg?.version ?? null,
      vite: browserPkg?.devDependencies?.vite ?? null,
      '@webcontainer/api': browserPkg?.dependencies?.['@webcontainer/api'] ?? null,
    },
  }
  await writeFile(envPath, JSON.stringify(info, null, 2))
}

export function recordBrowserUserAgent(envPath: string, userAgent: string): Promise<void> {
  return updateEnvInfo(envPath, (info) => {
    if (info.browser) return false
    info.browser = userAgent
    info.browser_note = 'taken from the X-User-Agent header of the first POST /run'
  })
}

export function recordTargetMeta(envPath: string, meta: TargetMeta): Promise<void> {
  return updateEnvInfo(envPath, (info) => {
    if (info.target_node_version || info.target_tooling) return false
    info.target_node_version = meta.targetNodeVersion ?? null
    info.target_node_version_note = meta.targetNodeVersion
      ? 'read from adapter.create() of the target environment'
      : 'not determinable in the target environment'
    info.node_version_aligned = majorVersionsMatch(info.node_version, info.target_node_version)
    info.target_tooling = meta.tooling ?? null
  })
}

export function recordClockInfo(
  envPath: string,
  {
    offsetMs,
    rttMs,
    samples,
    clientSkewMs,
  }: { offsetMs: number; rttMs: number; samples: number; clientSkewMs: CsvNumber }
): Promise<void> {
  return updateEnvInfo(envPath, (info) => {
    if (info.clock) return false
    info.clock = {
      measured_at: new Date().toISOString(),
      target_clock_offset_ms: offsetMs,
      target_clock_rtt_ms: rttMs,
      target_clock_samples: samples,
      client_clock_skew_ms: typeof clientSkewMs === 'number' ? clientSkewMs : null,
    }
  })
}

function majorVersionsMatch(
  sourceVersion: string | null,
  targetVersion: string | null
): boolean | null {
  const sourceMajor = majorOf(sourceVersion)
  const targetMajor = majorOf(targetVersion)
  if (sourceMajor === null || targetMajor === null) return null
  return sourceMajor === targetMajor
}

function majorOf(version: string | null): number | null {
  const match = /^v?(\d+)\./.exec(version || '')
  return match ? Number(match[1]) : null
}
