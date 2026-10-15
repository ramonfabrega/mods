// Pure parsers over the host commands' stdout. No `$` here, so the test kit
// (which has no process) can hold every one of them to a captured sample.

export type Sysctl = {
  load: [number, number, number]
  cpus: number
  memsizeG: number
  swap: { totalM: number; usedM: number } | null
}

/** `sysctl -n vm.loadavg hw.ncpu hw.memsize vm.swapusage`, one value per line. */
export function parseSysctl(out: string): Sysctl {
  const [loadLine = '', cpuLine = '', memLine = '', swapLine = ''] = out.trim().split('\n')
  const nums = loadLine.match(/[\d.]+/g) ?? []
  const load: [number, number, number] = [
    Number(nums[0] ?? 0),
    Number(nums[1] ?? 0),
    Number(nums[2] ?? 0),
  ]
  const swapM = swapLine.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/)
  return {
    load,
    cpus: Number(cpuLine) || 0,
    memsizeG: Number(memLine) / 1024 ** 3,
    swap: swapM ? { totalM: Number(swapM[1]), usedM: Number(swapM[2]) } : null,
  }
}

export type Top = {
  cpuBusy: number | null
  usedG: number | null
  compressedG: number | null
  unusedG: number | null
}

/** The header of `top -l 1 -n 0 -s 0`: the CPU usage and PhysMem lines. */
export function parseTop(out: string): Top {
  const idle = out.match(/CPU usage:.*?([\d.]+)% idle/)
  const phys = out.match(/PhysMem: (\S+) used \((?:\S+ wired)?,?\s*(\S+) compressor\), (\S+) unused/)
  return {
    cpuBusy: idle ? Math.max(0, Math.round(100 - Number(idle[1]))) : null,
    usedG: phys ? sizeToG(phys[1] ?? '') : null,
    compressedG: phys ? sizeToG(phys[2] ?? '') : null,
    unusedG: phys ? sizeToG(phys[3] ?? '') : null,
  }
}

/** "8459M" → 8.26, "10G" → 10, "512K" → 0.0005 */
export function sizeToG(s: string): number | null {
  const m = s.match(/^([\d.]+)([KMGT])$/)
  if (!m) return null
  const n = Number(m[1])
  switch (m[2]) {
    case 'K': return n / 1024 ** 2
    case 'M': return n / 1024
    case 'G': return n
    case 'T': return n * 1024
  }
  return null
}

/** `df -k <path>`: the one data row. */
export function parseDf(out: string): { totalK: number; availK: number; pct: number } | null {
  const row = out.trim().split('\n')[1]
  if (!row) return null
  const cols = row.split(/\s+/)
  const totalK = Number(cols[1])
  const availK = Number(cols[3])
  const pct = Number((cols[4] ?? '').replace('%', ''))
  if (!Number.isFinite(totalK) || !Number.isFinite(availK)) return null
  return { totalK, availK, pct }
}

/** `uptime`'s "up ..." clause → "40d 8h", "3h 21m", "5m". */
export function parseUptime(out: string): string {
  const m = out.match(/up\s+(.*?),\s+\d+ users?/)
  const clause = m?.[1] ?? out
  const days = clause.match(/(\d+) days?/)
  const hm = clause.match(/(\d+):(\d{2})/)
  const mins = clause.match(/(\d+) mins?/)
  const parts: string[] = []
  if (days) parts.push(`${days[1]}d`)
  if (hm) {
    parts.push(`${Number(hm[1])}h`)
    if (!days) parts.push(`${Number(hm[2])}m`)
  } else if (mins) parts.push(`${mins[1]}m`)
  return parts.join(' ') || clause.trim()
}

/** `who`: the rows with a remote host in parentheses → "ttys000 ← host". */
export function parseWho(out: string): string[] {
  return out
    .trim()
    .split('\n')
    .map(line => line.match(/^\S+\s+(\S+)\s+.*\((.+)\)\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => `${m[1]} ← ${m[2]}`)
}

/** `ps -axo rss=,pcpu=,comm=`: the claude-shaped processes summed. */
export function parsePs(out: string): { procs: number; rssK: number; cpu: number } {
  let procs = 0
  let rssK = 0
  let cpu = 0
  for (const line of out.trim().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/)
    if (!m) continue
    const base = (m[3] ?? '').split('/').pop() ?? ''
    if (!/^(claude|bun|node)/.test(base)) continue
    procs += 1
    rssK += Number(m[1])
    cpu += Number(m[2])
  }
  return { procs, rssK, cpu: Math.round(cpu) }
}

export type Proc = { name: string; cpu: number; rssK: number }

/**
 * `ps -axo rss=,pcpu=,comm=` again: the `n` hungriest processes by cpu and by
 * rss, each named by its basename (an `.app` bundle by the app's name).
 */
export function parseProcs(out: string, n: number): { cpu: Proc[]; rss: Proc[] } {
  const procs: Proc[] = []
  for (const line of out.trim().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/)
    if (!m) continue
    const path = m[3] ?? ''
    const app = path.match(/\/([^/]+)\.app\//)
    const name = app?.[1] ?? path.split('/').pop() ?? path
    procs.push({ name, cpu: Number(m[2]), rssK: Number(m[1]) })
  }
  const cpu = [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, n)
  const rss = [...procs].sort((a, b) => b.rssK - a.rssK).slice(0, n)
  return { cpu, rss }
}

/**
 * `du -sk <dirs>`: each row "k<TAB>/…/<repo>/.claude/worktrees" → by repo,
 * largest first; "…/.codex/worktrees" is the one row named `codex`.
 */
export function parseDu(out: string): { totalK: number; dirs: { name: string; k: number }[] } {
  const dirs = out
    .trim()
    .split('\n')
    .map(line => line.match(/^(\d+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => {
      const path = m[2] ?? ''
      const parts = path.split('/')
      const codex = parts.lastIndexOf('.codex')
      const claude = parts.lastIndexOf('.claude')
      const name = codex >= 0 ? 'codex' : parts[claude - 1] ?? path
      return { name, k: Number(m[1]) }
    })
    .sort((a, b) => b.k - a.k)
  return { totalK: dirs.reduce((n, d) => n + d.k, 0), dirs }
}

/** `vm_stat`'s lifetime swap counters, in pages. */
export function parseVmStatSwap(out: string): { ins: number; outs: number } | null {
  const ins = out.match(/^Swapins:\s+(\d+)/m)
  const outs = out.match(/^Swapouts:\s+(\d+)/m)
  if (!ins || !outs) return null
  return { ins: Number(ins[1]), outs: Number(outs[1]) }
}

/** bytes per second → "0", "12K/s", "2.1M/s" */
export function rate(bytesPerS: number): string {
  if (bytesPerS < 1024) return bytesPerS <= 0 ? '0' : `${Math.round(bytesPerS)}B/s`
  if (bytesPerS < 1024 ** 2) return `${Math.round(bytesPerS / 1024)}K/s`
  return `${(bytesPerS / 1024 ** 2).toFixed(1)}M/s`
}

export type Tailscale = {
  state: string
  dns: string
  /** every peer the node knows, online first, then by name */
  peers: { name: string; isOnline: boolean }[]
}

/** `tailscale status --json`: the backend state, the node's DNS name, its peers. */
export function parseTailscale(json: string): Tailscale | null {
  try {
    const v: unknown = JSON.parse(json)
    if (typeof v !== 'object' || v === null) return null
    const o = v as {
      BackendState?: unknown
      Self?: { DNSName?: unknown }
      Peer?: Record<string, { HostName?: unknown; Online?: unknown }>
    }
    const state = typeof o.BackendState === 'string' ? o.BackendState : 'unknown'
    const dns = typeof o.Self?.DNSName === 'string' ? o.Self.DNSName.replace(/\.$/, '') : ''
    const peers = Object.values(o.Peer ?? {})
      .map(p => ({
        name: typeof p.HostName === 'string' ? p.HostName : '?',
        isOnline: p.Online === true,
      }))
      .sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || a.name.localeCompare(b.name))
    return { state, dns, peers }
  } catch {
    return null
  }
}

// ─── formatting ────────────────────────────────────────────────────────────

export function gb(k: number): string {
  const g = k / 1024 ** 2
  return g >= 100 ? `${Math.round(g)}G` : g >= 10 ? `${g.toFixed(0)}G` : `${g.toFixed(1)}G`
}

export function g1(g: number | null): string {
  if (g === null) return '?'
  return g >= 100 ? `${Math.round(g)}G` : g >= 10 ? `${g.toFixed(0)}G` : `${g.toFixed(1)}G`
}

export function bar(pct: number, width: number): string {
  const w = Math.max(1, width)
  const on = Math.round((Math.min(100, Math.max(0, pct)) / 100) * w)
  return '█'.repeat(on) + '░'.repeat(w - on)
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}
