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
  parseTreeCounts,
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
const TOP_N = 12
// The dock width the pane asks for: a request the person's own drag overrides.
const PANE_COLS = 40
const PANE_ROWS = 44
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
  const counts = parseTreeCounts(inner ?? '')
  const count = Object.values(counts).reduce((n, c) => n + c, 0)
  const sizes = parseDu(du ?? '')
  const next: TreeSnap = { at, count, totalK: sizes.totalK, dirs: sizes.dirs.map(d => ({ ...d, count: counts[d.name] ?? 0 })) }
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
  if (enabled) await $.ui.open({ id: PANE, title: 'host', columns: PANE_COLS, rows: PANE_ROWS })
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

    // A snapshot written by an older build of this module outlives a reload
    // (state is the host's): fields this build added may be missing for one tick.
    const top = s.top ?? { cpu: [], rss: [] }
    const ts = s.tailscale
    const peers = ts?.peers ?? []
    const online = peers.filter(p => p.isOnline)

    const c = colors(s)
    const cols = Math.max(20, e.props.bodyColumns || 40)
    const now = await $.clock.now()
    const age = Math.max(0, Math.round((now - s.at) / 1000))

    // A narrow column: label, bar and figure on one row, the detail dimmed
    // beneath it. Every row is budgeted against the width and truncated.
    const LABEL = 5
    const FIGURE = 6
    const bw = cols - LABEL - FIGURE - 1
    const cell = (w: number, text: RenderChildren, opts: { dim?: boolean; color?: string; right?: true } = {}) => (
      <Box width={w} justifyContent={opts.right ? 'flex-end' : 'flex-start'}>
        <Text dimColor={opts.dim === true} color={opts.color} wrap="truncate">
          {text}
        </Text>
      </Box>
    )
    const meter = (name: string, pct: number | null, color: string | undefined, figure: string, detail: string) => (
      <Box flexDirection="column" key={name}>
        <Box>
          {cell(LABEL, name, { dim: true })}
          {cell(bw, bar(pct ?? 0, bw), { color })}
          {cell(FIGURE + 1, figure, { color, right: true })}
        </Box>
        <Box>
          <Box width={LABEL} />
          {cell(cols - LABEL, detail, { dim: true })}
        </Box>
      </Box>
    )
    const line = (name: string, body: RenderChildren) => (
      <Box key={name}>
        {cell(8, name, { dim: true })}
        {cell(cols - 8, body)}
      </Box>
    )

    const swapPct = s.swap && s.swap.totalM > 0 ? (s.swap.usedM / s.swap.totalM) * 100 : null

    // Trees: name, share bar, size, checkouts; the bar takes what the width leaves.
    const treeRows = (t?.dirs ?? []).map(d => ({ ...d, count: d.count ?? 0 }))
    const nameW = Math.min(12, Math.max(4, ...treeRows.map(d => d.name.length)))
    const SIZE = 6
    const COUNT = 3
    const shareW = Math.max(3, Math.min(16, cols - nameW - SIZE - COUNT - 3))

    // Processes: the rows that fit, by cpu, then by rss when there is room for both.
    const fixed = 3 + 1 + 8 + 1 + 3 + 1 + 1 + treeRows.length + 1
    const room = Math.max(5, e.props.scroll.bodyRows - fixed)
    const both = room >= 15
    const n = Math.min(TOP_N, both ? Math.floor((room - 3) / 2) : room - 1)
    const CPU = 5
    const RSS = 6
    const procs = (title: string, rows: Proc[]) => (
      <Box flexDirection="column" key={title}>
        <Box>
          {cell(CPU, 'cpu%', { dim: true, right: true })}
          {cell(RSS, 'rss', { dim: true, right: true })}
          {cell(cols - CPU - RSS - 2, <Text>  {title}</Text>, { dim: true })}
        </Box>
        {rows.map((p, i) => (
          <Box key={String(i)}>
            {cell(CPU, p.cpu.toFixed(1), { color: p.cpu >= 100 ? 'yellow' : undefined, right: true })}
            {cell(RSS, g1(p.rssK / 1024 ** 2), { right: true })}
            {cell(cols - CPU - RSS - 2, <Text>  {p.name}</Text>)}
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box>
          {cell(cols - 5, <Text bold>{s.host}</Text>)}
          {cell(5, `${age}s`, { dim: true, right: true })}
        </Box>
        {cell(cols, <Text><Text dimColor>up </Text>{s.up}<Text dimColor>  ·  {s.cpus} cpu</Text></Text>)}
        {cell(cols, <Text><Text dimColor>load </Text>{s.load.map(x => x.toFixed(1)).join(' ')}</Text>)}
        <Text> </Text>
        {meter('cpu', s.cpuBusy, c.cpu, `${s.cpuBusy ?? '?'}%`, `claude ${s.claude.cpu}%`)}
        {meter(
          'mem',
          c.memPct,
          c.mem,
          g1(s.mem.usedG),
          `of ${g1(s.mem.totalG)} · comp ${g1(s.mem.compressedG)} · free ${g1(s.mem.unusedG)}`,
        )}
        {meter(
          'swap',
          swapPct,
          c.swap,
          s.swap ? `${(s.swap.usedM / 1024).toFixed(1)}G` : 'none',
          s.swap ? `of ${(s.swap.totalM / 1024).toFixed(0)}G · io ${c.swapIo === null ? '?' : rate(c.swapIo)}` : '',
        )}
        {meter('disk', s.disk?.pct ?? null, c.disk, s.disk ? `${s.disk.pct}%` : '?', s.disk ? `${gb(s.disk.availK)} free` : '')}
        <Text> </Text>
        {line('claude', `${s.claude.procs}p · ${gb(s.claude.rssK)} · ${s.claude.cpu}%`)}
        {line('ssh', s.ssh.length ? s.ssh.join(' · ') : <Text dimColor>none</Text>)}
        {line(
          'ts',
          ts ? (
            <Text>
              <Text color={c.ts}>{ts.state === 'Running' ? 'ok' : ts.state}</Text>
              <Text dimColor> · </Text>
              {online.length}/{peers.length}
              <Text dimColor> online{online.length ? ` · ${online.map(p => p.name).join(' ')}` : ''}</Text>
            </Text>
          ) : (
            <Text dimColor>—</Text>
          ),
        )}
        <Text> </Text>
        {line('trees', t ? <Text>{gb(t.totalK)}<Text dimColor> · {t.count} checkouts</Text></Text> : <Text dimColor>…</Text>)}
        {treeRows.map(d => (
          <Box key={d.name}>
            {cell(nameW + 1, d.name)}
            {cell(shareW + 1, bar(t && t.totalK > 0 ? (d.k / t.totalK) * 100 : 0, shareW), { dim: true })}
            {cell(SIZE, gb(d.k), { right: true })}
            {cell(COUNT + 1, String(d.count), { dim: true, right: true })}
          </Box>
        ))}
        <Text> </Text>
        {procs('by cpu', top.cpu.slice(0, n))}
        {both ? <Text> </Text> : null}
        {both ? procs('by rss', top.rss.slice(0, n)) : null}
      </Box>
    )
  })
}
