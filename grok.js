export const GROK_BILLING = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
export const GROK_SETTINGS = 'https://cli-chat-proxy.grok.com/v1/settings'
const plans = new Set(['SuperGrok', 'SuperGrok Heavy', 'X Premium', 'X Premium+'])
export function grokPlan(value) {
  return plans.has(value) ? value : 'desconocido'
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

// Only the explicit subscription pool percent, never API spend or on-demand caps.
export function normalizeGrok(payload, now = Date.now()) {
  const config = payload?.config
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid payload')
  const used = typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)
    && config.creditUsagePercent >= 0 && config.creditUsagePercent <= 100 ? config.creditUsagePercent : null
  const currentEnd = timestamp(config.currentPeriod?.end)
  const reset = currentEnd ?? timestamp(config.billingPeriodEnd)
  const start = timestamp(currentEnd === null ? config.billingPeriodStart : config.currentPeriod?.start)
  const seconds = start !== null && reset !== null && reset > start && start <= now ? (reset - start) / 1000 : null
  return { plan: 'desconocido', windows: [{ kind: 'Grok', used, remaining: used === null ? null : 100 - used, reset, seconds }] }
}
