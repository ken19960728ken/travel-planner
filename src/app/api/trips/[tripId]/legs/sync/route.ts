import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { planLegSync, type SyncStop, type SyncLeg } from '@/lib/domain/legSync'
import { buildRouteCacheKey, type RouteQuery } from '@/lib/domain/cacheKey'
import {
  buildComputeRoutesRequest, parseComputeRoutesResponse, clampTransitDeparture,
} from '@/lib/google/routes'
import { takeToken, type RateWindow } from '@/lib/domain/rateLimit'

// 逾時保護（審查 M-6）：Vercel function 上限 30 秒，與單次 fetch 5 秒 timeout、每次 sync 最多
// MAX_GOOGLE_CALLS_PER_SYNC 段的分批機制相配合——超出的段以既有 pending 語義留待下次 sync
export const maxDuration = 30

// 成本護欄（spec §6）：每使用者每分鐘最多 30 次 Google 呼叫（快取命中不計）。
// 已知限制：模組層記憶體在 serverless 平台為每實例獨立，護欄弱化——記入 spec §8，商用前換集中式限流。
const GOOGLE_CALL_LIMIT = 30
const RATE_WINDOW_MS = 60_000
const MAX_GOOGLE_CALLS_PER_SYNC = 5 // 單次 sync 的 Google 呼叫上限（5 段 × 5s timeout = 25s < maxDuration 30s，餘裕留給 DB 往返；未算完的段留 pending 下次補）
const FETCH_TIMEOUT_MS = 5_000
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // route_cache TTL（Google ToS 上限）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const rateWindows = new Map<string, RateWindow>()

type AutoMode = RouteQuery['mode']
const AUTO_MODES: ReadonlyArray<string> = ['transit', 'walking', 'driving']

export async function POST(_req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  if (!UUID_RE.test(tripId)) return NextResponse.json({ error: 'invalid trip id' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: isEditor } = await supabase.rpc('is_trip_editor', { p_trip_id: tripId })
  if (!isEditor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // 讀現況（user client：RLS 生效）
  const { data: stopRows, error: stopsErr } = await supabase
    .from('stops')
    .select('id, lat, lng, starts_at, ends_at')
    .eq('trip_id', tripId)
    .limit(500)
  const { data: legRows, error: legsErr } = await supabase
    .from('legs')
    .select('id, from_stop_id, to_stop_id, mode, source, duration_minutes, departs_at, computed_at, stale')
    .eq('trip_id', tripId)
    .limit(500)
  if (stopsErr || legsErr) return NextResponse.json({ error: 'read failed' }, { status: 500 })

  const now = Date.now()
  const stops: SyncStop[] = (stopRows ?? []).map(s => ({
    id: s.id, lat: s.lat, lng: s.lng,
    startsAt: new Date(s.starts_at).getTime(), endsAt: new Date(s.ends_at).getTime(),
  }))
  const legs: SyncLeg[] = (legRows ?? []).map(l => ({
    id: l.id, fromStopId: l.from_stop_id, toStopId: l.to_stop_id,
    source: l.source as SyncLeg['source'],
    durationMinutes: l.duration_minutes,
    departsAtMs: l.departs_at ? new Date(l.departs_at).getTime() : null,
    computedAtMs: l.computed_at ? new Date(l.computed_at).getTime() : null,
    stale: l.stale,
  }))
  const plan = planLegSync(stops, legs, now)

  // 結構同步——一律逐列寫入（legs 表註解的鎖序規約），user client（RLS editor 生效）。
  // 【審查 C-1 強制要求】計算對象在寫入成功「當下」連同起訖與模式一起入列 computeQueue，
  // 計算迴圈只讀 queue——絕不用兩個平行陣列的索引對應（insert 失敗靜默略過後索引錯位，
  // 會把路線寫進錯的段）。
  type ComputeItem = { legId: string; fromStopId: string; toStopId: string; mode: string }
  const computeQueue: ComputeItem[] = []
  let changed = false

  for (const id of plan.markStale) {
    const { error } = await supabase.from('legs').update({ stale: true }).eq('id', id)
    if (!error) changed = true
  }
  for (const id of plan.removeAuto) {
    const { error } = await supabase.from('legs').delete().eq('id', id)
    if (!error) changed = true
  }
  for (const c of plan.create) {
    // 併發同開時可能撞 unique（23505）——視為他人已建，靜默略過且不入列
    const { data, error } = await supabase
      .from('legs')
      .insert({ trip_id: tripId, from_stop_id: c.fromStopId, to_stop_id: c.toStopId, mode: 'transit', source: 'auto' })
      .select('id')
      .single()
    if (!error && data) {
      changed = true
      computeQueue.push({ legId: data.id, fromStopId: c.fromStopId, toStopId: c.toStopId, mode: 'transit' })
    }
  }
  const legMetaById = new Map((legRows ?? []).map(l => [l.id, l]))
  for (const legId of plan.recompute) {
    const meta = legMetaById.get(legId)
    if (meta) computeQueue.push({ legId, fromStopId: meta.from_stop_id, toStopId: meta.to_stop_id, mode: meta.mode })
  }

  const stopById = new Map(stops.map(s => [s.id, s]))
  const service = createServiceClient()
  const apiKey = process.env.GOOGLE_MAPS_SERVER_API_KEY
  let computed = 0
  let pending = 0
  let googleCalls = 0

  // 有界過期清理（審查 M-7）：每次 sync 順手刪最多 50 列逾期快取（fetched_at 已建索引），表不無限成長
  if (service) {
    const cutoff = new Date(now - CACHE_TTL_MS).toISOString()
    const { data: expiredRows } = await service
      .from('route_cache').select('cache_key').lt('fetched_at', cutoff).order('fetched_at').limit(50)
    const keys = (expiredRows ?? []).map(r => r.cache_key)
    if (keys.length > 0) await service.from('route_cache').delete().in('cache_key', keys)
  }
  // 記憶體衛生：清掉整窗過期的使用者條目，rateWindows 不隨歷史使用者數無限成長
  for (const [k, w] of rateWindows) {
    if (w.timestamps.every(t => now - t >= RATE_WINDOW_MS)) rateWindows.delete(k)
  }

  for (const item of computeQueue) {
    const from = stopById.get(item.fromStopId)
    const to = stopById.get(item.toStopId)
    if (!from || !to || !AUTO_MODES.includes(item.mode)) continue

    if (!apiKey) {
      pending++ // 無伺服器金鑰：leg 維持待計算（外部失敗不阻擋編輯，spec §6）
      continue
    }
    const departureMs = item.mode === 'transit' ? clampTransitDeparture(from.endsAt, now) : 0 // 非 transit 結果與出發時間無關，固定桶提高快取命中
    const query: RouteQuery = {
      fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng,
      mode: item.mode as AutoMode, departureMs,
    }
    const cacheKey = buildRouteCacheKey(query)

    // 快取（service client；未設定時跳過快取直接計算）
    let result: ReturnType<typeof parseComputeRoutesResponse> | null = null
    if (service) {
      const { data: hit } = await service.from('route_cache').select('result, fetched_at').eq('cache_key', cacheKey).maybeSingle()
      if (hit && now - new Date(hit.fetched_at).getTime() <= CACHE_TTL_MS) {
        result = hit.result as ReturnType<typeof parseComputeRoutesResponse>
      }
    }
    if (!result) {
      if (googleCalls >= MAX_GOOGLE_CALLS_PER_SYNC) {
        pending++
        continue // 分批（M-6）：本次額度用完，其餘留待下次 sync
      }
      const win = rateWindows.get(user.id) ?? { timestamps: [] }
      const take = takeToken(win, now, GOOGLE_CALL_LIMIT, RATE_WINDOW_MS)
      rateWindows.set(user.id, take.window)
      if (!take.allowed) {
        pending++
        continue // 超限：留待下次 sync，絕不 500
      }
      googleCalls++
      try {
        const req = buildComputeRoutesRequest(query, apiKey)
        const res = await fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // 單段逾時（M-6），與 maxDuration/分批相配合
        })
        if (!res.ok) {
          pending++ // Google 4xx/5xx：leg 維持待計算可重試（錯誤格式 {error:{code,message,status}}，不透傳細節給 client）
          continue
        }
        result = parseComputeRoutesResponse(await res.json())
      } catch {
        pending++
        continue // 網路失敗/逾時同上
      }
      // 只快取 ok 與 no_route（穩定結論）；bad_response 屬暫時性異常，快取 30 天會毒化該路段
      if (service && result && !(result.ok === false && result.reason === 'bad_response')) {
        await service.from('route_cache').upsert({ cache_key: cacheKey, result, fetched_at: new Date(now).toISOString() })
      }
    }

    if (result.ok) {
      const { error } = await supabase.from('legs').update({
        duration_minutes: result.durationMinutes,
        distance_meters: result.distanceMeters,
        polyline: result.polyline,
        detail: null,
        departs_at: new Date(from.endsAt).toISOString(),
        arrives_at: new Date(from.endsAt + result.durationMinutes * 60_000).toISOString(),
        computed_at: new Date(now).toISOString(),
        stale: false,
      }).eq('id', item.legId)
      if (!error) {
        computed++
        changed = true
      }
    } else if (result.reason === 'no_route') {
      const { error } = await supabase.from('legs').update({
        duration_minutes: null, distance_meters: null, polyline: null,
        detail: { no_route: true },
        departs_at: new Date(from.endsAt).toISOString(), arrives_at: null,
        computed_at: new Date(now).toISOString(), stale: false,
      }).eq('id', item.legId)
      if (!error) changed = true
    } else {
      pending++
    }
  }

  return NextResponse.json({ ok: true, changed, computed, pending })
}
