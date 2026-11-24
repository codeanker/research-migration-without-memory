import { appendFile, readFile } from 'node:fs/promises'

type Blank = ''
export type CsvNumber = number | Blank
type CsvFlag = boolean | Blank

const NUMBER = '' as CsvNumber
const FLAG = '' as CsvFlag
const TEXT = '' as string

const EMPTY_ROW = {
  run_id: TEXT,
  run_at: TEXT,
  session_label: TEXT,
  target: TEXT,
  stage: TEXT,
  strategy: TEXT,
  first_run: FLAG,
  first_run_of_cell: FLAG,
  expect_failure: FLAG,
  position_in_cycle: NUMBER,
  cycle: NUMBER,
  log_interval_ms: NUMBER,
  payload_bytes: NUMBER,

  kill_to_export_ms: NUMBER,
  export_ms: NUMBER,
  ingest_ms: NUMBER,
  upload_ms: NUMBER,
  boot_ms: NUMBER,
  unpack_ms: NUMBER,
  install_ms: NUMBER,
  readstate_ms: NUMBER,
  restart_ms: NUMBER,
  alive_ms: NUMBER,
  alive_to_tick_ms: NUMBER,
  adapter_overhead_ms: NUMBER,
  total_sum_ms: NUMBER,
  total_wall_ms: NUMBER,
  total_wall_to_tick_ms: NUMBER,

  interruption_ms: NUMBER,
  interruption_gap_ms: NUMBER,
  interruption_split_ms: NUMBER,

  heartbeat_resumed: FLAG,
  state_restored: FLAG,
  counter_expected: NUMBER,
  counter_actual: NUMBER,
  first_tick_counter: NUMBER,

  resume_verified: FLAG,
  resume_tick_counter: NUMBER,
  resume_state_counter: NUMBER,
  state_loss_ticks: NUMBER,

  stop_offset_target_ms: NUMBER,
  stop_offset_actual_ms: NUMBER,
  logging_overhead_ms: NUMBER,

  stop_at: TEXT,
  last_source_tick_at: TEXT,
  first_tick_at: TEXT,
  detect_at: TEXT,
  restore_issued_at: TEXT,
  restore_mark_ns: TEXT,
  restore_dispatch_ms: NUMBER,
  target_clock_offset_ms: NUMBER,
  target_clock_rtt_ms: NUMBER,
  client_clock_skew_ms: NUMBER,
  client_header_delay_ms: NUMBER,
  host_stall_ms: NUMBER,
  push_export_ms: NUMBER,
  push_bytes: NUMBER,
  push_upload_ms: NUMBER,
  push_boot_ms: NUMBER,
  push_unpack_ms: NUMBER,
  push_install_ms: NUMBER,
  prepare_ms: NUMBER,
  prepare_to_stop_ms: NUMBER,
  delta_bytes: NUMBER,
  delta_files: NUMBER,
  push_source_ticks: NUMBER,
  push_expected_ticks: NUMBER,
  sanity_warnings: TEXT,
  error: TEXT,
}

export type Row = typeof EMPTY_ROW

export const CSV_COLUMNS = Object.keys(EMPTY_ROW) as readonly (keyof Row)[]

const COLUMN_SET: ReadonlySet<string> = new Set(CSV_COLUMNS)

export function makeEmptyRow(): Row {
  return { ...EMPTY_ROW }
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
      `(${found.length} columns in the file, ${CSV_COLUMNS.length} expected).\n` +
      `  File:     ${header}\n` +
      `  Expected: ${expected}`
  )
}

export async function appendCsvRow(csvPath: string, row: Row): Promise<void> {
  const unknown = Object.keys(row).filter((key) => !COLUMN_SET.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `row has ${unknown.length} field(s) that are not CSV columns: ${unknown.join(', ')}`
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

interface ParsedCsv {
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
        `CSV row ${index + 2} has ${fields.length} fields, the header has ${header.length}`
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
