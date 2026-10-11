import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGrok, grokPlan, GROK_BILLING, GROK_SETTINGS } from './grok.js'
import { collectUsage } from './usage.js'
import { compactUsage } from './presentation.js'

const now = Date.parse('2026-10-01T18:00:00Z')
const period = { start: '2026-09-28T00:00:00Z', end: '2026-10-05T00:00:00Z' }
const billing = (percent) => ({ config: { creditUsagePercent: percent, currentPeriod: period } })
const ctx = (data, resolve = async () => ({ type: 'oauth', access: 'mock-secret' })) => ({
  integration: { list: async () => ({ data }), connection: { resolve } },
})
const integration = (id, methods) => ({ id, connections: methods.map((method, i) => ({ id: `${id}-${i}`, method })) })

test('Grok explicit percent 0/12/88/100 and actual weekly bounds', () => {
  for (const used of [0, 12, 88, 100]) {
    const q = normalizeGrok(billing(used), now)
    assert.equal(q.windows[0].remaining, 100 - used)
    assert.equal(q.windows[0].reset, Date.parse(period.end))
    assert.equal(q.windows[0].seconds, 604800)
  }
})

test('Grok absent/invalid percentage never uses API spend, on-demand cap or price', () => {
  for (const used of [undefined, null, '12', -1, 101, NaN, Infinity]) {
    const q = normalizeGrok({ config: { ...billing(used).config,
      onDemandUsed: { val: 10 }, onDemandCap: { val: 100 }, monthlyLimit: { val: 100 }, subscriptionTier: 'SuperGrok Heavy' } }, now)
    assert.equal(q.windows[0].used, null)
    assert.equal(q.windows[0].remaining, null)
    assert.equal(q.plan, 'desconocido')
  }
  assert.throws(() => normalizeGrok({ usage: { totalUsed: { val: 12 } } }))
  assert.throws(() => normalizeGrok({ config: [] }))
})

test('Grok reset fallback pairs matching bounds; missing/reversed/future bounds stay unknown', () => {
  assert.deepEqual(normalizeGrok({ config: {} }, now).windows[0],
    { kind: 'Grok', used: null, remaining: null, reset: null, seconds: null })
  const fallback = normalizeGrok({ config: { currentPeriod: { start: period.start, end: 'invalid' },
    billingPeriodStart: '2026-09-01T00:00:00Z', billingPeriodEnd: '2026-10-01T00:00:00Z' } }, now)
  assert.equal(fallback.windows[0].seconds, 30 * 86400)
  for (const start of [undefined, 'invalid', period.end, '2026-10-03T00:00:00Z']) {
    assert.equal(normalizeGrok({ config: { currentPeriod: { start, end: period.end } } }, now).windows[0].seconds, null)
  }
  assert.equal(normalizeGrok({ config: { currentPeriod: { end: 123 } } }, now).windows[0].reset, null)
})

test('Grok plan uses only allowlisted settings names', () => {
  assert.equal(grokPlan('SuperGrok'), 'SuperGrok')
  assert.equal(grokPlan('SuperGrok Heavy'), 'SuperGrok Heavy')
  assert.equal(grokPlan('private@example.invalid'), 'desconocido')
})

test('mixed integration includes all Grok OAuth plus Codex; API/env never resolved or fetched', async () => {
  const resolved = [], fetched = []
  const report = await collectUsage(ctx([integration('openai', ['oauth']), integration('xai', ['oauth', 'key', 'env', 'oauth'])], async (c) => {
    resolved.push(c.id)
    return { type: 'oauth', access: c.id, metadata: { accountID: 'mock-account' } }
  }), { now: () => now, fetcher: async (url, options) => {
    fetched.push(url)
    assert.equal(options.redirect, 'error')
    if (url === GROK_BILLING) {
      assert.equal(options.headers['x-xai-token-auth'], 'xai-grok-cli')
      assert.match(options.headers.Authorization, /^Bearer xai-/)
      assert.equal(options.headers['ChatGPT-Account-Id'], undefined)
      return { ok: true, json: async () => billing(12) }
    }
    if (url === GROK_SETTINGS) return { ok: true, json: async () => ({ subscription_tier_display: 'SuperGrok Heavy' }) }
    return { ok: true, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 88 } } }) }
  } })
  assert.deepEqual(resolved, ['openai-0', 'xai-0', 'xai-3'])
  assert.equal(fetched.length, 5)
  const view = compactUsage(report, now)
  assert.deepEqual(view.accounts.map((a) => a.title), ['Cuenta 1 · Plus', 'Cuenta 2 · Grok · SuperGrok Heavy', 'Cuenta 3 · Grok · SuperGrok Heavy'])
  assert.deepEqual(view.accounts.map((a) => a.windows[0].remaining), [12, 88, 88])
  assert.doesNotMatch(JSON.stringify(view), /mock-account|Bearer|xai-0/)
})

test('Grok HTTP/network/invalid payload/resolve errors isolated and redacted', async () => {
  for (const failure of ['http', 'network', 'payload', 'resolve']) {
    const report = await collectUsage(ctx([integration('xai', ['oauth', 'oauth'])], async (c) => {
      if (c.id === 'xai-0' && failure === 'resolve') throw new Error('SECRET')
      return { type: 'oauth', access: c.id }
    }), { now: () => now, fetcher: async (url, opts) => {
      if (opts.headers.Authorization.endsWith('xai-0')) {
        if (failure === 'http') return { ok: false, status: 403, json: () => assert.fail('must not read error body') }
        if (failure === 'network') throw new Error('SECRET')
        if (failure === 'payload') return { ok: true, json: async () => ({ secret: 'SECRET' }) }
      }
      return { ok: true, json: async () => url === GROK_SETTINGS ? {} : billing(0) }
    } })
    assert.ok(report.accounts[0].error)
    assert.equal(report.accounts[1].windows[0].remaining, 100)
    assert.doesNotMatch(JSON.stringify(report), /SECRET/)
  }
})

test('Grok optional settings failure preserves quota and unknown plan; missing OAuth never fetched', async () => {
  const report = await collectUsage(ctx([integration('xai', ['oauth'])]), { now: () => now, fetcher: async (url) => {
    if (url === GROK_SETTINGS) throw new Error('SECRET')
    return { ok: true, json: async () => billing(12) }
  } })
  assert.equal(report.accounts[0].plan, 'desconocido')
  assert.equal(report.accounts[0].windows[0].remaining, 88)
  const absent = await collectUsage(ctx([integration('xai', ['oauth'])], async () => ({ type: 'key', key: 'SECRET' })), {
    fetcher: () => assert.fail('API key must not be sent to subscription endpoint'),
  })
  assert.ok(absent.accounts[0].error)
})

test('Grok billing timeout is bounded and optional settings timeout preserves quota', async () => {
  for (const stalled of [GROK_BILLING, GROK_SETTINGS]) {
    const report = await collectUsage(ctx([integration('xai', ['oauth'])]), { timeout: 40, now: () => now,
      fetcher: async (url) => url === stalled ? new Promise(() => {}) : { ok: true, json: async () => billing(12) } })
    if (stalled === GROK_BILLING) assert.ok(report.accounts[0].error)
    else {
      assert.equal(report.accounts[0].error, undefined)
      assert.equal(report.accounts[0].windows[0].remaining, 88)
      assert.equal(report.accounts[0].plan, 'desconocido')
    }
  }
})
