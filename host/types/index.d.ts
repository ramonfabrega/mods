export type HostSnap = {
  /** ms since the epoch when the fast sample was taken */
  at: number
  host: string
  /** "40d 8h", "3h 21m", "5m" */
  up: string
  load: [number, number, number]
  cpus: number
  /** percent busy (100 - idle), null when top gave nothing */
  cpuBusy: number | null
  mem: { totalG: number; usedG: number | null; compressedG: number | null; unusedG: number | null }
  /** usedM is the high-water fill; ioBytesPerS is swap traffic since the last sample, null on the first */
  swap: { totalM: number; usedM: number; ioBytesPerS: number | null } | null
  disk: { totalK: number; availK: number; pct: number } | null
  claude: { procs: number; rssK: number; cpu: number }
  /** the hungriest processes, by cpu and by rss, for the pane */
  top: { cpu: Proc[]; rss: Proc[] }
  /** "ttys000 ← 100.64.0.7" */
  ssh: string[]
  tailscale: Tailscale | null
}

export type Proc = { name: string; cpu: number; rssK: number }

export type Tailscale = {
  state: string
  dns: string
  peers: { name: string; isOnline: boolean }[]
}

/** The slow sample: every `.claude/worktrees` under ~/code, by repo. */
export type TreeSnap = {
  at: number
  totalK: number
  /** worktree checkouts counted across every dir */
  count: number
  dirs: { name: string; k: number; count: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    host: {
      /** the band above the prompt */
      isOn: boolean
      /** the pane, the expanded view */
      isPane: boolean
      snap: HostSnap | null
      trees: TreeSnap | null
    }
  }
}
