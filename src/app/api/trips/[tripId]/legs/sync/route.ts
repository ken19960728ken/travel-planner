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
const MAX_GOOGLE_CALLS_PER_SYNC = 5 // 額外上限（次要護欄）：即使牆鐘預算未耗盡，單次 sync 最多打 5 次 Google——
                                     // 真正的逾時防線是下方 WALL_CLOCK_BUDGET_MS（審查 I-1）；未算完的段留 pending 下次補
const FETCH_TIMEOUT_MS = 5_000
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // route_cache TTL（Google ToS 上限）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

  // 讀現況（user client：RLS 生效）。兩查詢互不依賴，平行送出（審查 S-1）。
  const [{ data: stopRows, error: stopsErr }, { data: legRows, error: legsErr }] = await Promise.all([
    supabase
      .from('stops')
      .select('id, lat, lng, starts_at, ends_at')
      .eq('trip_id', tripId)
      .order('starts_at')
      .limit(501), // 501 = 500 護欄 + 1 哨兵，藉此偵測「剛好卡在上限」與「真的超過上限」的差異（審查 I-2）
    supabase
      .from('legs')
      .select('id, from_stop_id, to_stop_id, mode, source, duration_minutes, departs_at, computed_at, stale')
      .eq('trip_id', tripId)
      .order('id')
      .limit(501),
  ])
  if (stopsErr || legsErr) {
    if (stopsErr) console.error('[legs/sync] stops read failed', { tripId, code: stopsErr.code, message: stopsErr.message })
    if (legsErr) console.error('[legs/sync] legs read failed', { tripId, code: legsErr.code, message: legsErr.message })
    return NextResponse.json({ error: 'read failed' }, { status: 500 })
  }
  // 哨兵命中（審查 I-2）：行程規模超出同步上限，拒絕處理而非悄悄截斷資料造成配對錯亂
  if ((stopRows?.length ?? 0) > 500 || (legRows?.length ?? 0) > 500) {
    return NextResponse.json({ error: 'trip too large to sync' }, { status: 413 })
  }

  // 牆鐘預算（審查 I-1，R-1 前移）：從 413 閘門之後就起算，讓預算涵蓋下面的結構同步
  // （markStale/removeAuto/create）與計算迴圈——結構同步同樣是逐列 DB 往返，段數多時
  // 一樣可能撞穿 maxDuration=30s；與 maxDuration 留 6s 餘裕給收尾往返與回應序列化。
  const startedAt = Date.now()
  const WALL_CLOCK_BUDGET_MS = 24_000
  const budgetExceeded = () => Date.now() - startedAt > WALL_CLOCK_BUDGET_MS

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
  let pending = 0

  // R-1：三個結構同步迴圈各自逐項檢查牆鐘預算，段數多時不讓結構同步本身撞穿 maxDuration。
  // markStale/removeAuto 中斷時剩餘項單純留給下次 sync 的結構同步重新判定（它們是「還沒改」，
  // 不是「還沒算」，語義上不算 pending——與這兩迴圈個別寫入失敗時只記 log 不記 pending 一致）。
  for (const id of plan.markStale) {
    if (budgetExceeded()) break
    const { error } = await supabase.from('legs').update({ stale: true }).eq('id', id)
    if (!error) changed = true
    else console.error('[legs/sync] markStale failed', { tripId, code: error.code, message: error.message })
  }
  for (const id of plan.removeAuto) {
    if (budgetExceeded()) break
    const { error } = await supabase.from('legs').delete().eq('id', id)
    if (!error) changed = true
    else console.error('[legs/sync] removeAuto failed', { tripId, code: error.code, message: error.message })
  }
  for (let i = 0; i < plan.create.length; i++) {
    if (budgetExceeded()) {
      // R-1：剩餘配對不建列、不入 computeQueue（下次 sync 的結構同步會重新判定為 create）。
      // 仍計入 pending——這些配對遲早要建 leg 並算 duration，牆鐘用盡而「還沒建」跟計算迴圈
      // 牆鐘用盡而「還沒算」是同一種「還沒完成」，語義上都算未完工作，pending 才如實反映總量。
      pending += plan.create.length - i
      break
    }
    const c = plan.create[i]
    const { data, error } = await supabase
      .from('legs')
      .insert({ trip_id: tripId, from_stop_id: c.fromStopId, to_stop_id: c.toStopId, mode: 'transit', source: 'auto' })
      .select('id')
      .single()
    if (!error && data) {
      changed = true
      computeQueue.push({ legId: data.id, fromStopId: c.fromStopId, toStopId: c.toStopId, mode: 'transit' })
    } else if (error && error.code !== '23505') {
      // 23505：併發同開時撞 unique，視為他人已建，靜默略過且不入列——其餘錯誤才記錄（審查 I-3）
      console.error('[legs/sync] create leg failed', { tripId, code: error.code, message: error.message })
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

  for (let i = 0; i < computeQueue.length; i++) {
    if (budgetExceeded()) {
      // 牆鐘預算耗盡（審查 I-1）：剩餘段一律留 pending，絕不讓迴圈把 maxDuration 撞穿
      pending += computeQueue.length - i
      break
    }
    const item = computeQueue[i]
    const from = stopById.get(item.fromStopId)
    const to = stopById.get(item.toStopId)
    if (!from || !to || !AUTO_MODES.includes(item.mode)) {
      pending++ // flight/custom 等非自動模式段本就不會被算，但仍需計入 pending（審查 M-2）
      continue
    }

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
        // 輕量驗形（審查 M-4）：快取列可能因手動改壞 / 未來欄位變更而毀損；不驗形直接信任會讓非法
        // durationMinutes 流入下方 new Date(...) 運算炸出 Invalid time value，殃及整個 handler。
        // 不合格視為 miss，落入下方重算分支，不特別記錄（快取毀損不是呼叫方的錯，重算即自癒）。
        const candidate = hit.result as { ok?: unknown; durationMinutes?: unknown }
        const validShape = typeof candidate.ok === 'boolean' &&
          (candidate.ok === false || (Number.isInteger(candidate.durationMinutes) && (candidate.durationMinutes as number) > 0))
        if (validShape) result = hit.result as ReturnType<typeof parseComputeRoutesResponse>
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
      } else {
        pending++ // R-3：寫回失敗，leg 仍未真正算完，須計入 pending 才可重試（原本漏記，此段會悄悄消失於統計外）
        console.error('[legs/sync] update computed leg failed', { tripId, code: error.code, message: error.message })
      }
    } else if (result.reason === 'no_route') {
      const { error } = await supabase.from('legs').update({
        duration_minutes: null, distance_meters: null, polyline: null,
        detail: { no_route: true },
        departs_at: new Date(from.endsAt).toISOString(), arrives_at: null,
        computed_at: new Date(now).toISOString(), stale: false,
      }).eq('id', item.legId)
      if (!error) changed = true
      else console.error('[legs/sync] update no_route leg failed', { tripId, code: error.code, message: error.message })
    } else {
      pending++
    }
  }

  return NextResponse.json({ ok: true, changed, computed, pending })
}
