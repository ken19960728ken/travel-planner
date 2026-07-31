import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import TripView from './TripView'
import type { Leg } from './TripView'

export default async function TripDetailPage({
  params,
}: {
  params: Promise<{ tripId: string }>
}) {
  const { tripId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: trip, error: tripError } = await supabase
    .from('trips')
    .select('id, title, start_date, end_date, currency')
    .eq('id', tripId)
    .maybeSingle()
  if (tripError) {
    return (
      <main className="flex h-screen items-center justify-center text-red-600">
        讀取失敗，請重新整理再試
      </main>
    )
  }
  if (!trip) notFound() // RLS 擋掉的非成員也走這裡，不洩漏行程是否存在

  const { data: stops, error: stopsError } = await supabase
    .from('stops')
    .select('id, name, lat, lng, place_id, is_custom, timezone, starts_at, ends_at, locked, notes, estimated_cost')
    .eq('trip_id', tripId)
    .order('starts_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(500)

  const { data: legs, error: legsError } = await supabase
    .from('legs')
    .select('id, from_stop_id, to_stop_id, mode, duration_minutes, distance_meters, polyline, detail, source, stale, departs_at, arrives_at, estimated_cost, updated_at')
    .eq('trip_id', tripId)
    .order('id', { ascending: true })
    .limit(500)

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-baseline gap-3 border-b p-3">
        <Link href="/trips" className="text-sm text-gray-500">← 我的行程</Link>
        <h1 className="text-lg font-bold">{trip.title}</h1>
        <span className="text-sm text-gray-500">{trip.start_date} ~ {trip.end_date}</span>
      </header>
      {stopsError && (
        <p className="border-b p-2 text-sm text-red-600">停留點讀取失敗，請重新整理再試</p>
      )}
      {legsError && (
        <p className="border-b p-2 text-sm text-red-600">交通段讀取失敗，請重新整理再試</p>
      )}
      <TripView trip={trip} stops={stops ?? []} stopsError={Boolean(stopsError)} legs={(legs ?? []) as Leg[]} />
    </main>
  )
}
