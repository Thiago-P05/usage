import test from 'node:test'
import assert from 'node:assert/strict'
import { compactUsage, humanTime, remainingLabel, renderUsage } from './presentation.js'

const now = 1800000000000
const window = (remaining, seconds = 18000) => ({ kind: 'Codex · principal', seconds, remaining, reset: now + seconds * 1000 })
const account = (windows = [window(100)]) => ({ compatible: true, plan: 'plus', windows, name: 'HASH-SECRET', provider: 'openai' })
const jsx = (type, props) => ({ type, props })
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  const children = tree.props?.children
  return [tree, ...(Array.isArray(children) ? children : [children]).flatMap(nodes)]
}

test('compact report: three Codex accounts only, numbered Plus headings, all real windows', () => {
  const view = compactUsage({ accounts: [account([window(100), window(12, 604800)]),
    { ...account(), compatible: false, provider: 'opencode-go' }, account(),
    { ...account(), compatible: false, provider: 'xai' }, account()] }, now)
  assert.deepEqual(view.accounts.map((a) => a.title), ['Cuenta 1 · Plus', 'Cuenta 2 · Plus', 'Cuenta 3 · Plus'])
  assert.equal(view.accounts[0].windows[0].title, 'Límite de 5 horas')
  assert.equal(view.accounts[0].windows[1].title, 'Límite semanal')
  assert.equal(view.accounts[0].windows[0].reset, 'Se restablece en 5 h 0 min')
  assert.equal(view.accounts[0].windows[1].reset, 'Se restablece en 7 d 0 h')
  assert.doesNotMatch(JSON.stringify(view), /HASH|SECRET|openai|opencode-go|xai|principal|secundaria|tokens|2027-/)
})

test('real OpenTUI primitives: remaining bars 0/12/100/unknown, right-aligned values', () => {
  const view = compactUsage({ accounts: [account([window(0), window(12), window(100), window(null)])] }, now)
  const tree = renderUsage(view, jsx)
  const all = nodes(tree)
  const tracks = all.filter((n) => n.props?.backgroundColor === '#383838')
  assert.equal(tracks.length, 4)
  assert.equal(tracks[0].props.children, null)
  assert.equal(tracks[1].props.children.props.width, '12%')
  assert.equal(tracks[2].props.children.props.width, '100%')
  assert.equal(tracks[3].props.children.type, 'text')
  assert.equal(tracks[3].props.children.props.children, '—')
  assert.ok(tracks.every((n) => n.props.width === '100%'))
  assert.equal(all.filter((n) => n.props?.justifyContent === 'space-between').length, 4)
  assert.equal(remainingLabel(0), '0 % restante')
  assert.equal(remainingLabel(12), '12 % restante')
  assert.equal(remainingLabel(100), '100 % restante')
  assert.equal(remainingLabel(null), 'Restante desconocido')
})

test('human times, unavailable percentage/reset, unknown plan and short Codex errors', () => {
  assert.equal(humanTime(300), '0 h 5 min')
  assert.equal(humanTime(3660), '1 h 1 min')
  assert.equal(humanTime(604800), '7 d 0 h')
  const view = compactUsage({ accounts: [{ ...account([{ ...window(NaN), reset: null }]), plan: 'desconocido' },
    { ...account([]), error: 'HTTP 401; SECRET' }] }, now)
  assert.equal(view.accounts[0].title, 'Cuenta 1 · Plan desconocido')
  assert.equal(view.accounts[0].windows[0].remaining, null)
  assert.equal(view.accounts[0].windows[0].reset, 'Reinicio desconocido')
  assert.equal(view.accounts[1].error, 'Cuota no disponible · HTTP 401')
  assert.doesNotMatch(JSON.stringify(view), /SECRET/)
})

test('identity errors stay neutral without exposing diagnostic secrets or blaming the user', () => {
  const view = compactUsage({ accounts: [
    { ...account([]), error: 'Conexiones OAuth duplicadas: SECRET' },
    { ...account([]), error: 'Identidad OAuth inconsistente; SECRET' },
  ] }, now)
  assert.deepEqual(view.accounts.map((a) => a.error), [
    'No se pudo verificar la cuota de esta conexión',
    'No se pudo verificar la cuota de esta conexión',
  ])
  assert.doesNotMatch(JSON.stringify(view), /SECRET|auth\.json|token|accountID/)
})

test('other reported durations/features retained; no invented Plus five-hour window', () => {
  const view = compactUsage({ accounts: [account([{ ...window(88, 3600), kind: 'Revisión de código · secundaria' },
    { ...window(90, 7200), kind: 'Límite adicional 1 · principal' }])] }, now)
  assert.equal(view.accounts[0].windows.length, 2)
  assert.match(view.accounts[0].windows[0].title, /Revisión de código · límite de 1 h 0 min/)
  assert.match(view.accounts[0].windows[1].title, /Límite adicional 1 · límite de 2 h 0 min/)
  assert.doesNotMatch(JSON.stringify(view), /5 horas/)
})

test('missing or invalid resets stay explicitly unknown; expired reset never invents time', () => {
  const resets = [undefined, null, NaN, Infinity, '2027-01-01', now - 1]
  const view = compactUsage({ accounts: [account(resets.map((reset) => ({ ...window(12), reset })))] }, now)
  assert.deepEqual(view.accounts[0].windows.map((w) => w.reset), [
    ...Array(5).fill('Reinicio desconocido'), 'Consultar nuevo reinicio',
  ])
  assert.doesNotMatch(JSON.stringify(view), /NaN|Infinity|2027-/)
})

test('invalid remaining never renders a misleading filled bar', () => {
  const view = compactUsage({ accounts: [account([-1, 101, undefined, Infinity, '100'].map((value) => window(value)))] }, now)
  assert.ok(view.accounts[0].windows.every((w) => w.remaining === null))
  const tracks = nodes(renderUsage(view, jsx)).filter((n) => n.props?.backgroundColor === '#383838')
  assert.equal(tracks.length, 5)
  assert.ok(tracks.every((track) => track.props.children.type === 'text'))
})
