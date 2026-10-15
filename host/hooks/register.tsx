import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { HostSnap, TreeSnap } from '../types'
import {
  g1,
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
} from './parse'

const PAGE = 16_384

const FAST_MS = 5_000
const SLOW_MS = 300_000
const STORE_KEY = 'host.on'
const TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

const isOn = atom({ plugin: 'host', key: 'isOn' } as const, false)
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

async function turn($: EngineInterface, enabled: boolean): Promise<void> {
  await update($, isOn, () => enabled)
  await $.store.set(STORE_KEY, enabled)
  if (enabled) start($)
  else stop()
}

type Seg = { key: string; label: string; value: string; color?: string; dim?: boolean; prio: number }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'host',
      description: 'Toggle the host band: cpu, load, memory, swap, disk, worktrees, claude processes',
    })
    const remembered = (await $.store.get(STORE_KEY)) === true
    if (remembered) await turn($, true)
    return next(e)
  })

  on('command.run', { command: 'host' }, async $ => {
    const enabled = (await read($, isOn)) === true
    await turn($, !enabled)
    return { text: enabled ? 'host band off.' : 'host band on.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const enabled = await read($, isOn)
    if (!enabled || e.props.hasSurvey) return next(e)

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

    const hot = (pct: number | null, warn: number, bad: number) =>
      pct === null ? undefined : pct >= bad ? 'red' : pct >= warn ? 'yellow' : undefined
    const memPct = s.mem.usedG !== null && s.mem.totalG > 0 ? (s.mem.usedG / s.mem.totalG) * 100 : null
    // Swap FILL is a high-water mark that only a reboot clears; TRAFFIC is the pressure now.
    const swapIo = s.swap?.ioBytesPerS ?? null
    const swapIoK = swapIo === null ? null : swapIo / 1024
    const swapValue = s.swap
      ? `${(s.swap.usedM / 1024).toFixed(1)}G${swapIo !== null && swapIo > 0 ? ` ${rate(swapIo)}` : ''}`
      : 'none'

    // Higher prio survives a narrow band. Display order is the array's.
    const segs: Seg[] = [
      { key: 'host', label: '', value: s.host, prio: 2 },
      { key: 'up', label: 'up', value: s.up, prio: 1 },
      { key: 'cpu', label: 'cpu', value: `${s.cpuBusy ?? '?'}%`, color: hot(s.cpuBusy, 75, 90), prio: 7 },
      { key: 'load', label: 'load', value: s.load[0].toFixed(1), dim: true, prio: 4 },
      {
        key: 'mem',
        label: 'mem',
        value: `${g1(s.mem.usedG)}/${g1(s.mem.totalG)}`,
        color: hot(memPct, 90, 97),
        prio: 8,
      },
      // yellow past 1 MB/s of swap traffic, red past 10: the box is paging now
      { key: 'swap', label: 'swap', value: swapValue, color: hot(swapIoK, 1024, 10_240), prio: 9 },
      {
        key: 'disk',
        label: 'disk',
        value: s.disk ? `${gb(s.disk.availK)} free` : '?',
        color: hot(s.disk?.pct ?? null, 85, 93),
        prio: 10,
      },
      { key: 'trees', label: 'trees', value: t ? `${gb(t.totalK)}·${t.count}` : '…', prio: 6 },
      { key: 'claude', label: 'claude', value: `${s.claude.procs}p ${gb(s.claude.rssK)}`, prio: 5 },
      { key: 'ssh', label: 'ssh', value: String(s.ssh.length), prio: 0 },
      {
        key: 'ts',
        label: 'ts',
        value: s.tailscale ? (s.tailscale.state === 'Running' ? 'ok' : s.tailscale.state) : '—',
        color: s.tailscale && s.tailscale.state !== 'Running' ? 'yellow' : undefined,
        prio: 3,
      },
    ]

    const SEP = '  '
    const width = (x: Seg) => (x.label ? x.label.length + 1 : 0) + x.value.length
    const cols = e.props.bodyColumns || 80
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
      </Box>
    )
  })
}
