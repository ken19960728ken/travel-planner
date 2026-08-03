import type { Metadata } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/supabase/database.types'
import TripView, { type Trip, type Stop, type Leg } from '../../trips/[tripId]/TripView'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// C-1 修復（邊界換票）：這個頁面的 URL 永遠不含 token，token 改放 /share/[token]/route.ts 種下的
// HttpOnly cookie（path=/share，依 token 雜湊分格）。Google Maps JS 讀 window.location.href 塞進請求 body
// 時已看不到任何憑證——no-referrer 只擋 Referer header，管不到請求 body，故用「URL 裡從頭沒有 token」
// 這個更根本的手段（原本這裡的註解宣稱 no-referrer 已擋住外洩，經審查實測證偽，一併更正）。
export const metadata: Metadata = {
  robots: { index: false },
  referrer: 'no-referrer',
}

// get_shared_trip 的欄位白名單（migration 20260803000005）與 TripView 的 Trip/Stop/Leg 型別逐欄一致，
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

/** cookie 缺失／過期是**載體**的問題，連結本身可能完全正常——文案必須與「連結已失效」分開（審查 M-2）。
 *  講錯的代價很具體：旅伴回報「連結壞了」→ owner 按「重新產生」→ 其他人手上還活著的連結這下真的全死。 */
function SessionExpired() {
  return (
    <main className="mx-auto mt-24 w-96 text-center">
      <h1 className="mb-2 text-xl font-bold">請重新開啟分享連結</h1>
      <p className="mb-4 text-sm text-gray-500">
        瀏覽階段已結束（並非連結失效）。請回到分享者給你的原始連結重新打開一次即可，不需要索取新連結。
      </p>
      <Link href="/" className="text-sm underline">回首頁</Link>
    </main>
  )
}

export default async function SharedTripViewPage({
  searchParams,
}: {
  searchParams: Promise<{ k?: string }>
}) {
  // k 是由 token 單向雜湊而來的非機密識別子（見 route.ts 的 shareKeyOf）：讓同一個瀏覽器
  // 開多條分享連結時各自有獨立的 cookie 格，不會互相蓋台而靜默顯示錯的行程（審查 M-1）。
  const { k } = await searchParams
  const cookieStore = await cookies()
  const token = k && /^[0-9a-f]{16}$/.test(k) ? cookieStore.get(`share_tk_${k}`)?.value : undefined

  // 沒有 k、或該 cookie 不在（過期／換了瀏覽器／直接開 /share/view）：是瀏覽階段的問題，
  // 不是連結失效——用不同的文案，避免誘發 owner 去按「重新產生」而殺掉所有人的連結
  if (!token) {
    return <SessionExpired />
  }
  // 格式不對代表 cookie 被竄改過，這時比照無效連結處理
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
      <TripView trip={data.trip} stops={data.stops} legs={data.legs} canEdit={false}
      // 備選庫刻意不給匿名訪客：那是規劃中的內部討論材料，不是要分享的成品行程。
      // get_shared_trip 的白名單也沒有 candidates，此處傳空陣列是同一個決定的兩端。
      candidates={[]} autoPlay />
    </main>
  )
}
