import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type CrumbSetter = (crumb: readonly string[]) => void

const CrumbContext = createContext<{ readonly crumb: readonly string[]; readonly set: CrumbSetter }>({
  crumb: [],
  set: () => undefined,
})

export function CrumbProvider({ children }: { readonly children: ReactNode }) {
  const [crumb, set] = useState<readonly string[]>([])
  return <CrumbContext.Provider value={{ crumb, set }}>{children}</CrumbContext.Provider>
}

/** Each space declares the object it shows; the top bar renders it. */
export function useCrumb(...parts: readonly (string | undefined)[]): void {
  const { set } = useContext(CrumbContext)
  const key = parts.filter(Boolean).join('\u0000')
  useEffect(() => {
    set(key ? key.split('\u0000') : [])
  }, [key, set])
}

export const useCurrentCrumb = (): readonly string[] => useContext(CrumbContext).crumb
