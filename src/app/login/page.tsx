'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Notice = { kind: 'error' | 'success'; text: string } | null

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState<Notice>(() =>
    searchParams.get('error') === 'oauth_failed'
      ? { kind: 'error', text: 'Google 登入失敗，請再試一次或改用 Email 登入' }
      : null,
  )
  const [busy, setBusy] = useState(false)

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) {
      setNotice({ kind: 'error', text: '登入失敗，請確認 Email 與密碼' })
      return
    }
    router.push('/trips')
    router.refresh()
  }

  async function signUp() {
    setBusy(true)
    const supabase = createClient()
    const { data, error } = await supabase.auth.signUp({ email, password })
    setBusy(false)
    if (error) {
      const alreadyRegistered = (error as { status?: number }).status === 422
      setNotice(
        alreadyRegistered
          ? { kind: 'error', text: '這個 Email 已註冊過，請直接登入' }
          : { kind: 'error', text: '註冊失敗，請稍後再試' },
      )
      return
    }
    if (data.user && data.user.identities?.length === 0) {
      setNotice({ kind: 'error', text: '這個 Email 已註冊過，請直接登入' })
      return
    }
    if (data.session) {
      router.push('/trips')
      router.refresh()
      return
    }
    setNotice({ kind: 'success', text: '註冊成功，請到信箱點擊確認連結後登入' })
  }

  async function signInWithGoogle() {
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/auth/callback` },
    })
    if (error) {
      setBusy(false)
      setNotice({ kind: 'error', text: 'Google 登入失敗，請稍後再試' })
    }
  }

  return (
    <main className="mx-auto mt-24 w-80">
      <h1 className="mb-3 text-2xl font-bold">Travel Planner</h1>
      <form onSubmit={signIn} className="flex flex-col gap-3">
        <input
          className="rounded border p-2"
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <input
          className="rounded border p-2"
          type="password"
          placeholder="密碼"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
        <button className="rounded bg-foreground p-2 text-background disabled:opacity-50" type="submit" disabled={busy}>
          {busy ? '處理中…' : '登入'}
        </button>
        <button className="rounded border p-2 disabled:opacity-50" type="button" onClick={signUp} disabled={busy}>
          註冊
        </button>
        <button className="rounded border p-2 disabled:opacity-50" type="button" onClick={signInWithGoogle} disabled={busy}>
          使用 Google 登入
        </button>
        {notice && (
          <p className={`text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>
            {notice.text}
          </p>
        )}
      </form>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
