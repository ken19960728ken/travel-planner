'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { utcMsToWallInput, wallInputToUtcMs } from '@/lib/domain/tz'
import { MODE_LABEL, isNoRoute, isNoTransitData } from './legUi'
import type { TablesUpdate } from '@/lib/supabase/database.types'
import type { Leg, Stop } from './TripView'

type Notice = { kind: 'error' | 'success' | 'warn'; text: string } | null
const AUTO_MODES = ['transit', 'walking', 'driving'] as const
type Mode = Leg['mode']

export default function LegEditor({
  leg, fromStop, toStop, currency, onChanged,
}: {
  leg: Leg
  fromStop: Stop
  toStop: Stop
  currency: string
  onChanged?: () => void
}) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(leg.mode)
  const [duration, setDuration] = useState(
    leg.source === 'manual' && leg.duration_minutes !== null ? String(leg.duration_minutes) : '',
  )
  // flight/custom 的起訖：出發用起點時區、抵達用終點時區（可跨日跨時區——datetime-local 含日期）
  const [departsAt, setDepartsAt] = useState(
    leg.departs_at && leg.source === 'manual'
      ? utcMsToWallInput(new Date(leg.departs_at).getTime(), fromStop.timezone) : '',
  )
  const [arrivesAt, setArrivesAt] = useState(
    leg.arrives_at && leg.source === 'manual'
      ? utcMsToWallInput(new Date(leg.arrives_at).getTime(), toStop.timezone) : '',
  )
  const [cost, setCost] = useState(leg.estimated_cost?.toString() ?? '')
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const isTimed = mode === 'flight' || mode === 'custom'
  const isAutoMode = (AUTO_MODES as ReadonlyArray<string>).includes(mode)

  // 樂觀鎖令牌（審查 Important-A；審查原提案是 ref 版，但本專案 eslint-plugin-react-hooks 的
  // react-hooks/refs 規則禁止 render 期間存取 ref——實測會噴 error，故改用與 Minor-B 同款的
  // useState 追蹤前一輪值＋render 期間比對樣式，語義不變）：lockToken 是「目前已知安全可
  // 覆寫」的 updated_at 版本，write() 每次成功寫入後直接推進到伺服器回傳的最新值，不等
  // router.refresh() 往返，消除「同分頁連續儲存」誤判成「已被其他操作變更」的假警報；
  // propToken 追蹤上一輪觀察到的 leg.updated_at，props 追上時（外部改動落地）於 render
  // 期間同步 lockToken。
  const [lockToken, setLockToken] = useState(leg.updated_at)
  const [propToken, setPropToken] = useState(leg.updated_at)
  if (propToken !== leg.updated_at) {
    setPropToken(leg.updated_at)
    setLockToken(leg.updated_at)
  }

  // patch 型別用生成的 TablesUpdate<'legs'>（審查 M-3：Record<string, unknown> 過不了
  // supabase-js 的 update 泛型，tsc 實測編譯失敗）
  async function write(patch: TablesUpdate<'legs'>, successNotice: { kind: 'success' | 'warn'; text: string }) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const supabase = createClient()
      // 樂觀鎖（審查 Important-2/3，比照 StopEditor.tsx:56-76）：以 lockToken（目前已知安全可
      // 覆寫的 updated_at）比對，防的是本分頁尚未觀察到的外部改動（sync 併發寫回、其他分頁/
      // 協作者）——比對不到列時 data 為空陣列且無 error，不可再靜默覆寫或假裝成功。
      const { data, error } = await supabase
        .from('legs')
        .update(patch)
        .eq('id', leg.id)
        .eq('updated_at', lockToken)
        .select('id, updated_at')
      if (error) {
        setNotice(
          error.code === '23514' || error.code === '22003'
            ? { kind: 'error', text: '輸入內容不符限制，請檢查數值' }
            : { kind: 'error', text: '儲存失敗，請稍後再試' },
        )
        return
      }
      if (data.length === 0) {
        setNotice({ kind: 'error', text: '此交通段已被其他操作變更或刪除，請重新整理後再編輯' })
        router.refresh()
        return
      }
      setLockToken(data[0].updated_at) // Important-A：令牌前進，不等 router.refresh() 往返
      setNotice(successNotice)
      onChanged?.()
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // 四種儲存形態：
  // A. auto 模式、時長留空 → 交還自動計算（source=auto、清 Google 衍生欄位與起訖，sync 重算）
  // B. auto 模式、填了時長；或 custom 只填時長 → source=manual，只存使用者資料、起訖留 null；清 polyline/detail——
  //    ToS 分層：manual 段永久保存，不得夾帶 Google 衍生資料（spec §4）
  // C. flight（必填）或 custom 填了完整起訖 → source=manual，訖 > 起；duration 由起訖導出（衝突偵測用）；
  //    custom 若起訖與時長都填，以起訖為準（S-8）
  // flight 起訖缺一即報錯；custom 起訖只填一半（不成對）也報錯，要求補齊或改填時長
  async function save() {
    const costNum = cost === '' ? null : Number(cost)
    if (costNum !== null && (Number.isNaN(costNum) || costNum < 0)) {
      return setNotice({ kind: 'error', text: '花費必須是不小於 0 的數字' })
    }

    const hasDeparts = departsAt !== ''
    const hasArrives = arrivesAt !== ''
    const hasDuration = duration.trim() !== ''

    if ((mode === 'flight' || mode === 'custom') && hasDeparts && hasArrives) {
      const dep = wallInputToUtcMs(departsAt, fromStop.timezone)
      const arr = wallInputToUtcMs(arrivesAt, toStop.timezone)
      if (!(arr > dep)) return setNotice({ kind: 'error', text: '抵達必須晚於出發（注意兩地時區）' })
      // 起訖導出的 duration 也要吃同一條 30 天上界（審查 Minor）：時長分支有 43200 檢查，
      // 這條分支原本沒有，custom 段（S-8 後可走此分支）填一組相隔一年的起訖就會寫入約 525600 分鐘，
      // 遠超 UI 自己宣告的上限，而 DB 的 check 只有 >= 0 擋不住
      if (arr - dep > 43200 * 60_000) {
        return setNotice({ kind: 'error', text: '出發與抵達間隔不得超過 30 天' })
      }
      // Important-4（軟警示，spec §5：警示不阻擋）：出發早於起點停留點結束、或抵達晚於終點停留點開始，
      // 代表班機時刻與停留點時段兜不起來，可能是使用者輸錯——仍允許儲存，只是提示確認
      const outOfWindow = dep < new Date(fromStop.ends_at).getTime() || arr > new Date(toStop.starts_at).getTime()
      return write({
        mode, source: 'manual',
        departs_at: new Date(dep).toISOString(),
        arrives_at: new Date(arr).toISOString(),
        duration_minutes: Math.max(1, Math.round((arr - dep) / 60_000)),
        distance_meters: null, polyline: null, detail: null, computed_at: null,
        stale: false, estimated_cost: costNum,
      }, outOfWindow
        ? {
            kind: 'warn',
            text: mode === 'flight'
              ? '已儲存，但班機時間落在停留點時段之外，請確認行程銜接'
              : '已儲存，但時間落在停留點時段之外，請確認行程銜接',
          }
        : { kind: 'success', text: '已儲存 ✓' })
    }
    if (mode === 'flight') {
      return setNotice({ kind: 'error', text: '請填出發與抵達時間' })
    }
    if (mode === 'custom' && hasDeparts !== hasArrives) {
      return setNotice({ kind: 'error', text: '請完整填寫出發與抵達時間，或改為只填時長' })
    }
    if (hasDuration) {
      const n = Number(duration)
      if (!Number.isInteger(n) || n < 0) return setNotice({ kind: 'error', text: '時長必須是不小於 0 的整數分鐘' })
      if (n > 43200) return setNotice({ kind: 'error', text: '時長需在 0–43200 分鐘之間' }) // M-5：上界 30 天
      return write({
        mode, source: 'manual', duration_minutes: n,
        distance_meters: null, polyline: null, detail: null, computed_at: null,
        departs_at: null, arrives_at: null,
        stale: false, estimated_cost: costNum,
      }, { kind: 'success', text: '已儲存（手動時長不會被自動計算覆蓋）✓' })
    }
    if (mode === 'custom') {
      return setNotice({ kind: 'error', text: '請填寫時長，或填寫出發與抵達時間' })
    }
    return write({
      mode, source: 'auto', duration_minutes: null,
      distance_meters: null, polyline: null, detail: null, computed_at: null,
      departs_at: null, arrives_at: null,
      stale: false, estimated_cost: costNum,
    }, { kind: 'success', text: '已交還自動計算，稍候更新 ✓' })
  }

  return (
    <div className="mt-1 flex flex-col gap-2 rounded border p-2 text-sm">
      {leg.stale && (
        <div className="flex items-center justify-between rounded bg-amber-50 p-1 text-xs text-amber-700">
          ⚠️ 前後行程變動過，此交通資訊可能過期
          <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={busy}
            onClick={() => write({ stale: false }, { kind: 'success', text: '已確認 ✓' })}>已重新確認</button>
        </div>
      )}
      {/* N-2：兩種情況互斥（sync 只會寫其中一種 detail 哨兵），改 if/else 結構確保畫面最多顯示一條 */}
      {isNoRoute(leg) ? (
        <p className="text-xs text-amber-700">查無路線：可改用其他交通方式，或切為航班/自訂手動填寫</p>
      ) : isNoTransitData(leg) ? (
        <p className="text-xs text-amber-700">
          此路段 Google 未提供大眾運輸班次，以下為步行估算——可改開車／步行，或切為航班／自訂手動填寫
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-xs">
        交通方式
        <select className="rounded border p-1" value={mode} onChange={e => setMode(e.target.value as Mode)}>
          {(Object.keys(MODE_LABEL) as Mode[]).map(m => (
            <option key={m} value={m}>{MODE_LABEL[m]}</option>
          ))}
        </select>
      </label>
      {mode === 'walking' && (
        <p className="text-xs text-gray-400">步行路線為 Google Beta 功能，可能缺乏人行道資訊，請留意實地狀況</p>
      )}
      {/* S-8：custom 起訖改為可選，時長欄位一併開放給 custom（只填時長走 manual 時長分支） */}
      {(isAutoMode || mode === 'custom') && (
        <label className="flex flex-col gap-1 text-xs">
          {mode === 'custom'
            ? '時長（分鐘；可只填時長，不填下方出發/抵達；若都填則以出發/抵達為準）'
            : '時長（分鐘；留空 = 自動計算，填寫 = 手動覆寫且不被自動蓋掉）'}
          <input className="rounded border p-1" type="number" min="0" step="1"
            placeholder={
              leg.duration_minutes !== null
                ? mode === 'custom' ? `目前時長：${leg.duration_minutes} 分` : `目前自動計算：${leg.duration_minutes} 分`
                : ''
            }
            value={duration} onChange={e => setDuration(e.target.value)} />
        </label>
      )}
      {isTimed && (
        <>
          <label className="flex flex-col gap-1 text-xs">
            出發（{fromStop.timezone} 當地時間）{mode === 'custom' && '（可留空，改填時長）'}
            <input className="rounded border p-1" type="datetime-local" value={departsAt} onChange={e => setDepartsAt(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            抵達（{toStop.timezone} 當地時間）{mode === 'custom' && '（可留空，改填時長）'}
            <input className="rounded border p-1" type="datetime-local" value={arrivesAt} onChange={e => setArrivesAt(e.target.value)} />
          </label>
        </>
      )}
      <input className="rounded border p-1" type="number" min="0" step="0.01"
        placeholder={`預估花費（${currency}，可留空）`} value={cost} onChange={e => setCost(e.target.value)} />
      <button className="rounded bg-foreground p-1 text-background disabled:opacity-50" onClick={save} disabled={busy}>
        儲存
      </button>
      {notice && (
        <p className={`text-xs ${
          notice.kind === 'error' ? 'text-red-600' : notice.kind === 'warn' ? 'text-amber-700' : 'text-green-600'
        }`}>{notice.text}</p>
      )}
    </div>
  )
}
