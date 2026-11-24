import { HEARTBEAT_TICK_MS } from './heartbeat.ts'

const ALWAYS_IN_DELTA = ['state.json', 'process-snapshot.json']

export function isPushStrategy(strategy: string): boolean {
  return strategy === 'precopy' || strategy === 'manifest-push'
}

export function pushInstalls(strategy: string): boolean {
  return strategy === 'manifest-push'
}

export function deltaIncludes(dirty: Iterable<string>): string[] {
  return [...new Set([...dirty, ...ALWAYS_IN_DELTA])]
}

export function dirtyNodeModules(dirty: Iterable<string>): string[] {
  return [...dirty].filter((file) => file === 'node_modules' || file.startsWith('node_modules/'))
}

export function expectedTicks(windowMs: number): number {
  return Math.floor(windowMs / HEARTBEAT_TICK_MS)
}

interface ZipListingTotals {
  files: number
  bytes: number
}

export function zipListingTotals(listing: string): ZipListingTotals {
  const lines = listing.split('\n')
  const start = lines.findIndex((line) => /^-{4,}/.test(line.trim()))
  const end = lines.findIndex((line, i) => i > start && /^-{4,}/.test(line.trim()))
  if (start === -1 || end === -1) throw new Error(`unexpected unzip -l output: ${listing}`)
  let files = 0
  let bytes = 0
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line)
    if (!match || match[2].endsWith('/')) continue
    files += 1
    bytes += Number(match[1])
  }
  return { files, bytes }
}
