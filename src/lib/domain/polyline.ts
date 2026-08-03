export type LatLng = { lat: number; lng: number }

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI

/** Google Encoded Polyline Algorithm Format 解碼（純 TS，不依賴 maps geometry library——
 *  播放位置在 render body 計算，SSR 期間碰不到 google 全域，必須自己解）。 */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = []
  let index = 0
  let lat = 0
  let lng = 0
  while (index < encoded.length) {
    for (const axis of ['lat', 'lng'] as const) {
      let result = 0
      let shift = 0
      let byte = 0x20
      while (byte >= 0x20) {
        byte = encoded.charCodeAt(index++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      }
      const delta = result & 1 ? ~(result >> 1) : result >> 1
      if (axis === 'lat') lat += delta
      else lng += delta
    }
    points.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }
  return points
}

/** 兩點間大圓弧線取樣（slerp）：flight 段的弧線與飛機位置共用同一條路徑，畫的線與動的點不會錯位。 */
export function greatCirclePoints(from: LatLng, to: LatLng, steps = 64): LatLng[] {
  const p1 = toRad(from.lat)
  const l1 = toRad(from.lng)
  const p2 = toRad(to.lat)
  const l2 = toRad(to.lng)
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2
  const delta = 2 * Math.asin(Math.min(1, Math.sqrt(a)))
  if (delta === 0) return [from, to]
  const sinDelta = Math.sin(delta)
  const pts: LatLng[] = []
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    const A = Math.sin((1 - f) * delta) / sinDelta
    const B = Math.sin(f * delta) / sinDelta
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2)
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2)
    const z = A * Math.sin(p1) + B * Math.sin(p2)
    pts.push({ lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lng: toDeg(Math.atan2(y, x)) })
  }
  return pts
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function bearingDeg(a: LatLng, b: LatLng): number {
  const p1 = toRad(a.lat)
  const p2 = toRad(b.lat)
  const dl = toRad(b.lng - a.lng)
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/** 依累計距離找 fraction 對應的位置與行進方位角（0=北、90=東）。fraction 界外夾回 [0,1]。 */
export function pathPosition(path: LatLng[], fraction: number): (LatLng & { headingDeg: number }) | null {
  if (path.length === 0) return null
  if (path.length === 1) return { ...path[0], headingDeg: 0 }
  const f = Math.min(1, Math.max(0, fraction))
  const segLens = path.slice(1).map((p, i) => haversineMeters(path[i], p))
  const total = segLens.reduce((s, v) => s + v, 0)
  if (total === 0) return { ...path[0], headingDeg: 0 }
  let remain = f * total
  for (let i = 0; i < segLens.length; i++) {
    if (remain <= segLens[i] || i === segLens.length - 1) {
      const r = segLens[i] === 0 ? 0 : Math.min(1, remain / segLens[i])
      const a = path[i]
      const b = path[i + 1]
      return {
        lat: a.lat + (b.lat - a.lat) * r,
        lng: a.lng + (b.lng - a.lng) * r,
        headingDeg: bearingDeg(a, b),
      }
    }
    remain -= segLens[i]
  }
  return { ...path[path.length - 1], headingDeg: bearingDeg(path[path.length - 2], path[path.length - 1]) }
}

/** 已走過的部分路徑（含內插的目前點）：漸進紅線的 path。 */
export function pathSlice(path: LatLng[], fraction: number): LatLng[] {
  if (path.length === 0) return []
  const f = Math.min(1, Math.max(0, fraction))
  if (f === 0) return [path[0]]
  if (f === 1) return [...path]
  const segLens = path.slice(1).map((p, i) => haversineMeters(path[i], p))
  const total = segLens.reduce((s, v) => s + v, 0)
  if (total === 0) return [path[0]]
  let remain = f * total
  const out: LatLng[] = [path[0]]
  for (let i = 0; i < segLens.length; i++) {
    if (remain <= segLens[i]) {
      const r = segLens[i] === 0 ? 0 : remain / segLens[i]
      const a = path[i]
      const b = path[i + 1]
      out.push({ lat: a.lat + (b.lat - a.lat) * r, lng: a.lng + (b.lng - a.lng) * r })
      return out
    }
    out.push(path[i + 1])
    remain -= segLens[i]
  }
  return out
}
