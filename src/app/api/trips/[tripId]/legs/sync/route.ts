import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { planLegSync, type SyncStop, type SyncLeg } from '@/lib/domain/legSync'
import { parseRoster } from '@/lib/domain/participants'
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

  // 讀現況（user client：RLS 生效）。三查詢互不依賴，平行送出（審查 S-1）。
  const [
    { data: stopRows, error: stopsErr },
    { data: legRows, error: legsErr },
    { data: tripRow, error: tripErr },
  ] = await Promise.all([
    supabase
      .from('stops')
      .select('id, lat, lng, starts_at, ends_at, participant_ids')
      .eq('trip_id', tripId)
      .order('starts_at')
      .limit(501), // 501 = 500 護欄 + 1 哨兵，藉此偵測「剛好卡在上限」與「真的超過上限」的差異（審查 I-2）
    supabase
      .from('legs')
      .select('id, from_stop_id, to_stop_id, mode, source, duration_minutes, departs_at, computed_at, stale, estimated_cost')
      .eq('trip_id', tripId)
      .order('id')
      .limit(501),
    // 名冊：決定交通段要按幾條時間軸生成（participantPairs）。
    // 讀失敗必須整個中止而不能退回空名冊——空名冊會讓 planLegSync 退回單軌演算法，
    // 於是分頭行程的幻影段被「重新建立」、真正的段落被判為脫離配對而刪除。
    supabase.from('trips').select('participants').eq('id', tripId).maybeSingle(),
  ])
  if (stopsErr || legsErr || tripErr) {
    if (stopsErr) console.error('[legs/sync] stops read failed', { tripId, code: stopsErr.code, message: stopsErr.message })
    if (legsErr) console.error('[legs/sync] legs read failed', { tripId, code: legsErr.code, message: legsErr.message })
    if (tripErr) console.error('[legs/sync] trip read failed', { tripId, code: tripErr.code, message: tripErr.message })
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
    participantIds: s.participant_ids,
  }))
  const roster = parseRoster(tripRow?.participants).map(p => p.id)
  const legs: SyncLeg[] = (legRows ?? []).map(l => ({
    id: l.id, fromStopId: l.from_stop_id, toStopId: l.to_stop_id,
    source: l.source as SyncLeg['source'],
    durationMinutes: l.duration_minutes,
    departsAtMs: l.departs_at ? new Date(l.departs_at).getTime() : null,
    computedAtMs: l.computed_at ? new Date(l.computed_at).getTime() : null,
    stale: l.stale,
    estimatedCost: l.estimated_cost,
  }))
  const plan = planLegSync(stops, legs, now, roster)

  // 結構同步——一律逐列寫入（legs 表註解的鎖序規約），user client（RLS editor 生效）。
  // 【審查 C-1 強制要求】計算對象在寫入成功「當下」連同起訖與模式一起入列 computeQueue，
  // 計算迴圈只讀 queue——絕不用兩個平行陣列的索引對應（insert 失敗靜默略過後索引錯位，
  // 會把路線寫進錯的段）。
  type ComputeItem = { legId: string; fromStopId: string; toStopId: string; mode: string }
  const computeQueue: ComputeItem[] = []
  let changed = false
  let pending = 0
  // incomplete（I-3）：任一迴圈因牆鐘預算中斷即 true，client 據此判斷是否該排下一輪續跑
  let incomplete = false
  // legCount（C-1）：sync 後該 trip 的 leg 數，用結構同步已知的異動量算，不多打一次 DB。
  // 初始值＝client 讀到的舊快照筆數，removeAuto 成功才減、create 成功「或」23505（列已存在）才加。
  let removedCount = 0
  let createdCount = 0

  // R-1：三個結構同步迴圈各自逐項檢查牆鐘預算，段數多時不讓結構同步本身撞穿 maxDuration。
  // markStale/removeAuto 中斷時剩餘項單純留給下次 sync 的結構同步重新判定（它們是「還沒改」，
  // 不是「還沒算」，語義上不算 pending——與這兩迴圈個別寫入失敗時只記 log 不記 pending 一致）。
  for (const id of plan.markStale) {
    if (budgetExceeded()) { incomplete = true; break }
    const { error } = await supabase.from('legs').update({ stale: true }).eq('id', id)
    if (!error) changed = true
    else console.error('[legs/sync] markStale failed', { tripId, code: error.code, message: error.message })
  }
  for (const id of plan.removeAuto) {
    if (budgetExceeded()) { incomplete = true; break }
    // 審查 Critical-1：snapshot 讀取後到這行之間，該段可能已被 LegEditor 改成 manual——
    // 加 .eq('source', 'auto') 讓刪除在 DB 層原子化重新確認，0 列＝已被搶先改 manual，不算變化
    const { data, error } = await supabase.from('legs').delete().eq('id', id).eq('source', 'auto').select('id')
    if (!error) { if ((data ?? []).length > 0) { changed = true; removedCount++ } }
    else console.error('[legs/sync] removeAuto failed', { tripId, code: error.code, message: error.message })
  }
  for (const id of plan.detachAuto) {
    if (budgetExceeded()) { incomplete = true; break }
    // Important-1 根治：帶花費的 auto 段脫離配對時轉存 manual——花費是使用者資料必須保留；
    // Google 衍生欄位全清（脫離段不再被 sync 重算，留著就是 30 天後的 ToS 逾期殘留）。
    // .eq('source','auto') 原子守衛沿 Critical-1 慣例：已被使用者搶先改 manual 就不動它
    const { data, error } = await supabase.from('legs').update({
      source: 'manual', duration_minutes: null, distance_meters: null,
      polyline: null, detail: null, computed_at: null,
      departs_at: null, arrives_at: null, stale: true,
    }).eq('id', id).eq('source', 'auto').select('id')
    // 成功計 changed = true（不動 legCount——列仍在，只是 source 由 auto 轉 manual）
    if (!error) { if ((data ?? []).length > 0) changed = true }
    else console.error('[legs/sync] detachAuto failed', { tripId, code: error.code, message: error.message })
  }
  for (let i = 0; i < plan.create.length; i++) {
    if (budgetExceeded()) {
      // R-1：剩餘配對不建列、不入 computeQueue（下次 sync 的結構同步會重新判定為 create）。
      // 仍計入 pending——這些配對遲早要建 leg 並算 duration，牆鐘用盡而「還沒建」跟計算迴圈
      // 牆鐘用盡而「還沒算」是同一種「還沒完成」，語義上都算未完工作，pending 才如實反映總量。
      pending += plan.create.length - i
      incomplete = true
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
      createdCount++
      computeQueue.push({ legId: data.id, fromStopId: c.fromStopId, toStopId: c.toStopId, mode: 'transit' })
    } else if (error && error.code === '23505') {
      // C-1：併發同開時撞 unique，列已存在但不在這個 client 的快照裡——對 client 仍是一筆變化，
      // 需回報 changed 才會 refresh；該列目前狀態未知（可能已算完也可能還沒），保守計入 pending，
      // 但不入 computeQueue（不知道它的 from/to/mode 是否與本地 plan 假設一致，交還下次 sync 判定）
      changed = true
      createdCount++
      pending++
    } else if (error) {
      console.error('[legs/sync] create leg failed', { tripId, code: error.code, message: error.message })
    }
  }
  const legMetaById = new Map((legRows ?? []).map(l => [l.id, l]))
  for (const legId of plan.recompute) {
    const meta = legMetaById.get(legId)
    if (meta) computeQueue.push({ legId, fromStopId: meta.from_stop_id, toStopId: meta.to_stop_id, mode: meta.mode })
  }
  const legCount = (legRows?.length ?? 0) - removedCount + createdCount

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
      incomplete = true
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
        // M-4 白名單：ok:false 只信任 no_route／no_transit_data 兩個穩定結論（bad_response 本不會被
        // 寫入快取，見下方 upsert 條件，這裡仍防禦手動改壞/未來新增 reason）；no_transit_data 帶
        // durationMinutes（I-2 方案 a：保留步行時長），一併驗形，格式不對就當快取毀損重算。
        const candidate = hit.result as { ok?: unknown; reason?: unknown; durationMinutes?: unknown }
        const hasValidDuration = Number.isInteger(candidate.durationMinutes) && (candidate.durationMinutes as number) > 0
        const validShape = typeof candidate.ok === 'boolean' && (
          candidate.ok === true
            ? hasValidDuration
            : candidate.reason === 'no_route' || (candidate.reason === 'no_transit_data' && hasValidDuration)
        )
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
        result = parseComputeRoutesResponse(await res.json(), query.mode)
      } catch {
        pending++
        continue // 網路失敗/逾時同上
      }
      // 只快取 ok、no_route、no_transit_data（皆為穩定結論）；bad_response 屬暫時性異常，快取 30 天會毒化該路段
      if (service && result && !(result.ok === false && result.reason === 'bad_response')) {
        await service.from('route_cache').upsert({ cache_key: cacheKey, result, fetched_at: new Date(now).toISOString() })
      }
    }

    if (result.ok) {
      // 審查 Critical-1：Google 呼叫期間（可長達數秒）該段可能已被 LegEditor 改成 manual 或換了交通
      // 方式，.eq('source', 'auto').eq('mode', item.mode)（I-3）讓寫回在 DB 層原子化重新確認，絕不能
      // 用「呼叫前讀到的 mode/source」這種 check-then-act 判斷，那道間隙正是 PoC 復現的缺口
      const { data, error } = await supabase.from('legs').update({
        duration_minutes: result.durationMinutes,
        distance_meters: result.distanceMeters,
        polyline: result.polyline,
        detail: null,
        departs_at: new Date(from.endsAt).toISOString(),
        arrives_at: new Date(from.endsAt + result.durationMinutes * 60_000).toISOString(),
        computed_at: new Date(now).toISOString(),
        stale: false,
      }).eq('id', item.legId).eq('source', 'auto').eq('mode', item.mode).select('id')
      if (!error) {
        // 0 列＝寫回瞬間已被改成 manual 或換了交通方式，這段已換人負責，不計 computed 也不計 pending
        if ((data ?? []).length > 0) {
          computed++
          changed = true
        }
      } else {
        pending++ // R-3：寫回失敗，leg 仍未真正算完，須計入 pending 才可重試（原本漏記，此段會悄悄消失於統計外）
        console.error('[legs/sync] update computed leg failed', { tripId, code: error.code, message: error.message })
      }
    } else if (result.reason === 'no_route') {
      const { data, error } = await supabase.from('legs').update({
        duration_minutes: null, distance_meters: null, polyline: null,
        detail: { no_route: true },
        departs_at: new Date(from.endsAt).toISOString(), arrives_at: null,
        computed_at: new Date(now).toISOString(), stale: false,
      }).eq('id', item.legId).eq('source', 'auto').eq('mode', item.mode).select('id')
      if (!error) {
        // 同上：0 列＝已被改成 manual 或換了交通方式，不算變化也不計 pending（Critical-1/I-3 守衛）
        if ((data ?? []).length > 0) changed = true
      } else {
        pending++ // M-2：與 R-3 同一種漏記——寫回失敗，leg 仍未真正算完，須計入 pending 才可重試
        console.error('[legs/sync] update no_route leg failed', { tripId, code: error.code, message: error.message })
      }
    } else if (result.reason === 'no_transit_data') {
      // 日本大眾運輸 fallback，I-2 方案 (a)：鏡像 ok 分支寫回真實步行時長/距離/polyline（衝突偵測
      // 需要真實時長），只在 detail 記哨兵供 UI 顯示「無大眾運輸資料」；穩定結論可快取（上方快取
      // 條件已涵蓋），避免每次 sync 重打 Google
      const { data, error } = await supabase.from('legs').update({
        duration_minutes: result.durationMinutes,
        distance_meters: result.distanceMeters,
        polyline: result.polyline,
        detail: { no_transit_data: true },
        departs_at: new Date(from.endsAt).toISOString(),
        arrives_at: new Date(from.endsAt + result.durationMinutes * 60_000).toISOString(),
        computed_at: new Date(now).toISOString(),
        stale: false,
      }).eq('id', item.legId).eq('source', 'auto').eq('mode', item.mode).select('id')
      if (!error) {
        // N-3／同上：0 列＝寫回瞬間已被改成 manual 或換了交通方式，這段已換人負責，不計 changed 也不計 pending
        if ((data ?? []).length > 0) changed = true
      } else {
        pending++
        console.error('[legs/sync] update no_transit_data leg failed', { tripId, code: error.code, message: error.message })
      }
    } else {
      // I-1：bad_response 涵蓋「duration 格式異常」與「transit legs/steps 資料不完整（三態偵測判 unknown）」
      // 兩種情況——皆屬暫時性/待查異常，不快取、留 pending 自動重試；記一筆 log 供追蹤
      // （tripId/legId/mode 足以定位問題，不含 API 金鑰或座標等敏感內容）
      pending++
      console.error('[legs/sync] compute got bad_response', { tripId, legId: item.legId, mode: item.mode })
    }
  }

  return NextResponse.json({ ok: true, changed, computed, pending, legCount, incomplete })
}
