import type { EngineInterface, Register } from 'claude-code'

import { appendArgv, fresh, line, logPath, row, type Reading } from './line'
import { USAGE_HEADERS, USAGE_URL, due, nowPath, parseUsage, readings, replaceArgv, snapshotText } from './usage'

// Module-owned: a reload starts it over, and a duplicate line is harmless.
const seen = new Set<string>()
// The snapshot is looked at no more than once a minute per session, unless a window moved.
let nextLookAt = 0
const LOOK_MS = 60_000

async function log($: EngineInterface, found: readonly Reading[]): Promise<void> {
  const todo = fresh(found, seen)
  if (todo.length === 0) return
  const [home, loreHome, session, now] = await Promise.all([
    $.env.get('HOME'),
    $.env.get('LORE_HOME'),
    $.session.id(),
    $.clock.now(),
  ])
  if (!home) return
  const path = logPath(home, loreHome ?? undefined)
  const ts = new Date(now).toISOString()
  const text = todo.map(r => line(row(r, ts, session))).join('\n')
  await $.process.run(appendArgv(path, text), { timeoutMs: 5_000 })
}

/**
 * The per-model weeks, which the engine's readings do not carry: asks the
 * usage endpoint with the session's own credential (the engine sets the
 * header; the secret never reaches this module), replaces the snapshot the
 * status line reads, and logs each scoped window that moved.
 */
async function refresh($: EngineInterface, moved: boolean): Promise<void> {
  const now = await $.clock.now()
  if (!moved && now < nextLookAt) return
  nextLookAt = now + LOOK_MS
  const [home, loreHome] = await Promise.all([$.env.get('HOME'), $.env.get('LORE_HOME')])
  if (!home) return
  const path = nowPath(home, loreHome ?? undefined)
  let prior: string | undefined
  try {
    prior = await $.fs.read(path)
  } catch {
    // No snapshot yet.
  }
  if (!due(prior, now, moved)) return
  const auth = await $.session.authorize()
  if (!auth || auth.kind !== 'bearer') return
  const res = await $.http.fetch(USAGE_URL, { headers: USAGE_HEADERS, auth: auth.handle })
  if (!res.ok) return
  const usage = parseUsage(res.text)
  if (!usage) return
  const session = await $.session.id()
  const text = snapshotText({ ts: new Date(now).toISOString(), session, ...usage })
  await $.process.run(replaceArgv(path, text), { timeoutMs: 5_000 })
  await log($, readings(usage))
}

export const register: Register = on => {
  // The first reading: what the last response reported, if the session has one yet.
  on('session.start', async ($, e, next) => {
    try {
      const { rateLimits } = await $.session.usage()
      await log($, rateLimits)
    } catch {
      // Observe only: a failed log never touches the session.
    }
    try {
      await refresh($, true)
    } catch {
      // Observe only.
    }
    return next(e)
  })

  // Pushed, not polled: the engine raises this when a window moves a whole point.
  on('session.measure', async ($, e, next) => {
    const moved = e.changed.includes('rateLimits')
    if (moved) {
      try {
        await log($, e.rateLimits)
      } catch {
        // Observe only.
      }
    }
    try {
      await refresh($, moved)
    } catch {
      // Observe only.
    }
    return next(e)
  })
}
