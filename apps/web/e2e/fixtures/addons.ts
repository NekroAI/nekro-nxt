import { AddonStatusSchema, type AddonProviderStatus, type AddonStatus } from '@nekro-nxt/contracts'

/** A provider row with the fields every fixture leaves at their defaults. */
export const addonProvider = (
  provider: Partial<AddonProviderStatus> & Pick<AddonProviderStatus, 'id' | 'title' | 'state'>,
): AddonProviderStatus => ({
  summary: '',
  resources: { notes: [] },
  licenses: [],
  sources: [],
  installable: provider.state === 'not-installed' || provider.state === 'failed',
  removable: false,
  ...provider,
})

/** The four add-ons of a fictional desktop host: a system gh, a downloadable Node, no browser, no semantic model. */
export const addonsFixture = (
  overrides: Partial<Record<AddonStatus['id'], Partial<AddonStatus>>> = {},
): AddonStatus[] => {
  const addons: readonly AddonStatus[] = [
    {
      id: 'retrieval',
      group: 'extension',
      title: '语义检索',
      summary: '按意思检索扩展保存的内容，例如表情包。',
      usedBy: ['扩展的检索'],
      state: 'not-installed',
      providers: [
        addonProvider({
          id: 'bge-small-zh',
          title: '内置 bge-small-zh',
          summary: '在这台设备上运行的小型中文模型，内容不会发到别处。',
          state: 'not-installed',
          resources: { downloadBytes: 48 * 1024 * 1024, notes: [] },
          licenses: [
            { component: 'bge-small-zh-v1.5', name: 'MIT', url: 'https://huggingface.co/BAAI/bge-small-zh-v1.5' },
          ],
          sources: ['Hugging Face', 'hf-mirror.com'],
        }),
      ],
    },
    {
      id: 'node',
      group: 'agent',
      title: '编排运行环境',
      summary: '智能体用编排模式运行程序时需要。',
      usedBy: ['编排模式'],
      state: 'not-installed',
      providers: [
        addonProvider({
          id: 'download',
          title: '下载的 Node',
          summary: '',
          state: 'not-installed',
          version: '24.21.0',
          resources: { downloadBytes: 50 * 1024 * 1024, notes: [] },
          licenses: [{ component: 'Node.js', name: 'MIT', url: 'https://github.com/nodejs/node/blob/main/LICENSE' }],
          sources: ['nodejs.org'],
        }),
      ],
    },
    {
      id: 'github-cli',
      group: 'agent',
      title: 'GitHub CLI',
      summary: '智能体在命令里用 gh 操作 GitHub。',
      usedBy: ['智能体命令'],
      state: 'available',
      selected: 'system',
      providers: [
        addonProvider({
          id: 'system',
          title: '这台设备的 gh',
          summary: '',
          state: 'available',
          source: 'system',
          version: '2.90.0',
        }),
        addonProvider({
          id: 'download',
          title: '下载的 gh',
          summary: '',
          state: 'not-installed',
          version: '2.102.0',
          resources: { downloadBytes: 15 * 1024 * 1024, notes: [] },
          licenses: [{ component: 'GitHub CLI', name: 'MIT', url: 'https://github.com/cli/cli/blob/trunk/LICENSE' }],
          sources: ['GitHub Releases'],
        }),
      ],
    },
    {
      id: 'browser',
      group: 'host',
      title: '后台浏览器',
      summary: '没有打开 NekroNXT 页面时，检查智能体做的扩展界面。',
      usedBy: ['扩展界面检查'],
      state: 'not-installed',
      providers: [
        addonProvider({
          id: 'download',
          title: '下载的 Chromium',
          summary: '',
          state: 'not-installed',
          resources: { downloadBytes: 110 * 1024 * 1024, notes: [] },
          sources: ['Playwright（cdn.playwright.dev）'],
        }),
      ],
    },
  ]
  return addons.map((addon) => AddonStatusSchema.parse({ ...addon, ...overrides[addon.id] }))
}
