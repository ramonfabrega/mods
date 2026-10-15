import { expect, test } from 'claude-code/testing'

import {
  bar,
  gb,
  parseDf,
  parseDu,
  parsePs,
  parseSysctl,
  parseTailscale,
  parseTop,
  parseUptime,
  parseVmStatSwap,
  parseWho,
  rate,
} from './hooks/parse'

// Samples captured on the Studio, 2026-10-15.

test('sysctl: load, cores, memory, swap', async () => {
  const s = parseSysctl(
    '{ 11.87 14.60 12.79 }\n16\n137438953472\ntotal = 10240.00M  used = 8810.31M  free = 1429.69M  (encrypted)\n',
  )
  expect(s.load).toEqual([11.87, 14.6, 12.79])
  expect(s.cpus).toBe(16)
  expect(Math.round(s.memsizeG)).toBe(128)
  expect(s.swap).toEqual({ totalM: 10240, usedM: 8810.31 })
})

test('top header: busy percent and PhysMem', async () => {
  const t = parseTop(
    [
      'Processes: 1258 total, 8 running, 1250 sleeping, 7603 threads',
      '2026/10/15 02:45:51',
      'Load Avg: 11.87, 14.60, 12.79',
      'CPU usage: 46.0% user, 9.90% sys, 44.8% idle',
      'PhysMem: 126G used (8459M wired, 10G compressor), 868M unused.',
    ].join('\n'),
  )
  expect(t.cpuBusy).toBe(55)
  expect(t.usedG).toBe(126)
  expect(t.compressedG).toBe(10)
  expect(Math.round((t.unusedG ?? 0) * 1000)).toBe(848)
})

test('df: the data volume row', async () => {
  const d = parseDf(
    'Filesystem     1024-blocks      Used Available Capacity  iused      ifree %iused  Mounted on\n' +
      '/dev/disk3s5     971350180 717340944 205150656    78% 18761553 2051506560    1%   /System/Volumes/Data\n',
  )
  expect(d).toEqual({ totalK: 971350180, availK: 205150656, pct: 78 })
  expect(gb(205150656)).toBe('196G')
})

test('uptime: days, hours, minutes', async () => {
  expect(parseUptime(' 2:45  up 40 days,  8:32, 4 users, load averages: 11.87 14.60 12.79')).toBe('40d 8h')
  expect(parseUptime('10:01  up 3:21, 2 users, load averages: 1.0 1.0 1.0')).toBe('3h 21m')
  expect(parseUptime('10:01  up 1 day, 2:03, 1 user, load averages: 1.0 1.0 1.0')).toBe('1d 2h')
  expect(parseUptime('10:01  up 5 mins, 1 user, load averages: 1.0 1.0 1.0')).toBe('5m')
})

test('who: only the remote rows', async () => {
  const ssh = parseWho(
    'rf-studio        console      Sep  5 16:18 \n' +
      'rf-studio        ttys000      Oct 14 21:58 (100.64.0.7)\n' +
      'rf-studio        ttys010      Sep 22 20:09 \n',
  )
  expect(ssh).toEqual(['ttys000 ← 100.64.0.7'])
})

test('ps: claude-shaped processes summed by basename', async () => {
  const p = parsePs(
    ' 1024  1.5 /opt/homebrew/bin/claude\n' +
      ' 2048  0.5 /Users/x/.bun/bin/bun\n' +
      '  512 50.0 /usr/bin/node\n' +
      ' 9999  9.9 /Applications/Safari.app/Contents/MacOS/Safari\n',
  )
  expect(p).toEqual({ procs: 3, rssK: 3584, cpu: 52 })
})

test('du: by repo, largest first, codex named', async () => {
  const d = parseDu(
    '29400000\t/Users/x/code/fun/attrition/.claude/worktrees\n' +
      '35300000\t/Users/x/code/work/acme/.claude/worktrees\n' +
      '6200000\t/Users/x/code/fun/ccc/.claude/worktrees\n' +
      '12200000\t/Users/x/.codex/worktrees\n',
  )
  expect(d.dirs.map(x => x.name)).toEqual(['acme', 'attrition', 'codex', 'ccc'])
  expect(d.totalK).toBe(83100000)
})

test('vm_stat: lifetime swap counters; rate formats', async () => {
  expect(parseVmStatSwap('Pages free: 1.\nSwapins:                                 785458.\nSwapouts:                               5633646.\n')).toEqual({
    ins: 785458,
    outs: 5633646,
  })
  expect(parseVmStatSwap('Pages free: 1.\n')).toBe(null)
  expect(rate(0)).toBe('0')
  expect(rate(12 * 1024)).toBe('12K/s')
  expect(rate(2.1 * 1024 ** 2)).toBe('2.1M/s')
})

test('tailscale: state and dns, trailing dot dropped; garbage is null', async () => {
  expect(
    parseTailscale('{"BackendState":"Running","Self":{"DNSName":"studio.example.ts.net."}}'),
  ).toEqual({ state: 'Running', dns: 'studio.example.ts.net' })
  expect(parseTailscale('not json')).toBe(null)
})

test('bar: fills by percent at the width given', async () => {
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(0, 4)).toBe('░░░░')
  expect(bar(130, 4)).toBe('████')
})
