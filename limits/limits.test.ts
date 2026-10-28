import { expect, test } from 'claude-code/testing'

import { appendArgv, fresh, key, line, logPath, row } from './hooks/line'

const SEVEN = { kind: 'seven_day', percentUsed: 69, resetsAt: '2026-10-31T11:00:00.000Z' }
const FIVE = { kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-28T12:00:00.000Z' }

test('a row is one JSON line with a fixed key order and the reset kept as given', async () => {
  const r = row(SEVEN, '2026-10-28T07:29:00.000Z', 'abc')
  expect(line(r)).toBe(
    '{"ts":"2026-10-28T07:29:00.000Z","session":"abc","kind":"seven_day","pct":69,"resetsAt":"2026-10-31T11:00:00.000Z"}',
  )
  expect(line(row({ kind: 'spend_limit', percentUsed: 101.5 }, 't', 's'))).toBe(
    '{"ts":"t","session":"s","kind":"spend_limit","pct":101.5,"resetsAt":null}',
  )
})

test('fresh drops a reading already logged and keeps a window that moved', async () => {
  const seen = new Set<string>()
  expect(fresh([SEVEN, FIVE], seen)).toEqual([SEVEN, FIVE])
  expect(fresh([SEVEN, FIVE], seen)).toEqual([])
  const moved = { ...SEVEN, percentUsed: 70 }
  expect(fresh([moved, FIVE], seen)).toEqual([moved])
  expect(key(moved)).toBe('seven_day|70|2026-10-31T11:00:00.000Z')
})

test('the appender runs no shell over the text, and the log sits under LORE_HOME when set', async () => {
  const text = '{"a":"$(rm -rf /) `x` \\"q\\""}'
  const argv = appendArgv('/Users/x/.lore/limits.jsonl', text)
  expect(argv[0]).toBe('/bin/sh')
  expect(argv[4]).toBe(text)
  expect(argv[5]).toBe('/Users/x/.lore/limits.jsonl')
  expect(argv[2]).not.toContain(text)
  expect(logPath('/Users/x', undefined)).toBe('/Users/x/.lore/limits.jsonl')
  expect(logPath('/Users/x', '')).toBe('/Users/x/.lore/limits.jsonl')
  expect(logPath('/Users/x', '/tmp/scratch')).toBe('/tmp/scratch/limits.jsonl')
})
