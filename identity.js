// Claims are inspected only in memory, never returned or logged. This is an
// identity consistency check, not JWT authentication or a token refresh.
function claimsOf(access) {
  try {
    const parts = access.split('.')
    if (parts.length !== 3) return undefined
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return claims
  } catch { return undefined }
}

export function tokenAccount(access) {
  const claims = claimsOf(access)
  return claims?.chatgpt_account_id ?? claims?.['https://api.openai.com/auth']?.chatgpt_account_id
}

export function tokenSubject(access) {
  const sub = claimsOf(access)?.sub
  return typeof sub === 'string' && sub ? sub : undefined
}

export function snapshotCredential(value) {
  if (!value) return undefined
  // Copy immediately, before another native resolve can mutate a shared object.
  return Object.freeze({ type: value.type, access: value.access,
    metadata: Object.freeze({ accountID: value.metadata?.accountID }) })
}

export function ambiguousIdentity(value, other) {
  if (!value || !other) return false
  if (typeof value.access === 'string' && value.access && value.access === other.access) return true
  const a = tokenSubject(value.access), b = tokenSubject(other.access)
  return a !== undefined && a === b && value.metadata?.accountID === other.metadata?.accountID
}

export function accountIdentity(credential) {
  const account = credential?.metadata?.accountID
  if (typeof account !== 'string' || !account || /[\r\n]/.test(account)) return { error: 'Identificador de cuenta ausente; no se consultó una cuenta ambigua.' }
  const claim = tokenAccount(credential.access)
  const claims = claimsOf(credential.access)
  if (claims?.chatgpt_account_id !== undefined && claims?.['https://api.openai.com/auth']?.chatgpt_account_id !== undefined && claims.chatgpt_account_id !== claims['https://api.openai.com/auth'].chatgpt_account_id) return { error: 'Identidad OAuth inconsistente; no se consultó una cuenta ambigua.' }
  if (claim !== undefined && claim !== account) return { error: 'Identidad OAuth inconsistente; no se consultó una cuenta ambigua.' }
  return { account, claim, subject: tokenSubject(credential.access) }
}

export async function auditIdentity(ctx, { fetcher } = {}) {
  const connections = (await ctx.integration.list()).data.find((i) => i.id === 'openai')?.connections.filter((c) => c.method === 'oauth') ?? []
  const activeBefore = await ctx.integration.connection.active('openai')
  const values = [], references = []
  for (const c of connections) {
    const value = await ctx.integration.connection.resolve(Object.freeze({ ...c }))
    references.push(value)
    values.push(snapshotCredential(value))
  }
  const stable = Array(values.length).fill(false)
  // Reverse order separates ID-specific resolution from last-resolved/cache state.
  for (let i = connections.length - 1; i >= 0; i--) {
    const again = snapshotCredential(await ctx.integration.connection.resolve(Object.freeze({ ...connections[i] })))
    stable[i] = again?.metadata?.accountID === values[i]?.metadata?.accountID && tokenSubject(again?.access) === tokenSubject(values[i]?.access)
  }
  const pairs = []
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const a = values[i], b = values[j]
      pairs.push({ accounts: [i + 1, j + 1], connectionEqual: connections[i].id === connections[j].id,
        tokenEqual: typeof a?.access === 'string' && a.access === b?.access,
        accountEqual: typeof a?.metadata?.accountID === 'string' && a.metadata.accountID === b?.metadata?.accountID,
        claimEqual: typeof tokenAccount(a?.access ?? '') === 'string' && tokenAccount(a.access) === tokenAccount(b?.access ?? ''),
        subjectKnown: tokenSubject(a?.access) !== undefined && tokenSubject(b?.access) !== undefined,
        subjectEqual: tokenSubject(a?.access) !== undefined && tokenSubject(a.access) === tokenSubject(b?.access),
        sharedReference: references[i] !== undefined && references[i] === references[j],
        ambiguous: ambiguousIdentity(a, b) })
    }
  }
  const activeAfter = await ctx.integration.connection.active('openai')
  const quotas = fetcher ? await Promise.all(values.map(async (v, i) => {
    const identity = accountIdentity(v)
    if (identity.error || values.some((other, j) => j !== i && ambiguousIdentity(v, other))) return { number: i + 1, error: 'identity unavailable' }
    try {
      const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${v.access}`, 'ChatGPT-Account-Id': identity.account, Accept: 'application/json' },
      })
      if (!response.ok) return { number: i + 1, status: response.status }
      const rate = (await response.json()).rate_limit
      const numeric = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null
      return { number: i + 1, windows: ['primary_window', 'secondary_window'].map((key) => ({
        used_percent: numeric(rate?.[key]?.used_percent), limit_window_seconds: numeric(rate?.[key]?.limit_window_seconds),
        reset_at: numeric(rate?.[key]?.reset_at), reset_after_seconds: numeric(rate?.[key]?.reset_after_seconds),
      })) }
    } catch { return { number: i + 1, error: 'quota unavailable' } }
  })) : undefined
  return JSON.stringify({ count: connections.length, activeUnchanged: activeBefore?.id === activeAfter?.id,
    accounts: values.map((v, i) => ({ number: i + 1, oauth: v?.type === 'oauth', subjectPresent: tokenSubject(v?.access) !== undefined, claimPresent: typeof tokenAccount(v?.access ?? '') === 'string', coherent: !accountIdentity(v).error, stableIdentityAcrossReverseResolve: stable[i] })), pairs, quotas })
}
