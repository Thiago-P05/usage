import { nativeLabel } from './labels.js'
import { accountIdentity, snapshotCredential, ambiguousIdentity } from './identity.js'
import { GROK_BILLING, GROK_SETTINGS, normalizeGrok, grokPlan } from './grok.js'

export const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'
const UNKNOWN = 'desconocido'
const PLANS = new Set(['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu', 'go', 'max', 'pro_lite', 'pro_standard', 'pro_max'])
const number = (v) => typeof v === 'number' && Number.isFinite(v)
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

async function bounded(operation, signal, timeout = 15000) {
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  if (combined.aborted) throw new Error('unavailable')
  let timer, abort
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new Error('unavailable'))
    combined.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => controller.abort(), timeout)
    if (combined.aborted) abort()
  })
  try {
    return await Promise.race([operation(combined), stopped])
  } finally {
    clearTimeout(timer)
    combined.removeEventListener('abort', abort)
  }
}

function windowInfo(kind, v, now) {
  const used = number(v?.used_percent) && v.used_percent >= 0 && v.used_percent <= 100 ? v.used_percent : null
  const seconds = number(v?.limit_window_seconds) && v.limit_window_seconds > 0 ? v.limit_window_seconds : null
  let reset = number(v?.reset_at) && v.reset_at > 0 ? v.reset_at * 1000 : null
  if (reset === null && number(v?.reset_after_seconds) && v.reset_after_seconds >= 0) reset = now + v.reset_after_seconds * 1000
  if (reset !== null && !Number.isFinite(new Date(reset).getTime())) reset = null
  return { kind, seconds, used, remaining: used === null ? null : 100 - used, reset }
}

export function normalizeQuota(payload, now = Date.now()) {
  if (!object(payload)) throw new Error('invalid payload')
  const plan = PLANS.has(payload.plan_type) ? payload.plan_type : UNKNOWN
  const windows = []
  function add(group, rate) {
    if (!object(rate)) return
    for (const key of ['primary_window', 'secondary_window']) {
      if (object(rate[key])) windows.push(windowInfo(`${group} · ${key === 'primary_window' ? 'principal' : 'secundaria'}`, rate[key], now))
    }
  }
  add('Codex', payload.rate_limit)
  add('Revisión de código', payload.code_review_rate_limit)
  if (Array.isArray(payload.additional_rate_limits)) {
    payload.additional_rate_limits.forEach((entry, i) => add(`Límite adicional ${i + 1}`, entry?.rate_limit))
  }
  return { plan, windows }
}

export async function collectUsage(ctx, { fetcher = fetch, now = Date.now, signal, timeout = 15000 } = {}) {
  let integrations
  try {
    const result = await bounded(() => ctx.integration.list(), signal, timeout)
    if (!Array.isArray(result?.data)) throw new Error('invalid integrations')
    integrations = result.data
  } catch {
    return { accounts: [], error: 'No se pudo listar conexiones; cuotas desconocidas.' }
  }
  const entries = integrations.flatMap((integration) => (integration.connections ?? []).map((connection) => ({ integration, connection })))
  // Resolve by native credential ID, snapshot before the next resolution, then
  // check collisions in resolved identities. A workspace ID alone is not a user.
  const resolved = []
  for (const { integration, connection } of entries) {
    let value
    if (integration.id === 'openai' && connection.method === 'oauth') {
      try { value = await bounded(async () => snapshotCredential(await ctx.integration.connection.resolve(Object.freeze({ ...connection }))), signal, timeout) } catch {}
    }
    resolved.push(value)
  }
  let compatibleNumber = 0
  const accounts = await Promise.all(entries.map(async ({ integration, connection }, index) => {
    const provider = /^[a-z0-9_-]{1,64}$/.test(integration.id) ? integration.id : 'otra integración'
    const compatible = ['openai', 'xai'].includes(integration.id) && connection.method === 'oauth'
    const label = nativeLabel(connection.label)
    const number = compatible ? ++compatibleNumber : index + 1
    const account = { name: label || `Cuenta ${number}`, label, provider, compatible, plan: UNKNOWN, windows: [] }
    if (!account.compatible) {
      return { ...account, error: 'Cuota no disponible: conexión sin suscripción Codex compatible.' }
    }
    let credential
    try {
      credential = integration.id === 'openai' ? resolved[index] : await bounded(() => ctx.integration.connection.resolve(connection), signal, timeout)
    } catch {
      return { ...account, error: 'No se pudo resolver la credencial mediante OpenCode; cuota desconocida.' }
    }
    if (credential?.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access) {
      return { ...account, error: 'Credencial OAuth ausente; cuota desconocida.' }
    }
    if (integration.id === 'xai') {
      try {
        const options = { method: 'GET', redirect: 'error',
          headers: { Authorization: `Bearer ${credential.access}`, 'x-xai-token-auth': 'xai-grok-cli', Accept: 'application/json' } }
        const quota = await bounded(async (requestSignal) => {
          const response = await fetcher(GROK_BILLING, { ...options, signal: requestSignal })
          if (!response.ok) return { ...account, error: `HTTP ${response.status}; cuota Grok desconocida.` }
          return { ...account, ...normalizeGrok(await response.json(), now()) }
        }, signal, timeout)
        if (quota.error) return quota
        // Separate optional budget: stalled settings must not discard fetched quota.
        try {
          quota.plan = await bounded(async (s) => {
            const settings = await fetcher(GROK_SETTINGS, { ...options, signal: s })
            return settings.ok ? grokPlan((await settings.json()).subscription_tier_display) : UNKNOWN
          }, signal, Math.min(timeout, 2000))
        } catch {}
        return quota
      } catch {
        return { ...account, error: 'Respuesta Grok inválida, timeout o error de red; cuota desconocida.' }
      } finally { credential = undefined }
    }
    const identity = accountIdentity(credential)
    if (identity.error) return { ...account, error: identity.error }
    const accountID = identity.account
    if (resolved.some((other, i) => i !== index && ambiguousIdentity(credential, other)))
      return { ...account, error: 'No se pudo verificar la cuota de esta conexión: resolución ambigua de identidad OAuth.' }
    try {
      return await bounded(async (requestSignal) => {
        const response = await fetcher(ENDPOINT, {
          method: 'GET',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${credential.access}`,
            'ChatGPT-Account-Id': accountID,
            Accept: 'application/json',
            'User-Agent': 'opencode-codex-usage/1.0',
          },
          signal: requestSignal,
        })
        if (!response.ok) {
          // Status only; never echo response bodies or request headers.
          return { ...account, error: `HTTP ${response.status}; cuota desconocida.` }
        }
        return { ...account, ...normalizeQuota(await response.json(), now()) }
      }, signal, timeout)
    } catch {
      return { ...account, error: 'Respuesta inválida, timeout o error de red; cuota desconocida.' }
    } finally { credential = undefined }
  }))
  return { accounts }
}

function duration(seconds) {
  if (seconds === null) return 'duración desconocida'
  if (seconds % 604800 === 0) return `${seconds / 604800} semana(s)`
  if (seconds % 86400 === 0) return `${seconds / 86400} día(s)`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds}s`
}

export function formatUsage(report, now = Date.now()) {
  if (report.error) return report.error
  if (!report.accounts.length) return 'No hay cuentas conectadas. Cuotas desconocidas.'
  const lines = ['Cuotas reportadas por el proveedor · etiquetas de conexión', 'Restante = 100 − porcentaje utilizado reportado. No representa tokens ni mensajes.']
  for (const account of report.accounts) {
    lines.push('', `${account.name} · ${account.provider} · plan: ${account.plan}`)
    if (account.error) lines.push(account.error)
    for (const w of account.windows) {
      const percent = (value) => value === null ? UNKNOWN : `${Number(value.toFixed(2))}%`
      const reset = w.reset === null ? UNKNOWN : `${new Date(w.reset).toISOString()} (${w.reset > now ? `en ${Math.ceil((w.reset - now) / 60000)} min` : 'fecha alcanzada; consultar de nuevo'})`
      lines.push(`${w.kind} · ${duration(w.seconds)}: usado ${percent(w.used)} · restante ${percent(w.remaining)} · reinicio ${reset}`)
    }
    if (!account.windows.length) lines.push('Consumo, restante y reinicio: desconocidos (sin ventanas reportadas).')
    if (account.plan === 'plus' && !account.windows.some((w) => w.seconds === 18000)) lines.push('Ventana 5h Plus: no reportada; consumo, restante y reinicio desconocidos.')
  }
  lines.push('', 'Sin límites inferidos por precio. Sin renovación propia ni cambio de cuenta activa.')
  return lines.join('\n')
}
