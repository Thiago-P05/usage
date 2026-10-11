import { Usage } from './rpc.js'
import { renderUsage } from './presentation.js'

export function mountUsageCommand(ctx, renderComponent) {
  // setup and slot callbacks do not own Keymap.Provider in v2.0.20.
  // The deferred child component is mounted by OpenTUI under that provider.
  function UsageKeymap() {
    setupUsageCommand(ctx, renderComponent)
    console.info('codex-usage.cli: keymap mounted')
    return null
  }
  return ctx.ui.slot({
    append: 'app',
    render: () => renderComponent(UsageKeymap, {}),
  })
}

// Kept independent of OpenTUI peers so command behavior can be tested in Node.
export function setupUsageCommand(ctx, jsx) {
    let running = false
    ctx.keymap.layer(() => ({
      mode: 'global',
      commands: [{
        id: 'local.codex-usage.show',
        title: 'Usage: cuotas de todas las cuentas',
        group: 'Cuentas',
        palette: true,
        slash: { name: 'usage' },
        run: async () => {
          if (running) return
          running = true
          try {
            const location = ctx.location ?? ctx.data.location.default()
            const result = await ctx.client.rpc(Usage).view({}, {
              location,
              signal: AbortSignal.timeout(45000),
            })
            ctx.ui.dialog.set({ size: 'large', centered: true })
            ctx.ui.dialog.show(() => renderUsage(result, jsx))
          } catch {
            // Never display raw RPC, OAuth or network errors: they may include secrets.
            await ctx.ui.dialog.alert({
              title: 'Codex',
              message: 'Cuotas desconocidas · reintentar',
            })
          } finally { running = false }
        },
      }],
    }))
}
