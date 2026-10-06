import { useCallback } from 'react'
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom'

/** Router navigation as a plain command: React Router 7 returns a promise that event handlers never await. */
export function useGo(): (to: To, options?: NavigateOptions) => void {
  const navigate = useNavigate()
  return useCallback(
    (to: To, options?: NavigateOptions) => {
      void navigate(to, options)
    },
    [navigate],
  )
}
