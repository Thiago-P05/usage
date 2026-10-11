import { Plugin } from '@opencode/plugin'
import { Usage } from './rpc.js'
import { collectUsage, formatUsage } from './usage.js'
import { compactUsage } from './presentation.js'
import { auditIdentity } from './identity.js'

export default Plugin.define({
  id: 'local.codex-usage',
  async setup(ctx) {
    let pending
    const collect = (signal) => {
      pending ??= collectUsage(ctx, { signal }).finally(() => { pending = undefined })
      return pending
    }
    // V2 RPC requires an explicit events map, even when this port has no events.
    await ctx.rpc.register(Usage, {
      audit: async () => ({ text: await auditIdentity(ctx, { fetcher: fetch }) }),
      view: async (_input, { signal }) => compactUsage(await collect(signal)),
      read: async (_input, { signal }) => {
        // Concurrent invocations share a request, never cache quota or credentials.
        return { text: formatUsage(await collect(signal)) }
      },
    })
  },
})
