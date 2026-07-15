'use client'

import { useEffect } from 'react'
import toast from 'react-hot-toast'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

export function ToastFeedback() {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const notice = searchParams.get('notice')
  const error = searchParams.get('error')

  useEffect(() => {
    if (notice) toast.success(notice)
    if (error) toast.error(error)
    if (notice || error) router.replace(pathname, { scroll: false })
  }, [error, notice, pathname, router])

  return null
}
