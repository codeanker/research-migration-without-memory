import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CSV_COLUMNS, appendCsvRow, ensureCsvHeader, makeEmptyRow, parseCsv } from '../runner/csv.ts'

test('makeEmptyRow has exactly the columns of the file', () => {
  const row = makeEmptyRow()
  assert.deepEqual(Object.keys(row), CSV_COLUMNS)
  assert.ok(Object.values(row).every((v) => v === ''))
})

test('error stays the last column, so a comma in it cannot shift a number', () => {
  assert.equal(CSV_COLUMNS.at(-1), 'error')
})

test('appendCsvRow refuses a key that is not a column', async () => {
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

test('a field with a comma survives write and read', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'csv-test-'))
  try {
    const csvPath = path.join(dir, 'results.csv')
    await ensureCsvHeader(csvPath)
    const row = makeEmptyRow()
    Object.assign(row, {
      run_id: 'small-full-01',
      stage: 'small',
      strategy: 'full',
      total_wall_ms: 1234.5,
      sanity_warnings: 'a warning; another one, with a comma',
      error: 'readState: boom, retry failed',
    })
    await appendCsvRow(csvPath, row)

    const { header, rows } = parseCsv(await readFile(csvPath, 'utf8'))
    assert.deepEqual(header, CSV_COLUMNS)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].stage, 'small')
    assert.equal(rows[0].strategy, 'full')
    assert.equal(rows[0].total_wall_ms, '1234.5')
    assert.equal(rows[0].error, 'readState: boom, retry failed')
    assert.equal(rows[0].sanity_warnings, 'a warning; another one, with a comma')
    assert.equal(Object.hasOwn(rows[0], 'undefined'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the parser handles quotes, escaped quotes, CRLF and a trailing newline', () => {
  const text = 'a,b,c\r\n1,"x, y",""\r\n2,"say ""hi""",z\r\n'
  const { header, rows } = parseCsv(text)
  assert.deepEqual(header, ['a', 'b', 'c'])
  assert.deepEqual(rows, [
    { a: '1', b: 'x, y', c: '' },
    { a: '2', b: 'say "hi"', c: 'z' },
  ])
})

test('a row with the wrong number of fields is an error, not a silent shift', () => {
  assert.throws(() => parseCsv('a,b,c\n1,2\n'), /has 2 fields, the header has 3/)
})

test('an unfinished quoted field is an error', () => {
  assert.throws(() => parseCsv('a\n"open\n'), /inside a quoted field/)
})

test('ensureCsvHeader refuses a file written by another column list', async () => {
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
