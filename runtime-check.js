import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { nativeLabel } from './labels.js'

// Windows API smoke check; no direct auth files, DB access or service restart.
// execFile preserves JSON argument quoting independently of PowerShell versions.
const execute = promisify(execFile)
const executable = path.join(process.env.APPDATA, 'npm/node_modules/@opencode/cli/bin/opencode.exe')
const directory = path.join(os.homedir(), '.config/opencode/plugins')
async function api(method, route, body) {
  const args = ['api', method, route]
  if (body) args.push('--data', JSON.stringify(body))
  try {
    const result = await execute(executable, args, { cwd: directory, maxBuffer: 1024 * 1024, windowsHide: true, timeout: 45000 })
    return JSON.parse(result.stdout)
  } catch (error) {
    // Only controlled protocol categories; never print stderr or credential metadata.
    let category = 'unavailable'
    try {
      const response = JSON.parse(error.stdout)
      if (['RpcInternalError', 'RpcError', 'InvalidRequestError', 'UnauthorizedError'].includes(response._tag)) category = response._tag
    } catch {}
    throw new Error(category)
  }
}

try {
  if (process.argv.includes('--labels')) {
    const integrations = await api('get', '/api/integration')
    const expected = integrations.data.flatMap((i) => (i.connections ?? [])
      .filter((c) => ['openai', 'xai'].includes(i.id) && c.method === 'oauth')
      .map((c) => ({ label: nativeLabel(c.label), provider: i.id })))
    const result = await api('post', '/api/rpc/local.codex-usage/view', { input: {} })
    if (!Array.isArray(result.output?.accounts)) throw new Error('invalid output')
    const rows = result.output.accounts.map((a, i) => ({ number: i + 1,
      nativeLabelPresent: Boolean(expected[i]?.label),
      labelPreserved: a.title.startsWith(`${expected[i]?.label || `Cuenta ${i + 1}`} · `),
      fallbackCuentaN: a.title.startsWith(`Cuenta ${i + 1} · `) }))
    console.log(JSON.stringify({ countMatches: rows.length === expected.length, rows }))
    if (rows.length !== expected.length || rows.some((r) => !r.labelPreserved)) process.exitCode = 1
  } else {
  if (process.argv.includes('--audit')) {
    const result = await api('post', '/api/rpc/local.codex-usage/audit', { input: {} })
    if (typeof result.output?.text !== 'string') throw new Error('invalid output')
    console.log(result.output.text)
    process.exit(0)
  }
  const plugins = await api('get', '/api/plugin')
  const plugin = plugins.data.find((p) => p.id === 'local.codex-usage')
  console.log(`Plugin runtime: ${plugin?.state?.status ?? 'not discovered'}`)
  const compact = process.argv.includes('--compact')
  const result = await api('post', `/api/rpc/local.codex-usage/${compact ? 'view' : 'read'}`, { input: {} })
  if (compact) {
    if (!Array.isArray(result.output?.accounts)) throw new Error('invalid output')
    console.log(JSON.stringify({ compactAccounts: result.output.accounts.length,
      headings: result.output.accounts.map((a) => a.title),
      windowsPerAccount: result.output.accounts.map((a) => a.windows.length),
      errors: result.output.accounts.filter((a) => a.error).length,
      identityUnverifiedRows: result.output.accounts.map((a) => a.error === 'No se pudo verificar la cuota de esta conexión') }))
  } else {
    if (typeof result.output?.text !== 'string') throw new Error('invalid output')
    console.log(result.output.text)
  }
  const after = await api('get', '/api/integration')
  const current = after.data.find((p) => p.id === 'openai')
  // HTTP integration.list does not promise that connections[0] is active.
  // Native active('openai') belongs to the server plugin context, not this CLI.
  console.log(JSON.stringify({ openaiCount: current?.connections.length, activeAccountCheck: 'not verified' }))
  }
} catch (error) {
  console.log(`Runtime check failed: ${error.message}`)
  process.exitCode = 1
}
