import type { EngineInterface, Register } from 'claude-code'

import { appendArgv, fresh, line, logPath, row, type Reading } from './line'

// Module-owned: a reload starts it over, and a duplicate line is harmless.
const seen = new Set<string>()

async function log($: EngineInterface, readings: readonly Reading[]): Promise<void> {
  const todo = fresh(readings, seen)
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

export const register: Register = on => {
  // The first reading: what the last response reported, if the session has one yet.
  on('session.start', async ($, e, next) => {
    try {
      const { rateLimits } = await $.session.usage()
      await log($, rateLimits)
    } catch {
      // Observe only: a failed log never touches the session.
    }
    return next(e)
  })

  // Pushed, not polled: the engine raises this when a window moves a whole point.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      try {
        await log($, e.rateLimits)
      } catch {
        // Observe only.
      }
    }
    return next(e)
  })
}
