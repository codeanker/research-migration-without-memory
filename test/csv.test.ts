import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from '../runner/child.ts'
import { CSV_COLUMNS, appendCsvRow, ensureCsvHeader, makeEmptyRow, parseCsv } from '../runner/csv.ts'

test('columns match the data', async () => {
  const headerOf = async (csv: string) => parseCsv(await readFile(path.join(REPO_ROOT, csv), 'utf8')).header
  assert.deepEqual(await headerOf('data/live/results.csv'), CSV_COLUMNS)
  assert.deepEqual(await headerOf('data/results.csv'), [
    ...CSV_COLUMNS.slice(0, CSV_COLUMNS.indexOf('host_stall_ms') + 1),
    'sanity_warnings',
    'error',
  ])
})

test('makeEmptyRow blank', () => {
  const row = makeEmptyRow()
  assert.deepEqual(Object.keys(row), CSV_COLUMNS)
  assert.ok(Object.values(row).every((v) => v === ''))
  row.error = 'changed'
  assert.equal(makeEmptyRow().error, '')
})

test('appendCsvRow unknown key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'csv-test-'))
  try {
    const csvPath = path.join(dir, 'results.csv')
    await ensureCsvHeader(csvPath)
    const row = makeEmptyRow()
    ;(row as unknown as Record<string, unknown>).total_wall_ms_typo = 123
    await assert.rejects(() => appendCsvRow(csvPath, row), /not CSV columns: total_wall_ms_typo/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('comma roundtrip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'csv-test-'))
  try {
    const csvPath = path.join(dir, 'results.csv')
    await ensureCsvHeader(csvPath)
    const row = makeEmptyRow()
    Object.assign(row, {
      run_id: 'small-full-01',
      stage: 'small',
      strategy: 'full',
      total_wall_ms: 1234.567,
      sanity_warnings: 'a warning; another one, with a comma and "quotes"',
      error: 'readState: boom\nretry failed',
    })
    await appendCsvRow(csvPath, row)

    const { header, rows } = parseCsv(await readFile(csvPath, 'utf8'))
    assert.deepEqual(header, CSV_COLUMNS)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].stage, 'small')
    assert.equal(rows[0].strategy, 'full')
    assert.equal(rows[0].total_wall_ms, '1234.57')
    assert.equal(rows[0].error, 'readState: boom\nretry failed')
    assert.equal(rows[0].sanity_warnings, 'a warning; another one, with a comma and "quotes"')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parser quotes and line ends', () => {
  const text = 'a,b,c\r\n1,"x, y",""\r\n2,"say ""hi""",z\r\n'
  const { header, rows } = parseCsv(text)
  assert.deepEqual(header, ['a', 'b', 'c'])
  assert.deepEqual(rows, [
    { a: '1', b: 'x, y', c: '' },
    { a: '2', b: 'say "hi"', c: 'z' },
  ])
})

test('field count mismatch', () => {
  assert.throws(() => parseCsv('a,b,c\n1,2\n'), /has 2 fields, the header has 3/)
})

test('unfinished quote', () => {
  assert.throws(() => parseCsv('a\n"open\n'), /inside a quoted field/)
})

test('ensureCsvHeader mismatch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'csv-test-'))
  try {
    const csvPath = path.join(dir, 'results.csv')
    const { appendFile } = await import('node:fs/promises')
    await appendFile(csvPath, 'run_id,stage\n')
    await assert.rejects(() => ensureCsvHeader(csvPath), /does not match CSV_COLUMNS/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
