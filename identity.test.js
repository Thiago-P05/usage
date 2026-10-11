import test from 'node:test'
import assert from 'node:assert/strict'
import { collectUsage } from './usage.js'
import { auditIdentity } from './identity.js'
import { compactUsage } from './presentation.js'

const jwt = (id, nonce, sub = id) => `e30.${Buffer.from(JSON.stringify({ sub, 'https://api.openai.com/auth': { chatgpt_account_id: id }, nonce })).toString('base64url')}.signature`
const connections = [1, 2, 3].map((n) => ({ type: 'credential', id: `credential-${n}`, label: 'private', method: 'oauth' }))
function fixture(ids = ['A', 'B', 'C']) {
  const values = ids.map((id, i) => ({ type: 'oauth', methodID: 'chatgpt-browser', access: jwt(id, i), refresh: 'REFRESH-SECRET', expires: Date.now() + 3600000, metadata: { accountID: id } }))
  const seen = []
  // Installed V2 promise adapter forwards the ConnectionInfo itself, not
  // {connectionID}, {credentialID}, an integration ID, or an active lookup.
  const ctx = { integration: { list: async () => ({ data: [{ id: 'openai', connections }] }), connection: {
    active: async () => connections[0],
    resolve: async (connection) => {
      assert.equal(connection.type, 'credential')
      const index = connections.findIndex((c) => c.id === connection.id)
      assert.notEqual(index, -1)
      seen.push(index)
      return values[index]
    },
  } } }
  return { ctx, values, seen }
}

test('three native-shaped identities select isolated bearer/header and 100/100, 9/28, 100/63; no quota cache', async () => {
  const f = fixture()
  const expected = [[100, 100], [9, 28], [100, 63]]
  let requests = 0
  const fetcher = async (_, options) => {
    const i = ['A', 'B', 'C'].indexOf(options.headers['ChatGPT-Account-Id'])
    assert.notEqual(i, -1)
    assert.equal(options.headers.Authorization, `Bearer ${f.values[i].access}`)
    requests++
    return { ok: true, json: async () => ({ rate_limit: {
      primary_window: { used_percent: 100 - expected[i][0], limit_window_seconds: 18000, reset_after_seconds: (i + 1) * 60 },
      secondary_window: { used_percent: 100 - expected[i][1], limit_window_seconds: 604800, reset_after_seconds: (i + 1) * 86400 },
    } }) }
  }
  for (let round = 0; round < 2; round++) {
    const report = await collectUsage(f.ctx, { fetcher })
    assert.deepEqual(report.accounts.map((a) => a.windows.map((w) => w.remaining)), expected)
    assert.deepEqual(report.accounts.map((a) => a.label), ['private', 'private', 'private'])
    assert.doesNotMatch(JSON.stringify(report), /signature|credential-|REFRESH-SECRET/)
  }
  assert.equal(requests, 6)
  assert.deepEqual(f.seen, [0, 1, 2, 0, 1, 2])
})

test('same resolved subject and workspace remain ambiguous, without blaming saved accounts', async () => {
  const f = fixture(['B', 'B', 'C'])
  let requests = 0
  const report = await collectUsage(f.ctx, { fetcher: async (_, options) => {
    requests++
    assert.equal(options.headers['ChatGPT-Account-Id'], 'C')
    return { ok: true, json: async () => ({}) }
  } })
  assert.equal(requests, 1)
  assert.ok(report.accounts.slice(0, 2).every((a) => /ambigua/.test(a.error) && !a.windows.length))
  assert.ok(compactUsage(report).accounts.slice(0, 2).every((a) => a.error === 'No se pudo verificar la cuota de esta conexión'))
  const audit = JSON.parse(await auditIdentity(f.ctx))
  assert.equal(audit.pairs[0].subjectEqual, true)
  assert.equal(audit.pairs[0].ambiguous, true)
  assert.equal(audit.activeUnchanged, true)
  assert.doesNotMatch(JSON.stringify(audit), /signature|credential-|private/)
})

test('native connection reordering does not move duplicate identity checks to fixed row numbers', async () => {
  const f = fixture(['C', 'B', 'B'])
  let requests = 0
  const report = await collectUsage(f.ctx, { fetcher: async (_, options) => {
    requests++
    assert.equal(options.headers['ChatGPT-Account-Id'], 'C')
    assert.equal(options.headers.Authorization, `Bearer ${f.values[0].access}`)
    return { ok: true, json: async () => ({}) }
  } })
  assert.equal(requests, 1)
  assert.equal(report.accounts[0].error, undefined)
  assert.ok(report.accounts.slice(1).every((a) => /ambigua/.test(a.error) && !a.windows.length))
  const audit = JSON.parse(await auditIdentity(f.ctx))
  assert.equal(audit.pairs[2].subjectEqual, true)
  assert.equal(audit.pairs[2].ambiguous, true)
  assert.equal(audit.activeUnchanged, true)
})

test('metadata/claim mismatch and noncontract accountId fallback never query an ambiguous account', async () => {
  const f = fixture()
  f.values[0].metadata.accountID = 'wrong'
  delete f.values[1].metadata
  f.values[1].accountId = 'B'
  delete f.values[2].metadata
  f.values[2].credentialID = 'C'
  const report = await collectUsage(f.ctx, { fetcher: async () => assert.fail('ambiguous request') })
  assert.equal(report.accounts.filter((a) => a.error).length, 3)
  assert.match(report.accounts[0].error, /inconsistente/)
})

test('same workspace with different users queries each distinct bearer independently', async () => {
  const f = fixture(['W', 'W', 'W'])
  f.values.forEach((v, i) => { v.access = jwt('W', i, `user-${i}`) })
  const seen = []
  const report = await collectUsage(f.ctx, { fetcher: async (_, options) => {
    const i = f.values.findIndex((v) => `Bearer ${v.access}` === options.headers.Authorization)
    assert.notEqual(i, -1)
    assert.equal(options.headers['ChatGPT-Account-Id'], 'W')
    seen.push(i)
    return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: i * 20 } } }) }
  } })
  assert.deepEqual(seen, [0, 1, 2])
  assert.deepEqual(report.accounts.map((a) => a.windows[0].remaining), [100, 80, 60])
})

test('missing subject is unknown, not proof of duplicate workspace users', async () => {
  const f = fixture(['W', 'W', 'W'])
  f.values.forEach((v, i) => { v.access = jwt('W', i, null) })
  let calls = 0
  const report = await collectUsage(f.ctx, { fetcher: async () => {
    calls++
    return { ok: true, json: async () => ({}) }
  } })
  assert.equal(calls, 3)
  assert.ok(report.accounts.every((a) => !a.error))
})

test('sequential resolve snapshots isolate a shared mutable native return object', async () => {
  const f = fixture()
  const shared = { metadata: {} }
  f.ctx.integration.connection.resolve = async (connection) => {
    const i = connections.findIndex((c) => c.id === connection.id)
    Object.assign(shared, f.values[i], { metadata: shared.metadata })
    shared.metadata.accountID = f.values[i].metadata.accountID
    return shared
  }
  const report = await collectUsage(f.ctx, { fetcher: async (_, options) => {
    const i = f.values.findIndex((v) => `Bearer ${v.access}` === options.headers.Authorization)
    assert.notEqual(i, -1)
    assert.equal(options.headers['ChatGPT-Account-Id'], f.values[i].metadata.accountID)
    return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: i } } }) }
  } })
  assert.deepEqual(report.accounts.map((a) => a.windows[0].remaining), [100, 99, 98])
})

test('connection shape is validated by the official package schema', async () => {
  const { Connection } = await import('@opencode/schema/connection')
  const { Schema } = await import('effect')
  for (const c of connections) assert.deepEqual(Schema.decodeUnknownSync(Connection.Info)(c), c)
})
