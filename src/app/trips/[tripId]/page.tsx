import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import TripView from './TripView'
import type { Leg } from './TripView'
import ExportButtons from './ExportButtons'
import MembersPanel, { type Member, type Invite } from './MembersPanel'

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

  // Task 5/7：role 與成員面板資料一次查完——trip_members 無 profiles 直接 FK，PostgREST 嵌入 join 不可用。
  // 本頁自己的 role 直接從 memberRows 反推，不再另開一次 (trip_id, user_id) 查詢（critic 審查 M-1：
  // 原本兩次查詢語義等價，只是多一次 round trip）；與 stops/legs 併發（M-1），三者互不依賴。
  // membersError 走整頁錯誤——絕不能把暫時性查詢失敗誤判成「你是 viewer」而靜默藏光所有編輯入口
  const [
    { data: memberRows, error: membersError },
    { data: stops, error: stopsError },
    { data: legs, error: legsError },
  ] = await Promise.all([
    supabase.from('trip_members').select('user_id, role').eq('trip_id', tripId),
    supabase
      .from('stops')
      .select('id, name, lat, lng, place_id, is_custom, timezone, starts_at, ends_at, locked, notes, estimated_cost')
      .eq('trip_id', tripId)
      .order('starts_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(500),
    supabase
      .from('legs')
      .select('id, from_stop_id, to_stop_id, mode, duration_minutes, distance_meters, polyline, detail, source, stale, departs_at, arrives_at, estimated_cost, updated_at')
      .eq('trip_id', tripId)
      .order('id', { ascending: true })
      .limit(500),
  ])
  if (membersError) {
    return (
      <main className="flex h-screen items-center justify-center text-red-600">
        讀取失敗，請重新整理再試
      </main>
    )
  }
  const membership = memberRows.find(m => m.user_id === user.id)
  const canEdit = membership?.role === 'owner' || membership?.role === 'editor'
  const isOwner = membership?.role === 'owner'

  // profiles 反查（spec §8 孤兒語義：查無 profile 顯示「已離開的成員」）與邀請清單（僅 owner 需要——
  // 其餘角色的 trip_invites RLS select 本就回 0 列，直接省查）併發（M-1）
  const memberUserIds = memberRows.map(m => m.user_id)
  const [{ data: profileRows, error: profilesError }, { data: inviteRows, error: invitesError }] = await Promise.all([
    memberUserIds.length > 0
      ? supabase.from('profiles').select('id, display_name').in('id', memberUserIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string | null }[], error: null }),
    isOwner
      ? supabase.from('trip_invites').select('id, role, expires_at').eq('trip_id', tripId).order('created_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as { id: string; role: string; expires_at: string }[], error: null }),
  ])
  const profileMap = new Map(profileRows?.map(p => [p.id, p.display_name]) ?? [])
  const members: Member[] = memberRows.map(m => ({
    userId: m.user_id,
    role: m.role as Member['role'],
    displayName: profileMap.has(m.user_id) ? profileMap.get(m.user_id) || '（未命名）' : '已離開的成員',
  }))
  const invites: Invite[] = (inviteRows ?? []).map(i => ({ id: i.id, role: i.role as Invite['role'], expiresAt: i.expires_at }))
  // profiles/trip_invites 查詢失敗不阻擋整頁（次要資料），但要讓面板知道自己資料不完整——
  // 不然 profiles 失敗會讓所有成員顯示「已離開的成員」、invites 失敗會讓 owner 誤以為沒有邀請連結，兩者都是靜默誤導
  const membersPanelLoadError = Boolean(profilesError || invitesError)

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-baseline gap-3 border-b p-3">
        <Link href="/trips" className="text-sm text-gray-500">← 我的行程</Link>
        <h1 className="text-lg font-bold">{trip.title}</h1>
        <span className="text-sm text-gray-500">{trip.start_date} ~ {trip.end_date}</span>
        {!canEdit && (
          <span
            className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
            title="你在此行程的角色為檢視者，無法編輯"
          >
            👁 檢視模式
          </span>
        )}
        <ExportButtons tripId={tripId} trip={trip} stops={stops ?? []} legs={(legs ?? []) as Leg[]} disabled={Boolean(stopsError || legsError)} canEdit={canEdit} />
        <MembersPanel
          tripId={tripId}
          currentUserId={user.id}
          isOwner={isOwner}
          members={members}
          invites={invites}
          loadError={membersPanelLoadError}
        />
      </header>
      {stopsError && (
        <p className="border-b p-2 text-sm text-red-600">停留點讀取失敗，請重新整理再試</p>
      )}
      {legsError && (
        <p className="border-b p-2 text-sm text-red-600">交通段讀取失敗，請重新整理再試</p>
      )}
      <TripView trip={trip} stops={stops ?? []} stopsError={Boolean(stopsError)} legs={(legs ?? []) as Leg[]} canEdit={canEdit} />
    </main>
  )
}
