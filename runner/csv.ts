import { appendFile, readFile } from 'node:fs/promises'

export type Blank = ''
export type CsvNumber = number | Blank
export type CsvFlag = boolean | Blank
export type CsvTime = string

export interface Row {
  run_id: string
  run_at: CsvTime
  session_label: string
  target: string
  stage: string
  strategy: string
  first_run: CsvFlag
  first_run_of_cell: CsvFlag
  expect_failure: CsvFlag
  position_in_cycle: CsvNumber
  cycle: CsvNumber
  log_interval_ms: CsvNumber
  payload_bytes: CsvNumber

  kill_to_export_ms: CsvNumber
  export_ms: CsvNumber
  ingest_ms: CsvNumber
  upload_ms: CsvNumber
  boot_ms: CsvNumber
  unpack_ms: CsvNumber
  install_ms: CsvNumber
  readstate_ms: CsvNumber
  restart_ms: CsvNumber
  alive_ms: CsvNumber
  alive_to_tick_ms: CsvNumber
  adapter_overhead_ms: CsvNumber
  total_sum_ms: CsvNumber
  total_wall_ms: CsvNumber
  total_wall_to_tick_ms: CsvNumber

  interruption_ms: CsvNumber
  interruption_gap_ms: CsvNumber
  interruption_split_ms: CsvNumber

  heartbeat_resumed: CsvFlag
  state_restored: CsvFlag
  counter_expected: CsvNumber
  counter_actual: CsvNumber
  first_tick_counter: CsvNumber

  resume_verified: CsvFlag
  resume_tick_counter: CsvNumber
  resume_state_counter: CsvNumber
  state_loss_ticks: CsvNumber

  stop_offset_target_ms: CsvNumber
  stop_offset_actual_ms: CsvNumber
  logging_overhead_ms: CsvNumber

  stop_at: CsvTime
  last_source_tick_at: CsvTime
  first_tick_at: CsvTime
  detect_at: CsvTime
  restore_issued_at: CsvTime
  restore_mark_ns: string
  restore_dispatch_ms: CsvNumber
  target_clock_offset_ms: CsvNumber
  target_clock_rtt_ms: CsvNumber
  client_clock_skew_ms: CsvNumber
  client_header_delay_ms: CsvNumber
  host_stall_ms: CsvNumber
  sanity_warnings: string
  error: string
}

export const CSV_COLUMNS = [
  'run_id',
  'run_at',
  'session_label',
  'target',
  'stage',
  'strategy',
  'first_run',
  'first_run_of_cell',
  'expect_failure',
  'position_in_cycle',
  'cycle',
  'log_interval_ms',
  'payload_bytes',
  'kill_to_export_ms',
  'export_ms',
  'ingest_ms',
  'upload_ms',
  'boot_ms',
  'unpack_ms',
  'install_ms',
  'readstate_ms',
  'restart_ms',
  'alive_ms',
  'alive_to_tick_ms',
  'adapter_overhead_ms',
  'total_sum_ms',
  'total_wall_ms',
  'total_wall_to_tick_ms',
  'interruption_ms',
  'interruption_gap_ms',
  'interruption_split_ms',
  'heartbeat_resumed',
  'state_restored',
  'counter_expected',
  'counter_actual',
  'first_tick_counter',
  'resume_verified',
  'resume_tick_counter',
  'resume_state_counter',
  'state_loss_ticks',
  'stop_offset_target_ms',
  'stop_offset_actual_ms',
  'logging_overhead_ms',
  'stop_at',
  'last_source_tick_at',
  'first_tick_at',
  'detect_at',
  'restore_issued_at',
  'restore_mark_ns',
  'restore_dispatch_ms',
  'target_clock_offset_ms',
  'target_clock_rtt_ms',
  'client_clock_skew_ms',
  'client_header_delay_ms',
  'host_stall_ms',
  'sanity_warnings',
  'error',
] as const

export type CsvColumn = (typeof CSV_COLUMNS)[number]

type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

export type RowCoversEveryCsvColumn = Assert<IsExactly<keyof Row, CsvColumn>>

const COLUMN_SET: ReadonlySet<string> = new Set(CSV_COLUMNS)

export function makeEmptyRow(): Row {
  return Object.fromEntries(CSV_COLUMNS.map((col) => [col, ''])) as unknown as Row
}

export async function ensureCsvHeader(csvPath: string): Promise<void> {
  const expected = CSV_COLUMNS.join(',')

  let existing: string
  try {
    existing = await readFile(csvPath, 'utf8')
  } catch {
    await appendFile(csvPath, expected + '\n')
    return
  }

  const header = existing.split('\n', 1)[0].trim()
  if (header === expected) return
  if (header === '') {
    await appendFile(csvPath, expected + '\n')
    return
  }

  const found = header.split(',')
  throw new Error(
    `Header of ${csvPath} does not match CSV_COLUMNS ` +
      `(${found.length} columns in the file, ${CSV_COLUMNS.length} expected). ` +
      `New rows would end up under the wrong column names. ` +
      `Rename or move the file, then the next run will recreate it with the correct header.\n` +
      `  File:     ${header}\n` +
      `  Expected: ${expected}`
  )
}

export async function appendCsvRow(csvPath: string, row: Row): Promise<void> {
  const unknown = Object.keys(row).filter((key) => !COLUMN_SET.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `row has ${unknown.length} field(s) that are not CSV columns: ${unknown.join(', ')}. ` +
        'Add them to CSV_COLUMNS or drop them from the row.'
    )
  }
  const line = CSV_COLUMNS.map((col) => csvField(row[col])).join(',')
  await appendFile(csvPath, line + '\n')
}

function csvField(value: unknown): string {
  if (value === undefined || value === null) return ''
  const str = typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value)
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

export interface ParsedCsv {
  header: string[]
  rows: Record<string, string>[]
}

export function parseCsv(text: string): ParsedCsv {
  const records = parseRecords(text)
  if (records.length === 0) return { header: [], rows: [] }
  const [header, ...dataRecords] = records
  const rows = dataRecords.map((fields, index) => {
    if (fields.length !== header.length) {
      throw new Error(
        `CSV row ${index + 2} has ${fields.length} fields, the header has ${header.length}. ` +
          'The file was written by two different column lists.'
      )
    }
    return Object.fromEntries(header.map((name, i) => [name, fields[i]]))
  })
  return { header, rows }
}

function parseRecords(text: string): string[][] {
  const records: string[][] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  let hasContent = false

  const endField = () => {
    fields.push(field)
    field = ''
  }
  const endRecord = () => {
    endField()
    records.push(fields)
    fields = []
    hasContent = false
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      hasContent = true
    } else if (char === ',') {
      hasContent = true
      endField()
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      if (hasContent || field !== '' || fields.length > 0) endRecord()
    } else {
      hasContent = true
      field += char
    }
  }
  if (quoted) throw new Error('CSV ends inside a quoted field')
  if (hasContent || field !== '' || fields.length > 0) endRecord()
  return records
}
