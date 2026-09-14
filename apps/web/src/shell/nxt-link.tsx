import { navigateWithRouteModule, prefetchRoute } from './route-modules.js'
import { forwardRef, type MouseEvent } from 'react'
import { Link, NavLink, useHref, useLocation, useNavigate, type LinkProps, type NavLinkProps } from 'react-router-dom'
import { useNxtReducedMotion } from '../ui-kit/index.js'
import { runNxtNavigation } from './nxt-navigation.js'
import { needsCanvasMorph } from './route-kind.js'

const useNxtLinkClick = (to: LinkProps['to'], onClick?: LinkProps['onClick']) => {
  const navigate = useNavigate()
  const location = useLocation()
  const href = useHref(to)
  const reduce = useNxtReducedMotion()
  return (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    const nextPath = href.split('?')[0] ?? href
    navigateWithRouteModule(href, () =>
      runNxtNavigation(
        () => {
          void navigate(href)
        },
        !reduce && needsCanvasMorph(location.pathname, nextPath),
      ),
    )
  }
}

export const NxtNavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NxtNavLink(
  { onClick, onMouseEnter, onFocus, to, ...props },
  ref,
) {
  const handleClick = useNxtLinkClick(to, onClick)
  const href = useHref(to)
  return (
    <NavLink
      onMouseEnter={(event) => {
        onMouseEnter?.(event)
        prefetchRoute(href)
      }}
      onFocus={(event) => {
        onFocus?.(event)
        prefetchRoute(href)
      }}
      {...props}
      ref={ref}
      to={to}
      onClick={handleClick}
    />
  )
})

export const NxtLink = forwardRef<HTMLAnchorElement, LinkProps>(function NxtLink(
  { onClick, onMouseEnter, onFocus, to, ...props },
  ref,
) {
  const handleClick = useNxtLinkClick(to, onClick)
  const href = useHref(to)
  return (
    <Link
      onMouseEnter={(event) => {
        onMouseEnter?.(event)
        prefetchRoute(href)
      }}
      onFocus={(event) => {
        onFocus?.(event)
        prefetchRoute(href)
      }}
      {...props}
      ref={ref}
      to={to}
      onClick={handleClick}
    />
  )
})

export function useNxtNavigate() {
  const navigate = useNavigate()
  const location = useLocation()
  const reduce = useNxtReducedMotion()
  return (to: string) => {
    const nextPath = to.split('?')[0] ?? to
    navigateWithRouteModule(to, () =>
      runNxtNavigation(
        () => {
          void navigate(to)
        },
        !reduce && needsCanvasMorph(location.pathname, nextPath),
      ),
    )
  }
}
