import { expect, mock, test } from 'claude-code/testing'

// The kit has no process, so every probe answers null and the snapshot is the
// parsers' empty shapes: enough to show both trees validate on each surface.

// The kit has no surface beneath the plugins: a test answers `ui.open` and
// `ui.close` itself and keeps the roster the engine would.
function panes(on: Parameters<Parameters<typeof test>[1]>[1]): Set<string> {
  const open = new Set<string>()
  on('ui.open', (_$, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  return open
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'host',
  props: { title: 'host', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the band draws with its expand button, and a press opens the pane', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/Users/x' })
  const open = panes(on)
  await $.command.run({ command: 'host', args: '' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'host', surface, ...BAND })
    expect(await ui.find({ key: 'pane' })).toBeDefined()
    await ui.press({ key: 'pane' })
    expect(open.has('host')).toBe(true)
    await ui.press({ key: 'pane' })
    expect(open.has('host')).toBe(false)
    await ui.unmount()
  }
  await $.command.run({ command: 'host', args: 'off' })
})

test('/host pane toggles the pane, /host off closes everything', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/Users/x' })
  const open = panes(on)
  expect((await $.command.run({ command: 'host', args: 'pane' })).text).toBe('host pane open.')
  expect(open.has('host')).toBe(true)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'host', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /cpu/ })).toBeDefined()
    await ui.unmount()
  }
  expect((await $.command.run({ command: 'host', args: 'off' })).text).toBe('host off.')
  expect(open.has('host')).toBe(false)
})
