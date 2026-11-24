import { readFile, writeFile } from 'node:fs/promises'
import type { CsvNumber } from './csv.ts'

export function fmt(value: CsvNumber | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(1) : fmtValue(value)
}

export function fmtValue(value: CsvNumber | null | undefined): string {
  return value === '' || value === null || value === undefined ? '-' : String(value)
}

export function num(value: CsvNumber | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function grew(later: CsvNumber, earlier: CsvNumber): boolean {
  return typeof later === 'number' && typeof earlier === 'number' && later > earlier
}

export function numberOrBlank(value: string | undefined): CsvNumber {
  const parsed = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : ''
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function median(values: readonly number[] | null | undefined): number | null {
  if (!values || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return Number(value.toFixed(1))
}

export async function readJson<T = unknown>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2))
}

export function epochMsOf(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function pluck(object: unknown, dottedPath: string): unknown {
  return dottedPath
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc === null || acc === undefined ? acc : (acc as Record<string, unknown>)[key],
      object
    )
}
