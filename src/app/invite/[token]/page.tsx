import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import AcceptButton from './AcceptButton'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// token 在 URL path，不得經 Referer 外洩到外部連結；本頁也不需要被搜尋引擎索引
export const metadata: Metadata = {
  robots: { index: false },
  referrer: 'no-referrer',
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  // token 非 UUID 格式：純格式檢查，不打 RPC（無效連結不因登入與否而有不同結果）
  if (!UUID_RE.test(token)) {
    return (
      <main className="mx-auto mt-24 w-96 text-center">
        <h1 className="mb-2 text-xl font-bold">邀請連結無效或已過期</h1>
        <p className="mb-4 text-sm text-gray-500">請向邀請你的旅伴確認連結是否正確。</p>
        <Link href="/" className="text-sm underline">回首頁</Link>
      </main>
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Step 4：未登入導向登入頁並帶 next，登入完成（含 Google OAuth 往返）後自動回跳這個邀請頁，
  // 不需要使用者手動重新開啟連結
  if (!user) {
    return (
      <main className="mx-auto mt-24 w-96 text-center">
        <h1 className="mb-2 text-xl font-bold">請先登入</h1>
        <p className="mb-4 text-sm text-gray-500">登入後將自動回到這個邀請頁面。</p>
        <Link href={`/login?next=/invite/${token}`} className="text-sm underline">前往登入</Link>
      </main>
    )
  }

  return (
    <main className="mx-auto mt-24 w-96 text-center">
      <h1 className="mb-4 text-xl font-bold">你被邀請加入行程</h1>
      <AcceptButton token={token} />
    </main>
  )
}
