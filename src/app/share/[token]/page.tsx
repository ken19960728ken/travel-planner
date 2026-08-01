import type { Metadata } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/supabase/database.types'
import TripView, { type Trip, type Stop, type Leg } from '../../trips/[tripId]/TripView'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// token 在 URL path，不得經 Referer 外洩到外部連結；本頁也不需要被搜尋引擎索引
export const metadata: Metadata = {
  robots: { index: false },
  referrer: 'no-referrer',
}

// get_shared_trip 的欄位白名單（migration 20260806000000）與 TripView 的 Trip/Stop/Leg 型別逐欄一致，
// 直接重用即可。database.types.ts 未重生成（本地 DB 可能已被平行任務套過其他表的 migration，重生
// 會把不相干的表混進本次 diff）——這裡以交集型別在呼叫端手動擴充 Functions，不動共用檔案。
type SharedTripPayload = {
  trip: Trip
  stops: Stop[]
  legs: Leg[]
}
type ShareRpcDatabase = Database & {
  public: {
    Functions: {
      get_shared_trip: { Args: { p_token: string }; Returns: SharedTripPayload | null }
    }
  }
}

function InvalidLink() {
  return (
    <main className="mx-auto mt-24 w-96 text-center">
      <h1 className="mb-2 text-xl font-bold">連結已失效</h1>
      <p className="mb-4 text-sm text-gray-500">這個分享連結已失效或不存在，請向分享者索取新的連結。</p>
      <Link href="/" className="text-sm underline">回首頁</Link>
    </main>
  )
}

export default async function SharedTripPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  // token 非 UUID 格式：純格式檢查，不打 RPC（比照 invite 頁的短路順序）
  if (!UUID_RE.test(token)) {
    return <InvalidLink />
  }

  const supabase = (await createClient()) as unknown as SupabaseClient<ShareRpcDatabase>
  const { data, error } = await supabase.rpc('get_shared_trip', { p_token: token })
  // token 錯誤/已重生成一律回 null，對外不區分原因（spec §6「連結已失效」語義）
  if (error || !data) {
    return <InvalidLink />
  }

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-baseline gap-3 border-b p-3">
        <Link href="/" className="text-sm text-gray-500">← 回首頁</Link>
        <h1 className="text-lg font-bold">{data.trip.title}</h1>
        <span className="text-sm text-gray-500">{data.trip.start_date} ~ {data.trip.end_date}</span>
        <span
          className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
          title="這是唯讀分享連結，免登入即可檢視"
        >
          👁 分享檢視
        </span>
      </header>
      <TripView trip={data.trip} stops={data.stops} legs={data.legs} canEdit={false} autoPlay />
    </main>
  )
}
