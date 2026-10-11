// Presentation only: never receives or returns credentials, IDs or token claims.
import { nativeLabel } from './labels.js'
export function humanTime(seconds) {
  const minutes = Math.max(0, Math.ceil(seconds / 60))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  return days ? `${days} d ${hours} h${rest ? ` ${rest} min` : ''}` : `${hours} h ${rest} min`
}

function label(window) {
  const duration = window.seconds
  const title = duration === 18000 ? 'Límite de 5 horas'
    : duration === 604800 ? 'Límite semanal'
    : duration > 0 ? `Límite de ${humanTime(duration)}` : 'Límite'
  // Preserve useful feature distinctions without the principal/secundaria jargon.
  if (window.kind.startsWith('Revisión de código')) return `Revisión de código · ${title.toLowerCase()}`
  if (window.kind.startsWith('Límite adicional')) return `${window.kind.split(' · ')[0]} · ${title.toLowerCase()}`
  return title
}

function shortError(error) {
  if (/Conexiones OAuth duplicadas|resolución ambigua|Identidad OAuth inconsistente/.test(error ?? '')) return 'No se pudo verificar la cuota de esta conexión'
  const status = /^HTTP (\d{3})/.exec(error ?? '')
  if (status) return `Cuota no disponible · HTTP ${status[1]}`
  if (/credencial|Identificador/.test(error ?? '')) return 'Cuenta no disponible'
  return 'Cuota no disponible · reintentar'
}

export function compactUsage(report, now = Date.now()) {
  if (report.error) return { accounts: [], message: 'No se pudieron consultar las cuentas' }
  const accounts = report.accounts.filter((account) => account.compatible).map((account, i) => ({
    title: `${nativeLabel(account.label) || `Cuenta ${i + 1}`} · ${account.provider === 'xai' ? 'Grok · ' : ''}${account.plan === 'desconocido' ? 'Plan desconocido' : account.plan[0].toUpperCase() + account.plan.slice(1)}`,
    error: account.error ? shortError(account.error) : null,
    windows: account.windows.map((window) => ({
      title: label(window),
      reset: typeof window.reset !== 'number' || !Number.isFinite(window.reset) ? 'Reinicio desconocido'
        : window.reset <= now ? 'Consultar nuevo reinicio' : `Se restablece en ${humanTime((window.reset - now) / 1000)}`,
      remaining: typeof window.remaining === 'number' && Number.isFinite(window.remaining) && window.remaining >= 0 && window.remaining <= 100 ? window.remaining : null,
    })),
  }))
  return { accounts, message: accounts.length ? '' : 'No hay cuentas Codex/Grok compatibles' }
}

export function remainingLabel(value) {
  return value === null ? 'Restante desconocido' : `${Number(value.toFixed(2))} % restante`
}

export function renderUsage(view, jsx) {
  const text = (value, muted = false) => jsx('text', { fg: muted ? '#a0a0a0' : '#eeeeee', children: value })
  const windowBlock = (window) => jsx('box', {
    width: '100%', flexDirection: 'column', gap: 0,
    children: [
      text(window.title),
      jsx('box', { width: '100%', flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap',
        children: [text(window.reset, true), text(remainingLabel(window.remaining))] }),
      jsx('box', { width: '100%', height: 1, backgroundColor: '#383838',
        children: window.remaining === null ? text('—', true)
          : window.remaining === 0 ? null
          : jsx('box', { width: `${window.remaining}%`, height: 1, backgroundColor: '#eeeeee' }) }),
    ],
  })
  return jsx('box', {
    width: '100%', flexDirection: 'column', paddingLeft: 1, paddingRight: 1, paddingBottom: 1,
    children: [
      jsx('scrollbox', { width: '100%', maxHeight: 24, scrollY: true,
        children: view.accounts.length ? view.accounts.map((account) => jsx('box', {
          width: '100%', flexDirection: 'column', gap: 1, marginBottom: 1,
          children: [text(account.title), ...(account.error ? [text(account.error, true)] : []),
            ...account.windows.map(windowBlock),
            ...(!account.error && !account.windows.length ? [text('Cuota desconocida', true)] : [])],
        })) : text(view.message, true) }),
      text('Esc · cerrar', true),
    ],
  })
}
