import type { TargetAdapter } from './interface.ts'

type AdapterClass = new () => TargetAdapter

interface AdapterEntry {
  description: string
  load: () => Promise<AdapterClass>
}

export const ADAPTERS = {
  e2b: {
    description: 'E2B Firecracker microVM, the measurement target',
    load: async () => (await import('./e2b.ts')).E2BAdapter,
  },
  local: {
    description: 'temp directory on this machine, control path only, not part of the design',
    load: async () => (await import('./local.ts')).LocalAdapter,
  },
} satisfies Record<string, AdapterEntry>

export type AdapterName = keyof typeof ADAPTERS

export const ADAPTER_NAMES = Object.keys(ADAPTERS) as AdapterName[]

export function isKnownAdapter(name: string): name is AdapterName {
  return Object.hasOwn(ADAPTERS, name)
}

export async function loadAdapter(name: string): Promise<TargetAdapter> {
  if (!isKnownAdapter(name)) {
    throw new Error(`Unknown TARGET: ${name} (expected: ${ADAPTER_NAMES.join(' | ')})`)
  }
  const AdapterClass = await ADAPTERS[name].load()
  return new AdapterClass()
}
