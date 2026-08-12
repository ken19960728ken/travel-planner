import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && serviceKey)

if (url && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行整合測試（防止誤打正式環境）')
}

/**
 * 系統鐵律的機檢斷言（migration 20260812000000）。
 *
 * 鐵律本文：
 *   1. 共同編輯一律要求成員身分；匿名使用者若未來要能編輯，只能編輯不屬於任何帳號的獨立副本。
 *   2. 任何授予未登入身分（anon）的函式，必須是唯讀的。
 *
 * 為何第 2 條不能省：表級授權擋不住 SECURITY DEFINER 函式。`get_shared_trip` 就是 anon 對
 * 九張表零權限、卻拿得到整份行程的實例。只擋表不擋函式，等於留了一扇沒上鎖的側門。
 */

/**
 * anon 可執行的 public 函式白名單。下方對它做**全等**斷言而非「包含」——新增任何一顆
 * anon 可執行的函式都會讓測試變紅，強迫加白名單的人來看一眼是不是真的該給。
 *
 * ⚠️ **這條全等斷言才是真正的把關**，volatility 與 prosrc 兩條是輔助訊號，都可以被繞過
 *（見下方各自的註解）。機檢擋的是「不小心」，「刻意」只能靠改白名單時的那一次 review。
 *
 * 這七顆全部是 STABLE 或 IMMUTABLE：
 * - get_shared_trip：分享頁的唯讀 RPC，anon 存在的唯一理由
 * - is_trip_member / is_trip_editor / is_trip_owner / my_trip_ids：RLS policy 的 helper
 * - resolve_stop_participants / trip_roster_ids：參與人判定，被上述 policy 與其他函式引用
 */
const ANON_FUNCTIONS = [
  'get_shared_trip',
  'is_trip_editor',
  'is_trip_member',
  'is_trip_owner',
  'my_trip_ids',
  'resolve_stop_participants',
  'trip_roster_ids',
].sort()

type Audit = {
  table_writes: string[]
  column_writes: string[]
  volatile_functions: string[]
  writes_in_source: string[]
  functions: string[]
}

describe.skipIf(!hasEnv)('鐵律：未登入身分只能讀（需本地 Supabase）', () => {
  let anon: Audit
  let authenticated: Audit

  beforeAll(async () => {
    const admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    const [a, b] = await Promise.all([
      admin.rpc('role_privilege_audit', { p_role: 'anon' }),
      admin.rpc('role_privilege_audit', { p_role: 'authenticated' }),
    ])
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    anon = a.data as Audit
    authenticated = b.data as Audit
  })

  it('anon 對 public 的所有資料表沒有任何表級寫入權限', () => {
    expect(anon.table_writes).toEqual([])
  })

  it('anon 沒有任何欄位級寫入權限', () => {
    // 表級與欄位級要分開掃：本專案用過欄位級授權（20260811000000 的
    // `grant update (title, …) on trips`），而 has_table_privilege 只看表級——
    // 只掃表級的話，「只給 anon 改一個欄位」會完全看不見
    expect(anon.column_writes).toEqual([])
  })

  it('授予 anon 的函式沒有任何 VOLATILE', () => {
    // PostgreSQL 在**呼叫時**對非 volatile 函式擋 DML（`INSERT is not allowed in a
    // non-volatile function`），所以這條抓得到「隨手加一顆匿名可寫函式」。
    // ⚠️ 但它**不是唯讀證明，實測可繞**：STABLE 函式裡 perform 一顆 VOLATILE 函式，
    // 該 VOLATILE 函式的 INSERT 會成功——唯讀模式不沿呼叫鏈傳遞。函式間的呼叫關係
    // 不進 pg_depend，這個遞移閉包沒有便宜的機檢法。真正的把關是下一條全等斷言。
    expect(anon.volatile_functions).toEqual([])
  })

  it('授予 anon 的函式原始碼沒有 DML 關鍵字', () => {
    // 補上一條 volatility 檢查漏掉的路徑：有人把**既有**白名單函式改成會寫。
    // 同樣可繞（動態 SQL、轉呼叫別的函式），定位仍是輔助訊號。
    expect(anon.writes_in_source).toEqual([])
  })

  it('anon 可執行的函式清單與白名單全等', () => {
    expect([...anon.functions].sort()).toEqual(ANON_FUNCTIONS)
  })

  it('偵測器本身沒瞎：authenticated 必須掃得出大量寫入權限', () => {
    // 「anon 全空」有兩種可能：真的沒權限，或查詢本身壞了——兩者長得一模一樣。
    // 這正是第一版差點踩到的坑：information_schema.role_table_grants 只列出
    // 「當前角色是授予者/被授予者/其成員」的權限，service_role 不是 anon 的成員，
    // 查出來永遠是空的。實測同一筆 anon 授權：information_schema 回 0 筆、
    // has_table_privilege 回 1 筆、has_column_privilege 回 3 筆。
    // 沒有這條對照，上面四條斷言全部會是永遠的綠燈。
    expect(authenticated.table_writes.length).toBeGreaterThan(0)
    expect(authenticated.column_writes.length).toBeGreaterThan(0)
  })

  it('authenticated 不得改 trips 的 share_token 與 participants，但可以改 title', () => {
    // 部署檢查點 B（plans/2026-08-01-travel-planner-sharing.md:348）原本要人工在
    // SQL Editor 跑的斷言，折進自動化。
    // share_token：只能透過 owner-only 的 regenerate_share_token RPC 重生成。
    // participants：只能透過 upsert/remove_trip_participant RPC 改，因為直接 UPDATE
    // 繞得過名冊上限與 stops.participant_ids 的連帶更新。
    // ⚠️ 這條的存在理由是「grant 只加不減」：把欄位從 grant 清單移除對已授權過的資料庫
    // 毫無效果，必須顯式 revoke。本專案已經在 participants 上踩過一次。
    expect(authenticated.column_writes).not.toContain('trips.share_token UPDATE')
    expect(authenticated.column_writes).not.toContain('trips.participants UPDATE')
    expect(authenticated.column_writes).toContain('trips.title UPDATE')
  })
})
