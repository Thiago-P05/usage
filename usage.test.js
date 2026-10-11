import test from 'node:test'
import assert from 'node:assert/strict'
import { collectUsage, formatUsage, normalizeQuota, ENDPOINT } from './usage.js'

const NOW = 1800000000000
const window = (seconds, used = 25) => ({ limit_window_seconds: seconds, used_percent: used, reset_at: NOW / 1000 + 3600 })
const connections = [1, 2, 3].map((i) => ({ type: 'credential', id: `fixture-${i}`, label: `private-${i}@example.invalid`, method: 'oauth' }))
function context(resolve = async (connection) => ({ type: 'oauth', access: `SECRET-${connection.id}`, refresh: 'REFRESH-SECRET', metadata: { accountID: `PERSONAL-${connection.id}` } })) {
  return { integration: {
    list: async () => ({ data: [{ id: 'openai', connections }] }),
    connection: { resolve, active: () => { throw new Error('must not access active') } },
  } }
}
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body })

test('raw percentages 0/12/88/100 map to remaining and reset seconds map to milliseconds', () => {
  for (const used of [0, 12, 88, 100]) {
    const quota = normalizeQuota({ rate_limit: {
      primary_window: window(18000, used), secondary_window: window(604800, used),
    } }, NOW)
    assert.deepEqual(quota.windows.map((w) => w.remaining), [100 - used, 100 - used])
    assert.deepEqual(quota.windows.map((w) => w.seconds), [18000, 604800])
    assert.ok(quota.windows.every((w) => w.reset === NOW + 3600000))
  }
})

test('each resolved credential pairs its own bearer/account header and isolated quota', async () => {
  const report = await collectUsage(context(), { now: () => NOW, fetcher: async (_, opts) => {
    const id = opts.headers['ChatGPT-Account-Id']
    const index = Number(id.slice(-1))
    assert.equal(opts.headers.Authorization, `Bearer SECRET-fixture-${index}`)
    assert.equal(id, `PERSONAL-fixture-${index}`)
    return response({ plan_type: 'plus', rate_limit: {
      primary_window: { ...window(18000, index * 12), reset_at: NOW / 1000 + index * 60 },
    } })
  } })
  assert.deepEqual(report.accounts.map((a) => a.windows[0].remaining), [88, 76, 64])
  assert.deepEqual(report.accounts.map((a) => a.windows[0].reset), [NOW + 60000, NOW + 120000, NOW + 180000])
})

test('three accounts: native resolve each, Plus 5h/week, reported distinct windows, no secrets', async () => {
  const seen = []
  const report = await collectUsage(context(), { now: () => NOW, fetcher: async (url, options) => {
    assert.equal(url, ENDPOINT)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal)
    seen.push(options.headers['ChatGPT-Account-Id'])
    const seconds = seen.length === 2 ? 3600 : 18000
    return response({ plan_type: 'plus', rate_limit: { primary_window: window(seconds), secondary_window: window(604800, 60) } })
  } })
  assert.equal(report.accounts.length, 3)
  assert.equal(new Set(seen).size, 3)
  assert.equal(new Set(report.accounts.map((a) => a.name)).size, 3)
  assert.ok(report.accounts.every((a) => a.plan === 'plus'))
  const text = formatUsage(report, NOW)
  assert.match(text, /5h: usado 25% · restante 75%/)
  assert.match(text, /1 semana\(s\): usado 60% · restante 40%/)
  assert.match(text, /1h:/)
  assert.match(text, /Ventana 5h Plus: no reportada/)
  assert.match(text, /reinicio .*Z \(en 60 min\)/)
  assert.deepEqual(report.accounts.map((a) => a.label), connections.map((c) => c.label))
  assert.match(text, /private-1@example.invalid/)
  assert.doesNotMatch(JSON.stringify(report) + text, /SECRET|PERSONAL|fixture-/)
})

test('missing plan/windows/percent/reset explicit, zero percent retained, no 5h inference', () => {
  const quota = normalizeQuota({ rate_limit: { primary_window: { used_percent: 0 }, secondary_window: {} } }, NOW)
  assert.equal(quota.plan, 'desconocido')
  assert.equal(quota.windows[0].remaining, 100)
  assert.equal(quota.windows[0].seconds, null)
  const text = formatUsage({ accounts: [{ name: 'Cuenta mock', provider: 'openai', ...quota }] }, NOW)
  assert.match(text, /duración desconocida/)
  assert.match(text, /reinicio desconocido/)
  assert.match(text, /usado desconocido · restante desconocido/)
  assert.doesNotMatch(text, /5h:/)
})

test('HTTP error isolated; provider body and arbitrary fields never displayed', async () => {
  const report = await collectUsage(context(), { fetcher: async (_, opts) => {
    if (opts.headers['ChatGPT-Account-Id'].endsWith('2')) return response({ secret: 'SECRET-BODY' }, 401)
    return response({ plan_type: 'plus', rate_limit: { primary_window: window(18000) }, secret: 'SECRET-BODY' })
  } })
  assert.equal(report.accounts.filter((a) => a.error).length, 1)
  assert.equal(report.accounts.filter((a) => a.windows.length === 1).length, 2)
  assert.match(formatUsage(report), /HTTP 401/)
  assert.doesNotMatch(JSON.stringify(report), /SECRET/)
})

test('native resolver failure isolated; raw exception redacted', async () => {
  const report = await collectUsage(context(async (c) => {
    if (c.id === 'fixture-2') throw new Error('SECRET-OAUTH')
    return { type: 'oauth', access: `SECRET-${c.id}`, metadata: { accountID: `PERSONAL-${c.id}` } }
  }), { fetcher: async () => response({ plan_type: 'plus' }) })
  assert.equal(report.accounts.filter((a) => a.error).length, 1)
  assert.doesNotMatch(JSON.stringify(report), /SECRET|PERSONAL/)
})

test('absent credentials/account metadata and unsupported connections do not fetch', async () => {
  let fetches = 0
  const report = await collectUsage(context(async (c) => c.id.endsWith('1') ? undefined : { type: 'oauth', access: 'SECRET' }), {
    fetcher: async () => { fetches++; throw new Error('unexpected') },
  })
  assert.equal(fetches, 0)
  assert.equal(report.accounts.filter((a) => a.error).length, 3)
  const ctx = context()
  ctx.integration.list = async () => ({ data: [{ id: 'xai', connections: [{ ...connections[0], method: 'key' }] }] })
  const unsupported = await collectUsage(ctx, { fetcher: async () => { throw new Error('unexpected') } })
  assert.match(unsupported.accounts[0].error, /sin suscripción Codex/)
})

test('additional, code review and unknown plan safely normalized; durations never invented', () => {
  const quota = normalizeQuota({ plan_type: 'SECRET-PLAN', code_review_rate_limit: { primary_window: window(86400) },
    additional_rate_limits: [{ limit_name: 'SECRET-NAME', rate_limit: { primary_window: window(7200) } }],
    rate_limit: { primary_window: { used_percent: 150, reset_after_seconds: 60 }, secondary_window: { used_percent: '20', limit_window_seconds: -1 } },
  }, NOW)
  assert.equal(quota.windows.length, 4)
  assert.equal(quota.windows[0].used, null)
  assert.equal(quota.windows[0].reset, NOW + 60000)
  const text = formatUsage({ accounts: [{ name: 'mock', provider: 'openai', ...quota }] }, NOW)
  assert.match(text, /Revisión de código · principal · 1 día/)
  assert.match(text, /Límite adicional 1 · principal · 2h/)
  assert.doesNotMatch(text, /SECRET/)
})

test('invalid response, network error and stalled native resolve bounded per account', async () => {
  let count = 0
  const report = await collectUsage(context(), { timeout: 30, fetcher: async () => {
    count++
    if (count === 1) throw new Error('SECRET-NETWORK')
    if (count === 2) return response(null)
    return new Promise(() => {})
  } })
  assert.equal(report.accounts.filter((a) => a.error).length, 3)
  assert.doesNotMatch(formatUsage(report), /SECRET/)
  const stalled = await collectUsage(context(() => new Promise(() => {})), { timeout: 10 })
  assert.equal(stalled.accounts.filter((a) => a.error).length, 3)
})

test('list failure, no accounts and cancellation return explicit unknown', async () => {
  const ctx = context()
  ctx.integration.list = async () => { throw new Error('SECRET-LIST') }
  assert.match(formatUsage(await collectUsage(ctx)), /conexiones; cuotas desconocidas/)
  ctx.integration.list = async () => ({ data: [] })
  assert.match(formatUsage(await collectUsage(ctx)), /No hay cuentas conectadas/)
  const controller = new AbortController()
  controller.abort()
  assert.ok((await collectUsage(context(), { signal: controller.signal })).error)
})
