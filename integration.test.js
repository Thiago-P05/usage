import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import server from './index.js'
import { setupUsageCommand, mountUsageCommand } from './cli.js'
import { Usage } from './rpc.js'

test('TUI cold-load defers keymap until a child mounts under Keymap.Provider', () => {
  let slot, inProvider = false, calls = 0
  const cleanup = () => {}
  const ctx = {
    ui: { slot: (definition) => { slot = definition; return cleanup } },
    keymap: { layer: (factory) => {
      if (!inProvider) throw new Error('Keymap.Provider is missing')
      assert.equal(factory().commands[0].slash.name, 'usage')
      calls++
    } },
  }
  assert.equal(mountUsageCommand(ctx, (component) => ({ component })), cleanup)
  assert.equal(calls, 0)
  assert.equal(slot.append, 'app')
  const child = slot.render()
  assert.equal(calls, 0, 'slot callback itself must not register the keymap')
  inProvider = true
  assert.equal(child.component(), null)
  assert.equal(calls, 1)
})

test('actual TUI entrypoint uses deferred OpenTUI component instead of direct setup', async () => {
  const source = await readFile(new URL('./tui.js', import.meta.url), 'utf8')
  assert.match(source, /@opencode\/plugin\/tui/)
  assert.match(source, /@opentui\/solid\/jsx-runtime/)
  assert.match(source, /setup: \(ctx\) => mountUsageCommand\(ctx, jsx\)/)
  assert.doesNotMatch(source, /setup: setupUsageCommand/)
})

test('runtime smoke does not claim active account from connection ordering', async () => {
  const source = await readFile(new URL('./runtime-check.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /activeUnchanged|\.connections\[0\]/)
  assert.match(source, /activeAccountCheck: 'not verified'/)
})

test('V2 server registers read-only RPC, no model/credential mutation domains used', async () => {
  assert.deepEqual(Usage.events, {})
  assert.deepEqual(Usage.methods.read.input, { type: 'object', properties: {}, additionalProperties: false })
  let handlers
  await server.setup({
    rpc: { register: async (definition, implementation) => { assert.equal(definition.id, Usage.id); handlers = implementation } },
    integration: { list: async () => ({ data: [] }) },
  })
  assert.deepEqual(Object.keys(handlers), ['audit', 'view', 'read'])
  const result = await handlers.read({}, { signal: new AbortController().signal })
  assert.match(result.text, /No hay cuentas conectadas/)
  assert.deepEqual(Object.keys(result), ['text'])
})

test('V2 /usage keymap dispatch calls location-scoped RPC then dialog, never prompts model', async () => {
  let layer, calls = 0, dialog
  const location = { directory: 'C:/fixture' }
  setupUsageCommand({
    location,
    keymap: { layer: (definition) => { layer = definition() } },
    ui: { toast: { show() { assert.fail('usage must not show a loading toast') } }, dialog: { set: (options) => { assert.equal(options.size, 'large') }, show: (render) => { dialog = render() } } },
    client: { rpc: (definition) => {
      assert.equal(definition.id, Usage.id)
      return { view: async (input, options) => {
        calls++
        assert.deepEqual(input, {})
        assert.deepEqual(options.location, location)
        assert.ok(options.signal)
        return { accounts: [], message: 'No hay cuentas Codex compatibles' }
      } }
    } },
  }, (type, props) => ({ type, props }))
  assert.equal(layer.mode, 'global')
  assert.equal(layer.commands[0].slash.name, 'usage')
  await layer.commands[0].run()
  assert.equal(calls, 1)
  assert.equal(dialog.type, 'box')
  assert.match(JSON.stringify(dialog), /No hay cuentas Codex compatibles/)
})

test('CLI errors redacted, including RPC errors with credential-bearing text', async () => {
  let command, alert
  setupUsageCommand({
    location: { directory: 'C:/fixture' },
    keymap: { layer: (definition) => { command = definition().commands[0] } },
    ui: { toast: { show() {} }, dialog: { alert: async (input) => { alert = input } } },
    client: { rpc: () => ({ view: async () => { throw new Error('SECRET@example.invalid') } }) },
  })
  await command.run()
  assert.match(alert.message, /Cuotas desconocidas/)
  assert.doesNotMatch(alert.message, /SECRET|example.invalid/)
})
