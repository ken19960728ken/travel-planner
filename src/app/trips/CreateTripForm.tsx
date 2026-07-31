'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Notice = { kind: 'error' | 'success'; text: string } | null

export default function CreateTripForm() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [currency, setCurrency] = useState('TWD')
  const [notice, setNotice] = useState<Notice>(null)
  const [submitting, setSubmitting] = useState(false)

  async function createTrip(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || !startDate || !endDate) {
      setNotice({ kind: 'error', text: '標題與起訖日期都要填' })
      return
    }
    if (endDate < startDate) {
      setNotice({ kind: 'error', text: '結束日期不能早於開始日期' })
      return
    }
    setSubmitting(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('trips')
      .insert({ title: trimmed, start_date: startDate, end_date: endDate, currency })
    setSubmitting(false)
    if (error) {
      setNotice(
        error.code === '23514'
          ? { kind: 'error', text: '標題長度需在 1–200 字之間' }
          : { kind: 'error', text: '建立失敗，請稍後再試' },
      )
      return
    }
    setTitle('')
    setNotice({ kind: 'success', text: '已建立 ✓' })
    router.refresh()
  }

  return (
    <form onSubmit={createTrip} className="flex flex-col gap-2 rounded border p-3">
      <input
        className="rounded border p-2"
        placeholder="行程標題（例如：東京五日遊）"
        value={title}
        onChange={e => setTitle(e.target.value)}
        maxLength={200}
      />
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border p-2"
          type="date"
          value={startDate}
          onChange={e => setStartDate(e.target.value)}
        />
        <input
          className="flex-1 rounded border p-2"
          type="date"
          value={endDate}
          onChange={e => setEndDate(e.target.value)}
        />
        <select
          className="rounded border p-2"
          value={currency}
          onChange={e => setCurrency(e.target.value)}
        >
          <option value="TWD">TWD</option>
          <option value="JPY">JPY</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="KRW">KRW</option>
        </select>
      </div>
      <button className="rounded bg-foreground p-2 text-background disabled:opacity-50" type="submit" disabled={submitting}>
        {submitting ? '建立中…' : '建立行程'}
      </button>
      {notice && (
        <p className={`text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
      )}
    </form>
  )
}
