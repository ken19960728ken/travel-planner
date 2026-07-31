'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function CreateTripForm() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [currency, setCurrency] = useState('TWD')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function createTrip(e: React.FormEvent) {
    e.preventDefault()
    if (!title || !startDate || !endDate) {
      setMessage('標題與起訖日期都要填')
      return
    }
    if (endDate < startDate) {
      setMessage('結束日期不能早於開始日期')
      return
    }
    setSubmitting(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('trips')
      .insert({ title, start_date: startDate, end_date: endDate, currency })
    setSubmitting(false)
    if (error) {
      setMessage(`建立失敗：${error.message}`)
      return
    }
    setTitle('')
    setMessage('')
    router.refresh()
  }

  return (
    <form onSubmit={createTrip} className="flex flex-col gap-2 rounded border p-3">
      <input
        className="rounded border p-2"
        placeholder="行程標題（例如：東京五日遊）"
        value={title}
        onChange={e => setTitle(e.target.value)}
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
      <button className="rounded bg-black p-2 text-white disabled:opacity-50" type="submit" disabled={submitting}>
        {submitting ? '建立中…' : '建立行程'}
      </button>
      {message && <p className="text-sm text-red-600">{message}</p>}
    </form>
  )
}
