// Pure: the usage endpoint's body in, the per-model weekly windows out. The
// engine's own readings (`$.session.usage()`) carry `five_hour` and
// `seven_day` and nothing else; the windows scoped to one model (Fable has
// its own weekly allowance, half the week's) come only from the endpoint
// `/usage` draws from.

import type { Reading } from './line'

/** The plain read `/usage` makes. Answered to the session's own bearer, which the engine sets. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const USAGE_HEADERS = { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' }

/** A moved window, or a session starting, asks again once the snapshot is this old. */
export const MOVED_MS = 60_000
/** Any other measurement asks again once the snapshot is this old. */
export const TICK_MS = 10 * 60_000

/** One weekly window scoped to a model, as the server's `limits[]` row reads. */
export type Scoped = {
  /** The server's label for the model bucket: `Fable`. */
  name: string
  /** The log's kind for it: `seven_day_fable`. */
  kind: string
  pct: number
  resetsAt: string | null
  /** Points of the all-models week this model has used, and how many it may. */
  usedOfWeekly: number | null
  allowanceOfWeekly: number | null
}

export type Usage = {
  /** The all-models week, as the same answer read it. */
  weekly: { pct: number; resetsAt: string | null } | null
  scoped: Scoped[]
}

/** What `limits-now.json` holds: the last answer, when it was read and by which session. */
export type Snapshot = Usage & { ts: string; session: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * A reset instant to the minute, as ISO. The endpoint stamps each answer's
 * `resets_at` with its own microseconds (10:59:59.579, then 10:59:59.730), so
 * the raw string is a new window every read; the engine's reading of the same
 * window says 11:00:00.000.
 */
export function minute(iso: unknown): string | null {
  if (typeof iso !== 'string') return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(Math.round(t / 60_000) * 60_000).toISOString() : null
}

/** `Fable` → `seven_day_fable`: the harness's own spelling for its Opus and Sonnet weeks. */
export function scopedKind(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `seven_day_${slug}`
}

/** The endpoint's body to its windows; null when it is not the shape (an error body, a login page). */
export function parseUsage(text: string): Usage | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(body) || !Array.isArray(body.limits)) return null
  const limits: unknown[] = body.limits
  const shares: unknown[] = Array.isArray(body.weekly_scoped_shares) ? body.weekly_scoped_shares : []

  let weekly: Usage['weekly'] = null
  const scoped: Scoped[] = []
  limits.forEach((row, index) => {
    if (!isObj(row)) return
    const pct = num(row.percent)
    if (pct === null) return
    if (row.kind === 'weekly_all') {
      weekly = { pct, resetsAt: minute(row.resets_at) }
      return
    }
    if (row.kind !== 'weekly_scoped') return
    const model = isObj(row.scope) && isObj(row.scope.model) ? row.scope.model.display_name : undefined
    if (typeof model !== 'string' || model.length === 0) return
    const share = shares.find(s => isObj(s) && s.limit_index === index)
    scoped.push({
      name: model,
      kind: scopedKind(model),
      pct,
      resetsAt: minute(row.resets_at),
      usedOfWeekly: isObj(share) ? num(share.used_percent_of_weekly) : null,
      allowanceOfWeekly: isObj(share) ? num(share.allowance_percent_of_weekly) : null,
    })
  })
  if (weekly === null && isObj(body.seven_day)) {
    const pct = num(body.seven_day.utilization)
    if (pct !== null) weekly = { pct, resetsAt: minute(body.seven_day.resets_at) }
  }
  return { weekly, scoped }
}

/** The scoped windows as readings, so they log through the same `fresh` and `line` as the engine's. */
export function readings(usage: Usage): Reading[] {
  return usage.scoped.map(s => ({ kind: s.kind, percentUsed: s.pct, ...(s.resetsAt ? { resetsAt: s.resetsAt } : {}) }))
}

/** The snapshot file's text: one JSON object, keys in a fixed order. */
export function snapshotText(s: Snapshot): string {
  return JSON.stringify({
    ts: s.ts,
    session: s.session,
    weekly: s.weekly && { pct: s.weekly.pct, resetsAt: s.weekly.resetsAt },
    scoped: s.scoped.map(x => ({
      name: x.name,
      kind: x.kind,
      pct: x.pct,
      resetsAt: x.resetsAt,
      usedOfWeekly: x.usedOfWeekly,
      allowanceOfWeekly: x.allowanceOfWeekly,
    })),
  })
}

/**
 * Whether to ask the endpoint, given the snapshot on disk. Every session with
 * the mod shares the one file, so a fleet of twenty asks once: the first to
 * find it old writes it and the rest find it fresh. No file, or one that does
 * not parse, is due.
 */
export function due(prior: string | undefined, now: number, moved: boolean): boolean {
  if (prior === undefined) return true
  let at = Number.NaN
  try {
    const parsed: unknown = JSON.parse(prior)
    if (isObj(parsed) && typeof parsed.ts === 'string') at = Date.parse(parsed.ts)
  } catch {
    return true
  }
  if (!Number.isFinite(at)) return true
  const age = now - at
  return age < 0 || age >= (moved ? MOVED_MS : TICK_MS)
}

/** The argv that replaces `path` with `text` whole: written beside it, then renamed over, so a reader never sees half. */
export function replaceArgv(path: string, text: string): string[] {
  return [
    '/bin/sh',
    '-c',
    'mkdir -p "$(dirname "$2")" && printf "%s\\n" "$1" > "$2.$$" && mv "$2.$$" "$2"',
    'limits',
    text,
    path,
  ]
}

/** Where the snapshot lives: beside the log. */
export function nowPath(home: string, loreHome: string | undefined): string {
  const base = loreHome && loreHome.length > 0 ? loreHome : `${home}/.lore`
  return `${base}/limits-now.json`
}
