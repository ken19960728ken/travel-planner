import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import CreateTripForm from './CreateTripForm'

export default async function TripsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: trips, error } = await supabase
    .from('trips')
    .select('id, title, start_date, end_date, currency')
    .order('start_date', { ascending: true })

  return (
    <main className="mx-auto mt-12 w-[32rem]">
      <h1 className="mb-6 text-2xl font-bold">我的行程</h1>
      <CreateTripForm />
      {error && <p className="mt-4 text-red-600">讀取失敗：{error.message}</p>}
      <ul className="mt-6 flex flex-col gap-2">
        {(trips ?? []).map(trip => (
          <li key={trip.id} className="rounded border p-3">
            <span className="font-medium">{trip.title}</span>
            <span className="ml-2 text-sm text-gray-500">
              {trip.start_date} ~ {trip.end_date}（{trip.currency}）
            </span>
          </li>
        ))}
        {trips?.length === 0 && <li className="text-gray-500">還沒有行程，建立第一個吧</li>}
      </ul>
    </main>
  )
}
