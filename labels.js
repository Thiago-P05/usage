// Only the native stored connection label; never infer a name from auth data.
export function nativeLabel(value) {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim()
  const points = Array.from(clean)
  return points.length > 80 ? points.slice(0, 79).join('') + '…' : clean
}
