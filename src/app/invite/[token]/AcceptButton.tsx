'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Notice = { kind: 'error' | 'success'; text: string } | null

/** 「加入」鈕：必須是使用者主動點擊才呼叫 accept_trip_invite RPC——link prefetch/爬蟲
 *  絕不能造成入團副作用，這正是接受頁不做 GET 自動加入、而是拆成獨立 client 元件的原因。 */
export default function AcceptButton({ token }: { token: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  async function accept() {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data: tripId, error } = await supabase.rpc('accept_trip_invite', { p_token: token })
      if (error || !tripId) {
        // RPC 語義：無效/過期一律回 null，不區分原因（不給枚舉者訊號）——這裡對使用者顯示同一句文案
        setNotice({ kind: 'error', text: '邀請連結無效或已過期' })
        return
      }
      router.push(`/trips/${tripId}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="rounded bg-foreground p-2 text-background disabled:opacity-50"
        onClick={accept}
        disabled={busy}
      >
        {busy ? '加入中…' : '加入行程'}
      </button>
      {notice && (
        <p className={`text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
      )}
    </div>
  )
}
