'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { utcMsToWallInput, wallInputToUtcMs } from '@/lib/domain/tz'
import { MODE_LABEL, isNoRoute } from './legUi'
import type { TablesUpdate } from '@/lib/supabase/database.types'
import type { Leg, Stop } from './TripView'

type Notice = { kind: 'error' | 'success'; text: string } | null
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

  // patch 型別用生成的 TablesUpdate<'legs'>（審查 M-3：Record<string, unknown> 過不了
  // supabase-js 的 update 泛型，tsc 實測編譯失敗）
  async function write(patch: TablesUpdate<'legs'>, successText: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.from('legs').update(patch).eq('id', leg.id)
      if (error) {
        setNotice(
          error.code === '23514'
            ? { kind: 'error', text: '輸入內容不符限制，請檢查數值' }
            : { kind: 'error', text: '儲存失敗，請稍後再試' },
        )
        return
      }
      setNotice({ kind: 'success', text: successText })
      onChanged?.()
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // 三種儲存形態：
  // A. auto 模式、時長留空 → 交還自動計算（source=auto、清 Google 衍生欄位與起訖，sync 重算）
  // B. auto 模式、填了時長 → source=manual，只存使用者資料；清 polyline/detail——
  //    ToS 分層：manual 段永久保存，不得夾帶 Google 衍生資料（spec §4）
  // C. flight/custom → source=manual，起訖必填且訖 > 起；duration 由起訖導出（衝突偵測用）
  async function save() {
    const costNum = cost === '' ? null : Number(cost)
    if (costNum !== null && (Number.isNaN(costNum) || costNum < 0)) {
      return setNotice({ kind: 'error', text: '花費必須是不小於 0 的數字' })
    }
    if (isTimed) {
      if (!departsAt || !arrivesAt) return setNotice({ kind: 'error', text: '請填出發與抵達時間' })
      const dep = wallInputToUtcMs(departsAt, fromStop.timezone)
      const arr = wallInputToUtcMs(arrivesAt, toStop.timezone)
      if (!(arr > dep)) return setNotice({ kind: 'error', text: '抵達必須晚於出發（注意兩地時區）' })
      return write({
        mode, source: 'manual',
        departs_at: new Date(dep).toISOString(),
        arrives_at: new Date(arr).toISOString(),
        duration_minutes: Math.max(1, Math.round((arr - dep) / 60_000)),
        distance_meters: null, polyline: null, detail: null, computed_at: null,
        stale: false, estimated_cost: costNum,
      }, '已儲存 ✓')
    }
    if (duration.trim() !== '') {
      const n = Number(duration)
      if (!Number.isInteger(n) || n < 0) return setNotice({ kind: 'error', text: '時長必須是不小於 0 的整數分鐘' })
      return write({
        mode, source: 'manual', duration_minutes: n,
        distance_meters: null, polyline: null, detail: null, computed_at: null,
        departs_at: null, arrives_at: null,
        stale: false, estimated_cost: costNum,
      }, '已儲存（手動時長不會被自動計算覆蓋）✓')
    }
    return write({
      mode, source: 'auto', duration_minutes: null,
      distance_meters: null, polyline: null, detail: null, computed_at: null,
      departs_at: null, arrives_at: null,
      stale: false, estimated_cost: costNum,
    }, '已交還自動計算，稍候更新 ✓')
  }

  return (
    <div className="mt-1 flex flex-col gap-2 rounded border p-2 text-sm">
      {leg.stale && (
        <div className="flex items-center justify-between rounded bg-amber-50 p-1 text-xs text-amber-700">
          ⚠️ 前後行程變動過，此交通資訊可能過期
          <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={busy}
            onClick={() => write({ stale: false }, '已確認 ✓')}>已重新確認</button>
        </div>
      )}
      {isNoRoute(leg) && (
        <p className="text-xs text-amber-700">查無路線：可改用其他交通方式，或切為航班/自訂手動填寫</p>
      )}
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
      {isAutoMode && (
        <label className="flex flex-col gap-1 text-xs">
          時長（分鐘；留空 = 自動計算，填寫 = 手動覆寫且不被自動蓋掉）
          <input className="rounded border p-1" type="number" min="0" step="1"
            value={duration} onChange={e => setDuration(e.target.value)} />
        </label>
      )}
      {isTimed && (
        <>
          <label className="flex flex-col gap-1 text-xs">
            出發（{fromStop.timezone} 當地時間）
            <input className="rounded border p-1" type="datetime-local" value={departsAt} onChange={e => setDepartsAt(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            抵達（{toStop.timezone} 當地時間）
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
        <p className={`text-xs ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
      )}
    </div>
  )
}
