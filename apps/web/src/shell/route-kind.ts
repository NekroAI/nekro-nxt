export const canvasKind = (pathname: string): string => {
  if (pathname.startsWith('/connections')) return 'connections'
  if (pathname.startsWith('/users')) return 'users'
  if (pathname.startsWith('/extensions')) return 'extensions'
  if (pathname.startsWith('/settings')) return 'settings'
  if (pathname.includes('/work/channels')) return 'work-channel'
  if (/\/work\/agents\/new\/?$/u.test(pathname)) return 'work-agent-new'
  if (pathname.includes('/work/agents/')) return 'work-agent'
  if (pathname.includes('/work/creator')) return 'work-creator'
  if (pathname.startsWith('/work')) return 'work'
  return 'other'
}

export const needsCanvasMorph = (fromPathname: string, toPathname: string): boolean =>
  canvasKind(fromPathname) !== canvasKind(toPathname)
