// Pure: readings in, JSONL lines out. No `$` here, so the test kit (which has
// no process and no clock of its own) can hold every case to a literal.

/** One rate-limit window as the engine reports it (SessionRateLimit). */
export type Reading = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** One line of ~/.lore/limits.jsonl. Keys sorted, so a line is comparable as text. */
export type Row = {
  ts: string
  session: string
  kind: string
  pct: number
  resetsAt: string | null
}

export function row(reading: Reading, ts: string, session: string): Row {
  return {
    ts,
    session,
    kind: reading.kind,
    pct: reading.percentUsed,
    resetsAt: reading.resetsAt ?? null,
  }
}

/** The JSON of a row, one line, no trailing newline (the appender adds it). */
export function line(r: Row): string {
  return JSON.stringify({ ts: r.ts, session: r.session, kind: r.kind, pct: r.pct, resetsAt: r.resetsAt })
}

/** The identity of a reading for dedupe: the same window at the same point toward the same reset is one fact. */
export function key(reading: Reading): string {
  return `${reading.kind}|${reading.percentUsed}|${reading.resetsAt ?? ''}`
}

/**
 * The readings not yet logged, against the keys already logged this module
 * life. `session.start` and the first `session.measure` can carry the same
 * figures; the engine raises `measure` only on a whole-point move, so after
 * that this filters nothing.
 */
export function fresh(readings: readonly Reading[], seen: Set<string>): Reading[] {
  const out: Reading[] = []
  for (const r of readings) {
    const k = key(r)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

/** The argv that appends `text` as one line to `path`, creating the directory; no shell quoting of `text`. */
export function appendArgv(path: string, text: string): string[] {
  return ['/bin/sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s\\n" "$1" >> "$2"', 'limits', text, path]
}

/** Where the log lives: under the home the engine hands us; LORE_HOME when set, since lore reads it. */
export function logPath(home: string, loreHome: string | undefined): string {
  const base = loreHome && loreHome.length > 0 ? loreHome : `${home}/.lore`
  return `${base}/limits.jsonl`
}
