'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function SignOutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function signOut() {
    setBusy(true)
    setFailed(false)
    const supabase = createClient()
    const { error } = await supabase.auth.signOut()
    if (error) {
      setBusy(false)
      setFailed(true)
      return
    }
    router.push('/login')
    router.refresh()
  }

  return (
    <button
      className="text-sm text-gray-500 underline disabled:opacity-50"
      onClick={signOut}
      disabled={busy}
    >
      {failed ? '登出失敗，再試一次' : '登出'}
    </button>
  )
}
