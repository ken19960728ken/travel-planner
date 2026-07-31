import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import CreateTripForm from './CreateTripForm'
import SignOutButton from './SignOutButton'

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
    .order('created_at', { ascending: true })
    .limit(100)

  return (
    <main className="mx-auto mt-12 w-[32rem]">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">我的行程</h1>
        <SignOutButton />
      </div>
      <CreateTripForm />
      {error && <p className="mt-4 text-red-600">讀取失敗，請重新整理再試</p>}
      <ul className="mt-6 flex flex-col gap-2">
        {(trips ?? []).map(trip => (
          <li key={trip.id}>
            <Link href={`/trips/${trip.id}`} className="block rounded border p-3 hover:bg-gray-50 dark:hover:bg-gray-900">
              <span className="font-medium">{trip.title}</span>
              <span className="ml-2 text-sm text-gray-500">
                {trip.start_date} ~ {trip.end_date}（{trip.currency}）
              </span>
            </Link>
          </li>
        ))}
        {trips?.length === 0 && <li className="text-gray-500">還沒有行程，建立第一個吧</li>}
      </ul>
    </main>
  )
}
