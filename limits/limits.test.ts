import { expect, test } from 'claude-code/testing'

import { appendArgv, fresh, key, line, logPath, row } from './hooks/line'
import {
  MOVED_MS,
  TICK_MS,
  due,
  minute,
  nowPath,
  parseUsage,
  readings,
  replaceArgv,
  scopedKind,
  snapshotText,
} from './hooks/usage'

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

// The endpoint's answer, cut to the fields read. Figures invented.
const BODY = JSON.stringify({
  five_hour: null,
  seven_day: { utilization: 85.0, resets_at: '2026-11-14T10:59:59.730224+00:00' },
  limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 85, resets_at: '2026-11-14T10:59:59.730224+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 94,
      resets_at: '2026-11-14T10:59:59.730386+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 3,
      resets_at: null,
      scope: { model: null, surface: { display_name: 'Cowork' } },
    },
  ],
  weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 47, allowance_percent_of_weekly: 50 }],
})

test('the usage body gives the week and each model-scoped week, resets to the minute', async () => {
  const u = parseUsage(BODY)
  expect(u).toEqual({
    weekly: { pct: 85, resetsAt: '2026-11-14T11:00:00.000Z' },
    scoped: [
      {
        name: 'Fable',
        kind: 'seven_day_fable',
        pct: 94,
        resetsAt: '2026-11-14T11:00:00.000Z',
        usedOfWeekly: 47,
        allowanceOfWeekly: 50,
      },
    ],
  })
  expect(readings(u!)).toEqual([{ kind: 'seven_day_fable', percentUsed: 94, resetsAt: '2026-11-14T11:00:00.000Z' }])
  expect(scopedKind('Fable 5.2')).toBe('seven_day_fable_5_2')
  expect(minute('2026-11-14T10:59:59.579848+00:00')).toBe('2026-11-14T11:00:00.000Z')
  expect(minute('soon')).toBe(null)
})

test('a body that is not the usage shape parses to null, and a week with no rows falls back to seven_day', async () => {
  expect(parseUsage('<html>')).toBe(null)
  expect(parseUsage('{"error":{"type":"authentication_error"}}')).toBe(null)
  expect(parseUsage('{"limits":[],"seven_day":{"utilization":12,"resets_at":null}}')).toEqual({
    weekly: { pct: 12, resetsAt: null },
    scoped: [],
  })
})

test('the snapshot is one line with a fixed key order, replaced whole with no shell over the text', async () => {
  const u = parseUsage(BODY)!
  const text = snapshotText({ ts: '2026-11-11T17:00:00.000Z', session: 'abc', ...u })
  expect(text).toBe(
    '{"ts":"2026-11-11T17:00:00.000Z","session":"abc","weekly":{"pct":85,"resetsAt":"2026-11-14T11:00:00.000Z"},"scoped":[{"name":"Fable","kind":"seven_day_fable","pct":94,"resetsAt":"2026-11-14T11:00:00.000Z","usedOfWeekly":47,"allowanceOfWeekly":50}]}',
  )
  const argv = replaceArgv('/Users/x/.lore/limits-now.json', text)
  expect(argv[4]).toBe(text)
  expect(argv[5]).toBe('/Users/x/.lore/limits-now.json')
  expect(argv[2]).not.toContain(text)
  expect(nowPath('/Users/x', undefined)).toBe('/Users/x/.lore/limits-now.json')
  expect(nowPath('/Users/x', '/tmp/scratch')).toBe('/tmp/scratch/limits-now.json')
})

test('the endpoint is asked once the shared snapshot is old: a minute after a move, ten on a tick', async () => {
  const at = Date.parse('2026-11-11T17:00:00.000Z')
  const snap = '{"ts":"2026-11-11T17:00:00.000Z"}'
  expect(due(undefined, at, false)).toBe(true)
  expect(due('not json', at, false)).toBe(true)
  expect(due('{"ts":"never"}', at, false)).toBe(true)
  expect(due(snap, at + MOVED_MS - 1, true)).toBe(false)
  expect(due(snap, at + MOVED_MS, true)).toBe(true)
  expect(due(snap, at + MOVED_MS, false)).toBe(false)
  expect(due(snap, at + TICK_MS, false)).toBe(true)
  expect(due(snap, at - 5_000, false)).toBe(true)
})
