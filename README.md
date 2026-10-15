# mods

Claude Code mods: hooks modules that change the interface itself, one folder
per mod, this repo the marketplace that lists them.

| mod | what it is |
| --- | --- |
| [`host`](host/) | `/host` toggles one band above the prompt with the box's health. |

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
tsc -p host          # after the engine has laid host/.claude-plugin/types/
```

The mods are written with Claude Code's `plugin-authoring` skill.

## host

One band, not a pane: hostname, uptime, cpu%, load (dim), mem used/total,
swap fill + swap TRAFFIC, disk free, worktree trees size·count (every
`.claude/worktrees` under `~/code`, plus `~/.codex/worktrees`), claude-shaped
processes, ssh peers, tailscale state. Segments drop by priority when the band
is narrower than the terminal.

Why those numbers: on macOS the load average counts threads and misleads,
"memory used" is mostly cache, and swap USED is a high-water mark only a
reboot clears. So the band colors cpu% and swap traffic, which say what the
box is doing now, and dims load. The toggle is remembered across sessions.

macOS only (`sysctl`, `top -l 1`, `vm_stat`, `df`, `who`, the Tailscale app
binary).
