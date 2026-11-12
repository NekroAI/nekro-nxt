// 由 node scripts/docs-bundle.mjs readme 按使用文档页面头部的 routes 生成，不要手改。

/** Interface routes and the documentation page the help button opens there; deeper routes first. */
export const DOCS_ROUTES: readonly (readonly [route: string, page: string])[] = [
  ['/settings/about', 'ops/upgrade-backup'],
  ['/settings/access', 'ops/access'],
  ['/settings/accounts', 'ops/credentials'],
  ['/settings/addons', 'extensions/addons'],
  ['/settings/administrators', 'channels/admins-commands'],
  ['/settings/chat', 'models/choosing'],
  ['/settings/commands', 'channels/admins-commands'],
  ['/settings/conversations', 'agents/sub-conversations'],
  ['/settings/credentials', 'ops/credentials'],
  ['/settings/dsh', 'extensions/dsh-plugins'],
  ['/settings/feedback', 'troubleshooting/report'],
  ['/settings/logs', 'ops/logs'],
  ['/settings/models', 'models/providers'],
  ['/settings/notifications', 'ops/notifications'],
  ['/settings/storage', 'ops/storage'],
  ['/agents', 'agents/create'],
  ['/channels', 'channels/response'],
  ['/community', 'extensions/install'],
  ['/live', 'start/quickstart'],
  ['/logs', 'ops/logs'],
  ['/wiring', 'channels/wiring'],
  ['/workshop', 'extensions/overview'],
]
