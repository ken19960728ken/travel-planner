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
 *  「出發！定稿」canEdit 限定：本 Task 時點 page.tsx 尚未查 role，以 owner 本人使用為前提直接顯示，
 *  Task 5 接上 canEdit 後補條件。 */
export default function ExportButtons({
  tripId,
  trip,
  stops,
  legs,
  disabled = false,
}: {
  tripId: string
  trip: SnapshotTrip
  stops: SnapshotStop[]
  legs: SnapshotLeg[]
  /** stops/legs 讀取失敗時停用快照與 JSON——空資料定稿會以「已定稿 ✓」覆蓋掉不可重來的出發基準線 */
  disabled?: boolean
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
    <div className="ml-auto flex items-center gap-2">
      {notice && (
        <span className={`text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</span>
      )}
      <a
        href={`/api/trips/${tripId}/export/xlsx`}
        className="rounded border px-2 py-1 text-sm"
      >
        下載 Excel
      </a>
      <button type="button" className="rounded border px-2 py-1 text-sm disabled:opacity-50" disabled={disabled} onClick={exportJson}>
        匯出 JSON
      </button>
      {confirming ? (
        <span className="flex items-center gap-1 text-sm">
          <button
            type="button"
            className="rounded bg-green-600 px-2 py-1 text-white disabled:opacity-50"
            disabled={busy}
            onClick={finalize}
          >
            確認出發！
          </button>
          <button
            type="button"
            className="rounded border px-2 py-1 disabled:opacity-50"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            取消
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="rounded border px-2 py-1 text-sm font-semibold disabled:opacity-50"
          disabled={disabled}
          onClick={() => {
            setNotice(null)
            setConfirming(true)
          }}
        >
          出發！定稿
        </button>
      )}
      {disabled && (
        <span className="text-sm text-red-600">資料讀取失敗，暫時無法定稿</span>
      )}
    </div>
  )
}
