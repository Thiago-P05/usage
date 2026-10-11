import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeLabel } from './labels.js'
import { compactUsage } from './presentation.js'
import { collectUsage } from './usage.js'

test('native labels preserve Unicode and explicit email, normalize whitespace and strip controls', () => {
  assert.equal(nativeLabel('  José\t equipo\n東京 🚀  '), 'José equipo 東京 🚀')
  assert.equal(nativeLabel('Ana\u0000\u001b\u202e'), 'Ana')
  assert.equal(nativeLabel('chosen@example.invalid'), 'chosen@example.invalid')
  for (const value of [undefined, null, 123, '', ' \t\n', '\u0000\u202e']) assert.equal(nativeLabel(value), '')
  assert.equal(Array.from(nativeLabel('🚀'.repeat(100))).length, 80)
  assert.ok(nativeLabel('🚀'.repeat(100)).endsWith('…'))
})

test('headings use explicit labels only, keep Grok/plan, and number missing labels', () => {
  const account = (label, provider = 'openai', plan = 'plus') => ({ label, name: 'AUTH-SECRET', provider, plan, compatible: true, windows: [] })
  const view = compactUsage({ accounts: [account(' José 東京 '), account(undefined), account('  '), account('Trabajo', 'xai', 'SuperGrok')] })
  assert.deepEqual(view.accounts.map((a) => a.title), ['José 東京 · Plus', 'Cuenta 2 · Plus', 'Cuenta 3 · Plus', 'Trabajo · Grok · SuperGrok'])
  assert.doesNotMatch(JSON.stringify(view), /AUTH-SECRET/)
})

test('equal labels never merge distinct native identities or quota requests', async () => {
  const connections = [1, 2].map((i) => ({ type: 'credential', id: `id-${i}`, label: 'Equipo', method: 'oauth' }))
  const seen = []
  const ctx = { integration: { list: async () => ({ data: [{ id: 'openai', connections }] }), connection: {
    resolve: async (c) => ({ type: 'oauth', access: `secret-${c.id}`, metadata: { accountID: `account-${c.id}` } }),
  } } }
  const report = await collectUsage(ctx, { fetcher: async (_, options) => {
    seen.push(options.headers['ChatGPT-Account-Id'])
    const used = seen.length * 10
    return { ok: true, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: used } } }) }
  } })
  assert.equal(new Set(seen).size, 2)
  assert.deepEqual(report.accounts.map((a) => a.name), ['Equipo', 'Equipo'])
  assert.deepEqual(report.accounts.map((a) => a.windows[0].remaining), [90, 80])
  assert.deepEqual(compactUsage(report).accounts.map((a) => a.title), ['Equipo · Plus', 'Equipo · Plus'])
})
