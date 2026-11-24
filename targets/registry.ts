import type { ShellTargetAdapter } from './shell-adapter.ts'

type AdapterClass = new () => ShellTargetAdapter

export type AdapterName = 'e2b' | 'local'

const ADAPTERS: Record<AdapterName, () => Promise<AdapterClass>> = {
  e2b: async () => (await import('./e2b.ts')).E2BAdapter,
  local: async () => (await import('./local.ts')).LocalAdapter,
}

export const ADAPTER_NAMES = Object.keys(ADAPTERS) as AdapterName[]

export function isKnownAdapter(name: string): name is AdapterName {
  return Object.hasOwn(ADAPTERS, name)
}

export async function loadAdapter(name: string): Promise<ShellTargetAdapter> {
  if (!isKnownAdapter(name)) {
    throw new Error(`Unknown TARGET: ${name} (expected: ${ADAPTER_NAMES.join(' | ')})`)
  }
  const AdapterClass = await ADAPTERS[name]()
  return new AdapterClass()
}
