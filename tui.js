import { Plugin } from '@opencode/plugin/tui'
import { jsx } from '@opentui/solid/jsx-runtime'
import { mountUsageCommand } from './cli.js'

export default Plugin.define({
  id: 'local.codex-usage.cli',
  setup: (ctx) => mountUsageCommand(ctx, jsx),
})
