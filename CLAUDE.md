# mods

One folder per mod, one entry in `.claude-plugin/marketplace.json`; the
README's Developing section is the loop. What a session cannot read off the
tree:

- The engine lays `<mod>/.claude-plugin/types/` the first time it loads the
  mod, and it is gitignored: on a fresh clone `tsc` fails until the mod has
  loaded once (`/reload-plugins` in a session that has it installed).
- The test kit (`claude plugin test`) has no process, fs or surface beneath
  the plugins: a probe answers null, and a test answers `ui.open`/`ui.close`
  itself with `{ value }` (see `host/host.ui.test.tsx`). Mock the clock,
  store and env with `mock.*` before anything that touches them.
- This repo is public. Fixtures and tests carry no hostname, peer, path or
  tailnet name from the real box.
