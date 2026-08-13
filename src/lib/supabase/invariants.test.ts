import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && serviceKey)

if (url && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行整合測試（防止誤打正式環境）')
}

/**
 * 系統鐵律的機檢斷言（migration 20260812000000 建立、20260813000000 補上實際防線三維度）。
 *
 * 鐵律本文：
 *   1. 共同編輯一律要求成員身分；匿名使用者若未來要能編輯，只能編輯不屬於任何帳號的獨立副本。
 *   2. 任何授予未登入身分（anon）的函式，必須是唯讀的。
 *
 * ⚠️ **2026-08-13 的教訓：第一版驗錯了層。**
 * 初版只驗 GRANT，本機全綠。實際到雲端跑同一顆稽核函式才發現 anon 在雲端持有
 * **八張表的 arwdDxtm（含 TRUNCATE）與 17 顆函式的 EXECUTE**——Supabase 平台在 public
 * schema 預設下了六筆 `alter default privileges`，本機 CLI 沒有複製。
 * 也就是說：本機的實際防線是 GRANT，雲端的實際防線是 RLS，而斷言只認得前者。
 * 現在三個維度一起驗（GRANT / RLS / policy 角色），外加 default privileges 這個根因。
 *
 * **涵蓋範圍要說清楚，免得又誤以為都守住了**：
 * - 第 2 條：完整涵蓋。
 * - 第 1 條：只涵蓋**匿名**那一半。「已登入但非成員不得編輯」是 RLS policy 的責任，
 *   由 `rls.test.ts` 覆蓋——表級 GRANT 對所有 authenticated 一視同仁。
 * - 只掃 `public` schema。anon 在 `realtime.messages` 上仍持有表級 INSERT/UPDATE，
 *   被該表 `to authenticated` 的 policy 擋著；`storage` / `supabase_functions` 亦然。
 */

/**
 * anon 可執行的 public 函式白名單（`regprocedure` 完整簽章）。
 *
 * **只有一顆。** 20260813000000 之前是 7 顆，其中 6 顆是 `create function` 的 PUBLIC 預設、
 * 從沒 revoke 過（不是有人決定要給 anon）。anon 對 public 零表授權、RLS policy 全部
 * `to authenticated` 而永遠不會為它求值，那 6 顆 helper 對它毫無用處，已一併收乾淨。
 * 白名單只剩一顆的好處是「anon 到底能做什麼」一眼看完。
 *
 * 全等斷言只看得到新增與移除；原地改寫由下方 fingerprints 負責。
 */
const ANON_FUNCTIONS = ['get_shared_trip(uuid)']

/**
 * 每顆 anon 可執行函式的定義雜湊（`md5(pg_get_functiondef(oid))` 前 12 碼）。
 *
 * 唯一擋得住 `create or replace` 原地改寫的一項。實測過的繞法：把函式改成
 * `language sql stable begin atomic select public.some_writer(); end`——名字沒變、
 * 標成 stable、`begin atomic` 讓 prosrc 是空字串，其餘三個訊號全綠而寫入成功。
 *
 * **這串紅了不要照抄新值蓋掉。** 先確認那顆函式為什麼被改、改完還是不是唯讀。
 * ⚠️ `pg_get_functiondef` 的輸出格式綁 PostgreSQL 版本（本機 17.6），升大版本時會整批變動。
 */
const ANON_FUNCTION_FINGERPRINTS: Record<string, string> = {
  'get_shared_trip(uuid)': '82a13d6c86a9',
}

type Audit = {
  table_writes: string[]
  table_reads: string[]
  column_writes: string[]
  volatile_functions: string[]
  writes_in_source: string[]
  functions: string[]
  fingerprints: Record<string, string>
  tables_without_rls: string[]
  policies_for_role: string[]
  default_privileges: string[]
  scanned: { relations: number; columns: number; functions: number; policies: number }
}

it('CI 上必須具備跑鐵律斷言的條件', () => {
  // 刻意放在 skipIf 之外。下面整組在沒有本地 Supabase 時會靜默跳過並回報成功——
  // 對一般整合測試可接受，但本檔的賣點就是「機器可檢查」，靜默跳過等於賣點落空。
  // 目前 repo 沒有 CI（無 .github/），所以這條在本機永遠通過。
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

  // ============ GRANT 層 ============

  it('anon 對 public 的所有資料表沒有任何表級寫入權限', () => {
    expect(anon.table_writes).toEqual([])
  })

  it('anon 對 public 的所有資料表沒有讀取權限', () => {
    // 分享頁不需要——它走 SECURITY DEFINER 的 get_shared_trip，以擁有者身分讀表。
    // 雲端原本這裡有八張表（Supabase 平台的 default privileges），已由 20260813000000 收回。
    expect(anon.table_reads).toEqual([])
  })

  it('anon 沒有任何欄位級寫入權限', () => {
    // 表級與欄位級要分開掃：本專案用過欄位級授權（20260811000000 的
    // `grant update (title, …) on trips`），而 has_table_privilege 只看表級
    expect(anon.column_writes).toEqual([])
  })

  it('授予 anon 的函式沒有任何 VOLATILE', () => {
    // ⚠️ 不是唯讀證明，實測可繞：STABLE 函式裡 perform 一顆 VOLATILE 函式，該函式的
    // INSERT 會成功——唯讀模式不沿呼叫鏈傳遞，而函式間的呼叫關係不進 pg_depend。
    expect(anon.volatile_functions).toEqual([])
  })

  it('授予 anon 的函式定義沒有 DML 關鍵字', () => {
    // 掃 `coalesce(nullif(prosrc,''), pg_get_functiondef(oid))`：prosrc 對 PG14+ 的
    // `begin atomic` 函式是空字串，只掃 prosrc 那條路徑整個失明。
    expect(anon.writes_in_source).toEqual([])
  })

  it('anon 可執行的函式清單與白名單全等（只有 get_shared_trip）', () => {
    expect([...anon.functions].sort()).toEqual([...ANON_FUNCTIONS].sort())
  })

  it('anon 可執行的函式定義未被改動（擋 create or replace 原地改寫）', () => {
    expect(anon.fingerprints).toEqual(ANON_FUNCTION_FINGERPRINTS)
  })

  it('稽核函式本身不可被 anon 或 authenticated 執行', () => {
    // 它會吐出整份授權佈局，是攻擊者的地圖。anon key 就印在瀏覽器 bundle 裡。
    // 雲端的 default privileges 原本把它顯式授予了這兩個角色。
    expect(anon.functions).not.toContain('role_privilege_audit(text)')
    expect(authenticated.functions).not.toContain('role_privilege_audit(text)')
  })

  // ============ 實際防線：RLS 與 policy ============

  it('public 的每一張資料表都啟用了 RLS', () => {
    // GRANT 層敞開時這是唯一的防線。漏一張表就是該表全世界可讀可寫。
    expect(anon.tables_without_rls).toEqual([])
  })

  it('沒有任何 policy 適用於 anon（含忘記寫 to authenticated 而落到 public 的）', () => {
    // policy 不寫 `to <role>` 時預設是 `to public`，而 public 涵蓋 anon。
    // 目前 34 條全部寫了 `to authenticated`，這條鎖住它不許退步。
    expect(anon.policies_for_role).toEqual([])
  })

  it('public schema 沒有任何會自動授權給 anon 的 default privileges', () => {
    // 這是 2026-08-13 那次事故的根因：Supabase 平台預設下了六筆，
    // 導致**每一顆照專案慣例（revoke from public → grant to authenticated）寫的新 RPC，
    // 在雲端都是匿名可呼叫的**——anon 的 EXECUTE 是顯式授予的，revoke from public 收不掉。
    // ⚠️ 若這條在雲端紅了，代表 migration 裡那段 DO 區塊因權限不足沒收乾淨
    //（授予者是 supabase_admin 的那幾筆），需以該角色身分處理，不可放著。
    expect(anon.default_privileges).toEqual([])
  })

  // ============ 偵測器自證 ============

  it('偵測器本身沒瞎：每個維度都要有非零的觀測基礎', () => {
    // 「anon 全空」有兩種可能：真的沒權限，或**查詢本身壞了**——兩者長得一模一樣。
    // 第一版差點就用了 information_schema.role_table_grants，那些 view 只列出
    // 「當前角色是授予者/被授予者/其成員」的權限，service_role 不是 anon 的成員，
    // 查出來永遠是空的。實測同一筆 anon 授權：information_schema 0 筆、
    // has_table_privilege 1 筆、has_column_privilege 3 筆。
    //
    // 兩道獨立自證：(a) scanned 分母（條件寫壞回零列時，has_*_privilege 對錯誤角色
    // 拋錯的保險剛好也失效，因為它只在掃描產出列時才被求值）；(b) authenticated 對照組。
    expect(anon.scanned.relations).toBeGreaterThan(0)
    expect(anon.scanned.columns).toBeGreaterThan(0)
    expect(anon.scanned.functions).toBeGreaterThan(0)
    expect(anon.scanned.policies).toBeGreaterThan(0)

    expect(authenticated.table_writes.length).toBeGreaterThan(0)
    expect(authenticated.table_reads.length).toBeGreaterThan(0)
    expect(authenticated.column_writes.length).toBeGreaterThan(0)
    // 這幾行不可省：每一項都走**獨立的子查詢**，上面幾行完全保護不到它們。
    // 有人把 `provolatile = 'v'` 寫成 `= 'V'` 就是永遠的綠燈。
    expect(authenticated.volatile_functions.length).toBeGreaterThan(0)
    expect(authenticated.writes_in_source.length).toBeGreaterThan(0)
    expect(Object.keys(authenticated.fingerprints).length).toBeGreaterThan(0)
    // policies_for_role 的對照：34 條 policy 全部 to authenticated，這裡必須掃得出來。
    // 少了這條，anon 的 policies_for_role 恆空就可能只是查詢壞掉。
    expect(authenticated.policies_for_role.length).toBeGreaterThan(0)
  })

  it('p_role 傳 null 時整支回 null，不是回一組空陣列', () => {
    // 稽核函式標了 strict。少了它，`p_role => null` 會讓每個陣列全空——與「真的沒有權限」
    // 無從區分，所有斷言一起變綠。
    const admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    return admin.rpc('role_privilege_audit', { p_role: null }).then(({ data, error }) => {
      expect(error).toBeNull()
      expect(data).toBeNull()
    })
  })

  it('authenticated 不得改 trips 的 share_token 與 participants，但可以改 title', () => {
    // 部署檢查點 B（plans/2026-08-01-travel-planner-sharing.md:349-355）四條斷言：
    // 這裡折進兩條，第三條（anon 不可 EXECUTE accept_trip_invite）由白名單全等覆蓋，
    // 第四條（anon 對 trip_invites 無 SELECT）現由 table_reads 全空覆蓋。**四條已全部自動化。**
    //
    // share_token：只能透過 owner-only 的 regenerate_share_token RPC 重生成。
    // participants：只能透過 upsert/remove_trip_participant RPC 改，直接 UPDATE 會繞過
    // 名冊上限與 stops.participant_ids 的連帶更新。
    // ⚠️ 這條的存在理由是「grant 只加不減」：把欄位從 grant 清單移除對已授權過的資料庫
    // 毫無效果，必須顯式 revoke。本專案已經在 participants 上踩過一次。
    expect(authenticated.column_writes).not.toContain('trips.share_token UPDATE')
    expect(authenticated.column_writes).not.toContain('trips.participants UPDATE')
    expect(authenticated.column_writes).toContain('trips.title UPDATE')
  })
})
