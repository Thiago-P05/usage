import { Rpc } from '@opencode/plugin/rpc'

export const Usage = Rpc.define({
  id: 'local.codex-usage',
  events: {},
  methods: {
    audit: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    },
    view: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object', additionalProperties: false, required: ['accounts', 'message'],
        properties: {
          message: { type: 'string' },
          accounts: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['title', 'error', 'windows'],
            properties: {
              title: { type: 'string' }, error: { type: ['string', 'null'] },
              windows: { type: 'array', items: {
                type: 'object', additionalProperties: false, required: ['title', 'reset', 'remaining'],
                properties: { title: { type: 'string' }, reset: { type: 'string' }, remaining: { type: ['number', 'null'], minimum: 0, maximum: 100 } },
              } },
            },
          } },
        },
      },
    },
    read: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
})
