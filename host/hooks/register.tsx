import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { HostSnap, Proc, TreeSnap } from '../types'
import {
  bar,
  g1,
  gb,
  parseDf,
  parseDu,
  parseProcs,
  parsePs,
  parseSysctl,
  parseTailscale,
  parseTop,
  parseUptime,
  parseVmStatSwap,
  parseWho,
  rate,
} from './parse'

const PAGE = 16_384

const FAST_MS = 5_000
const SLOW_MS = 300_000
const STORE_ON = 'host.on'
const STORE_PANE = 'host.pane'
const PANE = 'host'
const TOP_N = 8
const TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

const isOn = atom({ plugin: 'host', key: 'isOn' } as const, false)
const isPane = atom({ plugin: 'host', key: 'isPane' } as const, false)
const snap = atom({ plugin: 'host', key: 'snap' } as const, null)
const trees = atom({ plugin: 'host', key: 'trees' } as const, null)

// Module-owned: a reload starts them over, and session.start restarts them.
let timers: Timer[] = []
// The previous sample's swap counters, for the rate; null until one is taken.
let prevSwap: { at: number; pages: number } | null = null

async function run($: EngineInterface, argv: readonly string[], timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout } = await $.process.run(argv, { timeoutMs })
    return stdout
  } catch {
    return null
  }
}

async function sampleFast($: EngineInterface): Promise<void> {
  const [sys, top, vm, df, up, who, ps, host, ts] = await Promise.all([
    run($, ['sysctl', '-n', 'vm.loadavg', 'hw.ncpu', 'hw.memsize', 'vm.swapusage']),
    run($, ['top', '-l', '1', '-n', '0', '-s', '0']),
    run($, ['vm_stat']),
    run($, ['df', '-k', '/System/Volumes/Data']),
    run($, ['uptime']),
    run($, ['who']),
    run($, ['ps', '-axo', 'rss=,pcpu=,comm=']),
    run($, ['hostname', '-s']),
    run($, [TAILSCALE, 'status', '--json']),
  ])
  const at = await $.clock.now()
  const s = parseSysctl(sys ?? '')
  const t = parseTop(top ?? '')

  // Swap traffic: pages in + out since the previous sample, as bytes per second.
  const counters = parseVmStatSwap(vm ?? '')
  let ioBytesPerS: number | null = null
  if (counters) {
    const pages = counters.ins + counters.outs
    if (prevSwap && at > prevSwap.at) {
      ioBytesPerS = ((pages - prevSwap.pages) * PAGE) / ((at - prevSwap.at) / 1000)
    }
    prevSwap = { at, pages }
  }

  const next: HostSnap = {
    at,
    host: (host ?? '').trim() || 'host',
    up: parseUptime(up ?? ''),
    load: s.load,
    cpus: s.cpus,
    cpuBusy: t.cpuBusy,
    mem: { totalG: s.memsizeG, usedG: t.usedG, compressedG: t.compressedG, unusedG: t.unusedG },
    swap: s.swap ? { ...s.swap, ioBytesPerS } : null,
    disk: parseDf(df ?? ''),
    claude: parsePs(ps ?? ''),
    top: parseProcs(ps ?? '', TOP_N),
    ssh: parseWho(who ?? ''),
    tailscale: ts ? parseTailscale(ts) : null,
  }
  await update($, snap, () => next)
}

async function sampleSlow($: EngineInterface): Promise<void> {
  const home = await $.env.get('HOME')
  if (!home) return
  const found = await run($, [
    'find', `${home}/code`, '-mindepth', '4', '-maxdepth', '4', '-type', 'd',
    '-name', 'worktrees', '-path', '*/.claude/worktrees',
  ])
  const dirs = (found ?? '').trim().split('\n').filter(Boolean)
  const codex = `${home}/.codex/worktrees`
  if ((await run($, ['test', '-d', codex])) !== null) dirs.push(codex)
  const at = await $.clock.now()
  if (dirs.length === 0) {
    await update($, trees, () => ({ at, totalK: 0, count: 0, dirs: [] }))
    return
  }
  const [du, inner] = await Promise.all([
    run($, ['du', '-sk', ...dirs], 120_000),
    run($, ['find', ...dirs, '-mindepth', '1', '-maxdepth', '1', '-type', 'd']),
  ])
  const count = (inner ?? '').trim().split('\n').filter(Boolean).length
  const next: TreeSnap = { at, count, ...parseDu(du ?? '') }
  await update($, trees, () => next)
}

function stop(): void {
  for (const t of timers) t.cancel()
  timers = []
}

function start($: EngineInterface): void {
  stop()
  void sampleFast($)
  void sampleSlow($)
  timers = [
    $.clock.every(FAST_MS, () => void sampleFast($)),
    $.clock.every(SLOW_MS, () => void sampleSlow($)),
  ]
}

// The sampler runs while anything shows it: the band, the pane, or both.
async function sync($: EngineInterface): Promise<void> {
  const wanted = (await read($, isOn)) || (await read($, isPane))
  if (wanted && timers.length === 0) start($)
  else if (!wanted) stop()
}

async function turnBand($: EngineInterface, enabled: boolean): Promise<void> {
  await update($, isOn, () => enabled)
  await $.store.set(STORE_ON, enabled)
  await sync($)
}

async function turnPane($: EngineInterface, enabled: boolean): Promise<void> {
  await update($, isPane, () => enabled)
  await $.store.set(STORE_PANE, enabled)
  await sync($)
  if (enabled) await $.ui.open({ id: PANE, title: 'host' })
  else await $.ui.close({ id: PANE })
}

const hot = (pct: number | null, warn: number, bad: number) =>
  pct === null ? undefined : pct >= bad ? 'red' : pct >= warn ? 'yellow' : undefined

/** The thresholds the band and the pane share: one color per figure. */
function colors(s: HostSnap) {
  const memPct = s.mem.usedG !== null && s.mem.totalG > 0 ? (s.mem.usedG / s.mem.totalG) * 100 : null
  // Swap FILL is a high-water mark that only a reboot clears; TRAFFIC is the pressure now.
  const swapIo = s.swap?.ioBytesPerS ?? null
  const swapIoK = swapIo === null ? null : swapIo / 1024
  return {
    memPct,
    swapIo,
    cpu: hot(s.cpuBusy, 75, 90),
    mem: hot(memPct, 90, 97),
    // yellow past 1 MB/s of swap traffic, red past 10: the box is paging now
    swap: hot(swapIoK, 1024, 10_240),
    disk: hot(s.disk?.pct ?? null, 85, 93),
    ts: s.tailscale && s.tailscale.state !== 'Running' ? 'yellow' : undefined,
  }
}

type Seg = { key: string; label: string; value: string; color?: string; dim?: boolean; prio: number }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'host',
      description: 'Toggle the host band: cpu, load, memory, swap, disk, worktrees, claude processes. `pane` toggles the expanded view, `off` closes both.',
      argumentHint: '[pane|off]',
    })
    if ((await $.store.get(STORE_ON)) === true) await turnBand($, true)
    if ((await $.store.get(STORE_PANE)) === true) await turnPane($, true)
    return next(e)
  })

  on('command.run', { command: 'host' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    const bandOn = (await read($, isOn)) === true
    const paneOn = (await read($, isPane)) === true
    switch (arg) {
      case '':
        await turnBand($, !bandOn)
        return { text: bandOn ? 'host band off.' : 'host band on.' }
      case 'pane':
        await turnPane($, !paneOn)
        return { text: paneOn ? 'host pane closed.' : 'host pane open.' }
      case 'off':
        if (bandOn) await turnBand($, false)
        if (paneOn) await turnPane($, false)
        return { text: 'host off.' }
      default:
        return { text: '/host toggles the band, /host pane the expanded view, /host off closes both.' }
    }
  })

  // The person's close mark or Esc: forget the pane so it stays closed next session.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      try {
        await update($, isPane, () => false)
        await $.store.set(STORE_PANE, false)
        await sync($)
      } catch {
        // The close goes through regardless; the pane reopens next session at worst.
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const enabled = await read($, isOn)
    if (!enabled || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, snap)
    const t = await read($, trees)
    const paneOn = (await read($, isPane)) === true
    // ⤢ opens the pane, ⤡ closes it: a click, or ctrl+x tab then h.
    const expand = (
      <Button
        key="pane"
        plain
        hotkey="h"
        label={paneOn ? '⤡' : '⤢'}
        onPress={() => void turnPane($, !paneOn)}
      />
    )
    if (!s) {
      return (
        <Box>
          <Text dimColor>host: sampling…  </Text>
          {expand}
        </Box>
      )
    }

    const c = colors(s)
    const swapValue = s.swap
      ? `${(s.swap.usedM / 1024).toFixed(1)}G${c.swapIo !== null && c.swapIo > 0 ? ` ${rate(c.swapIo)}` : ''}`
      : 'none'

    // Higher prio survives a narrow band. Display order is the array's.
    const segs: Seg[] = [
      { key: 'host', label: '', value: s.host, prio: 2 },
      { key: 'up', label: 'up', value: s.up, prio: 1 },
      { key: 'cpu', label: 'cpu', value: `${s.cpuBusy ?? '?'}%`, color: c.cpu, prio: 7 },
      { key: 'load', label: 'load', value: s.load[0].toFixed(1), dim: true, prio: 4 },
      { key: 'mem', label: 'mem', value: `${g1(s.mem.usedG)}/${g1(s.mem.totalG)}`, color: c.mem, prio: 8 },
      { key: 'swap', label: 'swap', value: swapValue, color: c.swap, prio: 9 },
      { key: 'disk', label: 'disk', value: s.disk ? `${gb(s.disk.availK)} free` : '?', color: c.disk, prio: 10 },
      { key: 'trees', label: 'trees', value: t ? `${gb(t.totalK)}·${t.count}` : '…', prio: 6 },
      { key: 'claude', label: 'claude', value: `${s.claude.procs}p ${gb(s.claude.rssK)}`, prio: 5 },
      { key: 'ssh', label: 'ssh', value: String(s.ssh.length), prio: 0 },
      {
        key: 'ts',
        label: 'ts',
        value: s.tailscale ? (s.tailscale.state === 'Running' ? 'ok' : s.tailscale.state) : '—',
        color: c.ts,
        prio: 3,
      },
    ]

    const SEP = '  '
    // The button draws as `h: ⤢`: four cells, plus its separator.
    const BUTTON = 4 + SEP.length
    const width = (x: Seg) => (x.label ? x.label.length + 1 : 0) + x.value.length
    const cols = (e.props.bodyColumns || 80) - BUTTON
    let shown = [...segs]
    const total = () => shown.reduce((n, x) => n + width(x), 0) + SEP.length * (shown.length - 1)
    while (shown.length > 1 && total() > cols) {
      const least = shown.reduce((a, b) => (b.prio < a.prio ? b : a))
      shown = shown.filter(x => x !== least)
    }

    return (
      <Box>
        {shown.map((x, i) => (
          <Text key={x.key}>
            {i > 0 ? SEP : ''}
            {x.label ? <Text dimColor>{x.label} </Text> : null}
            <Text color={x.color} dimColor={x.dim === true}>
              {x.value}
            </Text>
          </Text>
        ))}
        <Text>{SEP}</Text>
        {expand}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snap)
    const t = await read($, trees)
    if (!s) {
      return (
        <Box>
          <Text dimColor>host: sampling…</Text>
        </Box>
      )
    }

    const c = colors(s)
    const cols = e.props.bodyColumns || 80
    const bw = Math.max(8, Math.min(24, Math.floor(cols / 4)))
    const now = await $.clock.now()
    const age = Math.max(0, Math.round((now - s.at) / 1000))

    const row = (label: string, body: RenderChildren) => (
      <Text key={label}>
        <Text dimColor>{label.padEnd(7)}</Text>
        {body}
      </Text>
    )
    const meter = (pct: number | null, color: string | undefined, text: string, tail?: string) => (
      <Text>
        <Text color={color}>{bar(pct ?? 0, bw)}</Text> {text}
        {tail ? <Text dimColor>  {tail}</Text> : null}
      </Text>
    )

    const swapPct = s.swap && s.swap.totalM > 0 ? (s.swap.usedM / s.swap.totalM) * 100 : null
    const swapFill = s.swap ? `${(s.swap.usedM / 1024).toFixed(1)}G/${(s.swap.totalM / 1024).toFixed(0)}G` : 'none'
    const swapTraffic = c.swapIo === null ? 'traffic ?' : `traffic ${rate(c.swapIo)}`
    const memTail = `compressed ${g1(s.mem.compressedG)}  unused ${g1(s.mem.unusedG)}`
    const treesLine = t
      ? `${gb(t.totalK)}·${t.count}  ${t.dirs.map(d => `${d.name} ${gb(d.k)}`).join('  ')}`
      : '…'
    const ts = s.tailscale
    const online = ts ? ts.peers.filter(p => p.isOnline).length : 0
    const tsLine = ts
      ? `${ts.state === 'Running' ? 'ok' : ts.state}  ${ts.dns}  peers ${online}/${ts.peers.length}` +
        (online > 0 ? `  ${ts.peers.filter(p => p.isOnline).map(p => p.name).join(' ')}` : '')
      : '—'

    // The hungriest processes: two tables side by side when the pane is wide enough.
    const fixedRows = 11
    const n = Math.max(3, Math.min(TOP_N, e.props.scroll.bodyRows - fixedRows))
    const sideBySide = cols >= 64
    const colW = sideBySide ? Math.floor((cols - 2) / 2) : cols
    const fit = (name: string, w: number) => (name.length > w ? name.slice(0, Math.max(1, w - 1)) + '…' : name)
    const cpuLine = (p: Proc) => `${p.cpu.toFixed(1).padStart(5)}  ${fit(p.name, colW - 7)}`
    const rssLine = (p: Proc) => `${g1(p.rssK / 1024 ** 2).padStart(5)}  ${fit(p.name, colW - 7)}`
    const cpuRows = s.top.cpu.slice(0, n)
    const rssRows = s.top.rss.slice(0, n)
    const table = (title: string, lines: string[]) => (
      <Box flexDirection="column" width={colW}>
        <Text dimColor>{title}</Text>
        {lines.map((l, i) => (
          <Text key={String(i)}>{l}</Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{s.host}</Text>
          <Text dimColor>  up </Text>
          {s.up}
          <Text dimColor>  {s.cpus} cpu  load </Text>
          {s.load.map(x => x.toFixed(1)).join(' ')}
          <Text dimColor>  sampled {age}s ago</Text>
        </Text>
        {row('cpu', meter(s.cpuBusy, c.cpu, `${s.cpuBusy ?? '?'}%`, `claude ${s.claude.cpu}%`))}
        {row('mem', meter(c.memPct, c.mem, `${g1(s.mem.usedG)}/${g1(s.mem.totalG)}`, memTail))}
        {row('swap', meter(swapPct, c.swap, swapFill, swapTraffic))}
        {row('disk', meter(s.disk?.pct ?? null, c.disk, s.disk ? `${s.disk.pct}%` : '?', s.disk ? `${gb(s.disk.availK)} free` : undefined))}
        {row('claude', `${s.claude.procs} processes  ${gb(s.claude.rssK)} rss  ${s.claude.cpu}% cpu`)}
        {row('trees', treesLine)}
        {row('ssh', s.ssh.length ? s.ssh.join('  ') : 'none')}
        {row('ts', <Text color={c.ts}>{tsLine}</Text>)}
        <Text> </Text>
        {sideBySide ? (
          <Box>
            {table('cpu%', cpuRows.map(cpuLine))}
            <Text>  </Text>
            {table('rss', rssRows.map(rssLine))}
          </Box>
        ) : (
          <Box flexDirection="column">
            {table('cpu%', cpuRows.map(cpuLine))}
            {table('rss', rssRows.map(rssLine))}
          </Box>
        )}
      </Box>
    )
  })
}
