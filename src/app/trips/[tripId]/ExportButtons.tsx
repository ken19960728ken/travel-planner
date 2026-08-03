'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { buildTripSnapshot, type SnapshotTrip, type SnapshotStop, type SnapshotLeg } from '@/lib/domain/snapshot'
import { localDateKey } from '@/lib/domain/tz'

type Notice = { kind: 'error' | 'success'; text: string } | null

// 瀏覽器當地時區（非 UTC）：出發前後在清晨時段操作，UTC 日期會早一天，標籤/檔名必須用當地日期。
function todayLabel(): string {
  return localDateKey(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a) // 脫離文件樹的 anchor 在部分瀏覽器不觸發下載，掛進 DOM 後即移除
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** 行程匯出入口（header 掛載）：Excel 下載（Task 2）＋ JSON 匯出／出發！定稿快照（Task 3）。
 *  JSON 匯出與快照共用同一顆 buildTripSnapshot builder——同一份資料，本地下載 vs 落 DB 兩種去處。
 *  「出發！定稿」canEdit 限定（Task 5 接上）：Excel/JSON 是唯讀匯出，viewer 也可用；定稿是寫入動作，
 *  viewer 隱藏（DB 的 trip_snapshots insert policy 本就要求 editor 以上，這裡是 UI 誠實化）。 */
export default function ExportButtons({
  tripId,
  trip,
  stops,
  legs,
  disabled = false,
  canEdit,
}: {
  tripId: string
  trip: SnapshotTrip
  stops: SnapshotStop[]
  legs: SnapshotLeg[]
  /** stops/legs 讀取失敗時停用快照與 JSON——空資料定稿會以「已定稿 ✓」覆蓋掉不可重來的出發基準線 */
  disabled?: boolean
  /** viewer 隱藏「出發！定稿」——寫入動作僅 editor 以上可用 */
  canEdit: boolean
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  function exportJson() {
    setNotice(null)
    const snapshot = buildTripSnapshot(trip, stops, legs)
    downloadJson(`${trip.title}-${todayLabel()}.json`, snapshot)
  }

  async function finalize() {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const snapshot = buildTripSnapshot(trip, stops, legs)
      const { error } = await supabase.from('trip_snapshots').insert({
        trip_id: tripId,
        label: `出發前定稿 ${todayLabel()}`,
        snapshot,
        snapshot_version: snapshot.snapshot_version,
      })
      if (error) {
        setNotice({ kind: 'error', text: '定稿失敗，請重新整理再試' })
      } else {
        setNotice({ kind: 'success', text: '已定稿 ✓' })
        router.refresh()
      }
    } catch {
      setNotice({ kind: 'error', text: '定稿失敗，請重新整理再試' })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    // md:ml-auto（非恆常 ml-auto）：桌機（≥md）行為與改版前的 ml-auto 完全等價；手機這排是獨立一行，
    // 靠左自然排列不留空白。每顆按鈕/文字都補 shrink-0 + whitespace-nowrap，
    // 避免視窗變窄時被 flex-shrink 壓到 CJK 逐字換行（原 bug 根因）。
    <div className="flex items-center gap-2 md:ml-auto">
      {notice && (
        <span className={`shrink-0 whitespace-nowrap text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</span>
      )}
      <a
        href={`/api/trips/${tripId}/export/xlsx`}
        className="shrink-0 whitespace-nowrap rounded border px-2 py-1 text-sm"
      >
        <span className="md:hidden">Excel</span>
        <span className="hidden md:inline">下載 Excel</span>
      </a>
      <button type="button" className="shrink-0 whitespace-nowrap rounded border px-2 py-1 text-sm disabled:opacity-50" disabled={disabled} onClick={exportJson}>
        <span className="md:hidden">JSON</span>
        <span className="hidden md:inline">匯出 JSON</span>
      </button>
      {canEdit && (confirming ? (
        <span className="flex shrink-0 items-center gap-1 text-sm">
          <button
            type="button"
            className="shrink-0 whitespace-nowrap rounded bg-green-600 px-2 py-1 text-white disabled:opacity-50"
            disabled={busy}
            onClick={finalize}
          >
            <span className="md:hidden">確認</span>
            <span className="hidden md:inline">確認出發！</span>
          </button>
          <button
            type="button"
            className="shrink-0 whitespace-nowrap rounded border px-2 py-1 disabled:opacity-50"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            取消
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="shrink-0 whitespace-nowrap rounded border px-2 py-1 text-sm font-semibold disabled:opacity-50"
          disabled={disabled}
          onClick={() => {
            setNotice(null)
            setConfirming(true)
          }}
        >
          <span className="md:hidden">定稿</span>
          <span className="hidden md:inline">出發！定稿</span>
        </button>
      ))}
      {canEdit && disabled && (
        <span className="shrink-0 whitespace-nowrap text-sm text-red-600">資料讀取失敗，暫時無法定稿</span>
      )}
    </div>
  )
}
