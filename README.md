# mods

Claude Code mods: hooks modules that change the interface itself, one folder
per mod, this repo the marketplace that lists them.

| mod | what it is |
| --- | --- |
| [`host`](host/) | `/host` toggles one band above the prompt with the box's health; `/host pane` the expanded view. |

## Install

At the prompt of a terminal session:

```
/plugin install host --marketplace ramonfabrega/mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```sh
claude plugin install host --marketplace ramonfabrega/mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `ramonfabrega/mods`, then Add plugin.

## Developing

The checkout itself is a marketplace, so the installed copy IS the working
copy: add it as a directory marketplace and edits land with `/reload-plugins`,
no version bump, no reinstall.

```sh
claude plugin marketplace add ~/code/fun/mods
claude plugin install host@mods
```

Each mod type-checks and tests on its own:

```sh
claude plugin validate host
claude plugin test host
bunx --bun tsc -p host   # after the engine has laid host/.claude-plugin/types/
```

The mods are written with Claude Code's `plugin-authoring` skill.

## host

One band, not a pane: hostname, uptime, cpu%, load (dim), mem used/total,
swap fill + swap TRAFFIC, disk free, worktree trees size·count (every
`.claude/worktrees` under `~/code`, plus `~/.codex/worktrees`), claude-shaped
processes, ssh peers, tailscale state. Segments drop by priority when the band
is narrower than the terminal.

Behind the band, a pane: the same numbers as meters, the memory and swap
breakdown, every worktree dir by size, the ssh peers and tailscale peers by
name, and the hungriest processes by cpu and by rss. Same sampler, two
drawings. The band's last glyph (`⤢`) opens it: click it in the fullscreen
layout, or ctrl+x tab then `h` from the prompt. `/host pane` does the same
typed, `/host off` closes both, and the pane closes on Esc or its close mark.
The surface places it: docked beside the transcript in fullscreen from 110
columns, inline above the prompt otherwise. Both toggles are remembered
across sessions.

Why those numbers: on macOS the load average counts threads and misleads,
"memory used" is mostly cache, and swap USED is a high-water mark only a
reboot clears. So the band colors cpu% and swap traffic, which say what the
box is doing now, and dims load.

macOS only (`sysctl`, `top -l 1`, `vm_stat`, `df`, `who`, the Tailscale app
binary).

## limits

A logger, no UI of its own. The engine raises `session.measure` when a rate-limit
window moves a whole point and hands the hook the windows the last API
response reported — `five_hour` and `seven_day`, each with `percentUsed`
and `resetsAt`, the same figures the status line draws. `limits` appends
one JSON line per reading to `~/.lore/limits.jsonl` (`$LORE_HOME/limits.jsonl`
when that is set), from every session the mod is installed in:

```
{"ts":"2026-10-28T07:29:00.000Z","session":"<session id>","kind":"seven_day","pct":69,"resetsAt":"2026-10-31T11:00:00.000Z"}
```

Why: the subscription's weekly allowance is the only budget that matters
and nothing writes it down. Tokens and list dollars are what the
transcripts hold; the percent is what the account enforces. A week of both
side by side gives the exchange rate, and `resetsAt` gives the week's
anchor without anyone hardcoding a weekday. The append is one `/bin/sh`
call with the line passed as an argument, never interpolated, so the log
line's text cannot reach the shell. A failed write never touches the
session.

**The per-model weeks.** The engine's readings stop at `five_hour` and
`seven_day`, and neither they nor the status line's JSON carry the week
scoped to one model. Fable has one: its own allowance, half the all-models
week, and it binds first (85% of the week read 94% of Fable's on
2026-11-11). Only the endpoint `/usage` draws from answers it, as a
`weekly_scoped` row of `limits[]`. So `limits` asks it:
`$.session.authorize()` hands back an opaque handle, `$.http.fetch(url,
{ auth })` spends it, and the engine sets the credential header itself; the
token never reaches the mod. Each scoped row is logged like any other
window, its kind spelled the way the harness spells its Opus and Sonnet
weeks:

```
{"ts":"2026-11-11T16:52:18.182Z","session":"<session id>","kind":"seven_day_fable","pct":94,"resetsAt":"2026-11-14T11:00:00.000Z"}
```

and the whole answer replaces `~/.lore/limits-now.json`, written beside it
and renamed over so a reader never sees half:

```
{"ts":"2026-11-11T16:52:17.982Z","session":"<session id>","weekly":{"pct":85,"resetsAt":"2026-11-14T11:00:00.000Z"},"scoped":[{"name":"Fable","kind":"seven_day_fable","pct":94,"resetsAt":"2026-11-14T11:00:00.000Z","usedOfWeekly":47,"allowanceOfWeekly":50}]}
```

That file is what a status line reads (a status line command gets a
stripped environment and no credential, so it cannot ask for itself);
`usedOfWeekly` / `allowanceOfWeekly` are the model's share in points of the
all-models week. Every session with the mod shares the one snapshot, and it
is the throttle: the endpoint is asked when a window moves a point or a
session starts and the snapshot is over a minute old, and otherwise when it
is over ten, so twenty sessions ask once. Three things the endpoint does
that the code answers:

- `resets_at` carries each answer's own microseconds (`10:59:59.579`, then
  `10:59:59.730`), so the raw string is a new window every read. It is
  rounded to the minute, which is also what the engine's reading of the
  same window says.
- The harness names this window `seven_day_overage_included` in a 429
  (`rateLimitType`), not by its model. The log keeps the readable name; a
  reader joining the log to a transcript's 429 maps the one to the other.
- The unused-reset grants (`cedar_ember`) are answered only to the CLI's
  own client: a mod's request reads `eligible: false, ineligible_reason:
  "surface"` and an empty list. They are not logged.

```sh
claude plugin install limits@mods
```
