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

  // 降級方案定案（審查 M-6）：未登入不做 next 回跳（login 頁與 OAuth callback 的 redirect
  // 白名單改動屬回國後範圍，見 README 已知限制），請使用者登入後重新開啟這個邀請連結。
  if (!user) {
    return (
      <main className="mx-auto mt-24 w-96 text-center">
        <h1 className="mb-2 text-xl font-bold">請先登入</h1>
        <p className="mb-4 text-sm text-gray-500">登入後請重新開啟這個邀請連結。</p>
        <Link href="/login" className="text-sm underline">前往登入</Link>
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
