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
 * ⚠️ **本檔涵蓋的是這兩條的哪一部分，講清楚免得誤以為都守住了**：
 * - 第 2 條：本檔完整涵蓋。
 * - 第 1 條：本檔只涵蓋**匿名**那一半（anon 在 public 不能寫）。「已登入但非成員不得編輯」
 *   完全不在這裡——表級 GRANT 對所有 authenticated 一視同仁，區分成員與否的是 RLS policy，
 *   由 `rls.test.ts` 覆蓋。把「匿名不能寫」當成「編輯要成員身分」是偷換，而讓人以為某件事
 *   已經被機器守住，正是本檔存在要防的失敗模式。
 *
 * 另一個範圍限制：只掃 `public` schema。anon 在 `realtime.messages` 上其實**持有**表級
 * INSERT/UPDATE（被該表的 policy `to authenticated` 擋著），`storage` 與 `supabase_functions`
 * 亦然。所以本檔證明的是「anon 在 public 只能讀」，不是「anon 在整個 DB 只能讀」。
 * 詳見 migration 檔頭。
 */

/**
 * anon 可執行的 public 函式白名單（`regprocedure` 完整簽章，不是純名字——overload 用純名字
 * 會塌成兩個一樣的字串，只能靠長度對不上勉強變紅）。
 *
 * 下方對它做**全等**斷言而非「包含」：新增或移除任何一顆都會變紅，強迫改的人來看一眼。
 *
 * ⚠️ 全等斷言只看得到**新增與移除**。最危險的第三種動作——`create or replace` 原地改寫
 * 既有函式的 body——由下方的 fingerprints 斷言負責。volatility 與原始碼掃描則是輔助訊號，
 * 兩者都可被繞過（各自註解有寫）。
 *
 * 這七顆全部是 STABLE 或 IMMUTABLE：
 * - get_shared_trip：分享頁的唯讀 RPC，anon 存在的唯一理由。**七顆裡唯一顯式 grant 給 anon 的**
 * - is_trip_member / is_trip_editor / is_trip_owner / my_trip_ids：RLS policy 的 helper
 * - resolve_stop_participants / trip_roster_ids：參與人判定，被上述 policy 與其他函式引用
 *
 * 後六顆的 `proacl` 是 NULL——也就是 `create function` 的 PUBLIC 預設，從沒 revoke 過，
 * 不是有人決定要給 anon 的。anon 對 public 所有表零 GRANT，RLS 對它永遠不會被求值，
 * 這六顆對它毫無用處。**可以收乾淨讓白名單只剩 1 顆**，但 revoke 必須與 grant 成對
 * （本專案在 20260805000000 踩過「只 revoke 弄壞全站 Realtime」），列為後續獨立改動。
 */
const ANON_FUNCTIONS = [
  'get_shared_trip(uuid)',
  'is_trip_editor(uuid)',
  'is_trip_member(uuid)',
  'is_trip_owner(uuid)',
  'my_trip_ids()',
  'resolve_stop_participants(uuid[],uuid[])',
  'trip_roster_ids(uuid)',
].sort()

/**
 * 每顆 anon 可執行函式的定義雜湊（`md5(pg_get_functiondef(oid))` 前 12 碼）。
 *
 * 這是唯一擋得住「原地改寫」的一項。實測過的繞法：把 `get_shared_trip` 改成
 * `language sql stable begin atomic select public.some_writer(); end`——名字沒變（全等斷言綠）、
 * 標成 stable（volatility 綠）、`begin atomic` 讓 prosrc 是空字串（原始碼掃描綠），寫入卻成功。
 * 有了定義雜湊，任何一個字元的變動都會變紅。
 *
 * **這串紅了要怎麼辦**：不是照抄新值蓋掉。先確認那顆函式為什麼被改、改完還是不是唯讀，
 * 確認過了才更新這裡的值——這條斷言的價值就在那一次確認。
 *
 * ⚠️ `pg_get_functiondef` 的輸出格式綁 PostgreSQL 版本（目前本機 17.6），升大版本時整批會變，
 * 那是預期行為。
 */
const ANON_FUNCTION_FINGERPRINTS: Record<string, string> = {
  'get_shared_trip(uuid)': '82a13d6c86a9',
  'is_trip_editor(uuid)': '929d93ed3142',
  'is_trip_member(uuid)': '492630895aa2',
  'is_trip_owner(uuid)': 'd6f2fbfc981f',
  'my_trip_ids()': '84339dd32562',
  'resolve_stop_participants(uuid[],uuid[])': 'cde05058ff3e',
  'trip_roster_ids(uuid)': '41f5f02d752e',
}

type Audit = {
  table_writes: string[]
  column_writes: string[]
  volatile_functions: string[]
  writes_in_source: string[]
  functions: string[]
  fingerprints: Record<string, string>
  scanned: { relations: number; columns: number; functions: number }
}

it('CI 上必須具備跑鐵律斷言的條件', () => {
  // 這條**刻意放在 skipIf 之外**。下面整組在沒有本地 Supabase 時會靜默跳過並回報成功——
  // 對一般整合測試可接受，但本檔的賣點就是「機器可檢查」，靜默跳過等於賣點落空。
  // 目前 repo 沒有 CI（無 .github/），所以這條在本機永遠通過；等哪天接了 CI，
  // 忘記在 workflow 裡起 Supabase 就會被這條擋下來，而不是無聲地全部跳過。
  if (process.env.CI) expect(hasEnv).toBe(true)
})

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
    // ⚠️ 不是唯讀證明，實測可繞：STABLE 函式裡 perform 一顆 VOLATILE 函式，該函式的
    // INSERT 會成功——唯讀模式不沿呼叫鏈傳遞，而函式間的呼叫關係不進 pg_depend，
    // 這個遞移閉包沒有便宜的機檢法。真正擋住原地改寫的是 fingerprints 那條。
    expect(anon.volatile_functions).toEqual([])
  })

  it('授予 anon 的函式定義沒有 DML 關鍵字', () => {
    // 掃的是 `coalesce(nullif(prosrc,''), pg_get_functiondef(oid))`：prosrc 對 PG14+ 的
    // `begin atomic` 函式是**空字串**，只掃 prosrc 的話那條路徑整個失明，而那是官方推薦
    // 的寫法，屬於「不小心」而非「刻意繞」。
    // 掃的是含註解的完整定義，偏向誤報（在註解裡寫「本函式不 insert」也會紅）——
    // fail-closed，可接受。
    expect(anon.writes_in_source).toEqual([])
  })

  it('anon 可執行的函式清單與白名單全等', () => {
    expect([...anon.functions].sort()).toEqual(ANON_FUNCTIONS)
  })

  it('anon 可執行的函式定義未被改動（擋 create or replace 原地改寫）', () => {
    expect(anon.fingerprints).toEqual(ANON_FUNCTION_FINGERPRINTS)
  })

  it('偵測器本身沒瞎：五個維度都要有非零的觀測基礎', () => {
    // 「anon 全空」有兩種可能：真的沒權限，或**查詢本身壞了**——兩者長得一模一樣。
    // 這正是第一版差點踩到的坑：information_schema.role_table_grants 只列出
    // 「當前角色是授予者/被授予者/其成員」的權限，service_role 不是 anon 的成員，
    // 查出來永遠是空的。實測同一筆 anon 授權：information_schema 回 0 筆、
    // has_table_privilege 回 1 筆、has_column_privilege 回 3 筆。
    //
    // 兩道獨立的自證：
    // (a) scanned 分母——條件寫壞（nspname 打成 'pubic'、relkind 條件寫反）時掃描回零列，
    //     五個陣列一起變 []，而 has_*_privilege 對錯誤角色拋錯的那道保險剛好也失效
    //     （它只在掃描產出列時才被求值）。
    // (b) authenticated 對照組——它確實有一大票寫入權限與 volatile 函式。
    expect(anon.scanned.relations).toBeGreaterThan(0)
    expect(anon.scanned.columns).toBeGreaterThan(0)
    expect(anon.scanned.functions).toBeGreaterThan(0)

    expect(authenticated.table_writes.length).toBeGreaterThan(0)
    expect(authenticated.column_writes.length).toBeGreaterThan(0)
    // 這兩行不可省：volatile_functions 與 writes_in_source 走的是**另外兩條獨立子查詢**，
    // 上面兩行完全保護不到它們。有人把 `provolatile = 'v'` 寫成 `= 'V'` 就是永遠的綠燈。
    expect(authenticated.volatile_functions.length).toBeGreaterThan(0)
    expect(authenticated.writes_in_source.length).toBeGreaterThan(0)
    expect(Object.keys(authenticated.fingerprints).length).toBeGreaterThan(0)
  })

  it('p_role 傳 null 時整支回 null，不是回一組空陣列', () => {
    // 稽核函式標了 strict。少了它，`p_role => null` 會讓五個陣列全空——與「真的沒有權限」
    // 完全無從區分，五條斷言一起變綠。這顆函式的存在理由就是長期防呆，不能自己留一個
    // 「傳 null 就全綠」的入口。
    const admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    return admin.rpc('role_privilege_audit', { p_role: null }).then(({ data, error }) => {
      expect(error).toBeNull()
      expect(data).toBeNull()
    })
  })

  it('authenticated 不得改 trips 的 share_token 與 participants，但可以改 title', () => {
    // 部署檢查點 B（plans/2026-08-01-travel-planner-sharing.md:349-355）共四條斷言，
    // 這裡折進兩條；第三條（anon 不可 EXECUTE accept_trip_invite）由上面的白名單全等覆蓋；
    // 第四條（anon 對 trip_invites 無 SELECT）**沒有涵蓋**——本稽核函式只看寫入面，
    // 沒有讀取維度，那條仍需人工在 SQL Editor 跑。
    //
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
