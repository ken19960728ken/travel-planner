'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')

  async function signIn() {
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setMessage(`登入失敗：${error.message}`)
      return
    }
    router.push('/trips')
    router.refresh()
  }

  async function signUp() {
    const supabase = createClient()
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setMessage(`註冊失敗：${error.message}`)
      return
    }
    setMessage('註冊成功，請直接登入')
  }

  async function signInWithGoogle() {
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/auth/callback` },
    })
    if (error) setMessage(`Google 登入失敗：${error.message}`)
  }

  return (
    <main className="mx-auto mt-24 flex w-80 flex-col gap-3">
      <h1 className="text-2xl font-bold">Travel Planner</h1>
      <input
        className="rounded border p-2"
        type="email"
        placeholder="Email"
        value={email}
        onChange={e => setEmail(e.target.value)}
      />
      <input
        className="rounded border p-2"
        type="password"
        placeholder="密碼"
        value={password}
        onChange={e => setPassword(e.target.value)}
      />
      <button className="rounded bg-black p-2 text-white" onClick={signIn}>
        登入
      </button>
      <button className="rounded border p-2" onClick={signUp}>
        註冊
      </button>
      <button className="rounded border p-2" onClick={signInWithGoogle}>
        使用 Google 登入
      </button>
      {message && <p className="text-sm text-red-600">{message}</p>}
    </main>
  )
}
