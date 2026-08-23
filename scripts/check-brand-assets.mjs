import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const repositoryRoot = process.cwd()
const brandRoot = path.join(repositoryRoot, 'assets/brand')
const manifestPath = path.join(brandRoot, 'manifest.json')
const pnpmFolders = await readdir(path.join(repositoryRoot, 'node_modules/.pnpm'))
const sharpFolder = pnpmFolders.find((name) => name.startsWith('sharp@'))
if (!sharpFolder) throw new Error('找不到 Sharp，无法检查品牌资产。请先运行 pnpm install。')
const { default: sharp } = await import(
  path.join(repositoryRoot, 'node_modules/.pnpm', sharpFolder, 'node_modules/sharp/dist/index.mjs')
)

const failures = []
const expect = (condition, message) => {
  if (!condition) failures.push(message)
}
const read = async (relativePath) => {
  try {
    return await readFile(path.join(repositoryRoot, relativePath))
  } catch {
    failures.push(`缺少品牌资产：${relativePath}`)
    return undefined
  }
}

const requiredSvg = [
  'assets/brand/generated/logo/mark-primary.svg',
  'assets/brand/generated/logo/mark-dark.svg',
  'assets/brand/generated/logo/mark-micro.svg',
  'assets/brand/generated/logo/mark-monochrome.svg',
  'assets/brand/generated/logo/mark-vector.svg',
  'assets/brand/generated/logo/lockup-horizontal.svg',
  'assets/brand/generated/platform/app-icon-stable.svg',
  'assets/brand/generated/platform/app-icon-preview.svg',
  'assets/brand/generated/platform/favicon.svg',
  'assets/brand/generated/platform/pinned-tab.svg',
]
for (const category of ['process', 'status']) {
  const names =
    category === 'process'
      ? [
          'download',
          'verify',
          'unpack',
          'install',
          'configure',
          'launch',
          'connect',
          'upgrade',
          'backup',
          'restore',
          'repair',
          'uninstall',
        ]
      : ['waiting', 'running', 'success', 'warning', 'failure', 'offline']
  requiredSvg.push(...names.map((name) => `assets/brand/generated/${category}/${name}.svg`))
}
requiredSvg.push(
  ...['no-agents', 'no-connections', 'no-extensions', 'host-unreachable'].map(
    (name) => `assets/brand/generated/product/${name}.svg`,
  ),
)
for (const file of requiredSvg) {
  const data = await read(file)
  if (!data) continue
  const text = data.toString('utf8')
  expect(/^<svg[\s>]/u.test(text), `${file} 不是 SVG 根文档`)
  expect(/viewBox="[^"]+"/u.test(text), `${file} 缺少 viewBox`)
  expect(!/\.local\//u.test(text), `${file} 引用了 .local`)
}

const expectedPngs = new Map([
  ['assets/brand/exports/logo/mark-1024.png', [1024, 1024]],
  ['assets/brand/exports/logo/mark-512.png', [512, 512]],
  ['assets/brand/exports/logo/mark-256.png', [256, 256]],
  ['apps/web/public/apple-touch-icon.png', [180, 180]],
  ['apps/web/public/pwa-192.png', [192, 192]],
  ['apps/web/public/pwa-512.png', [512, 512]],
  ['apps/web/public/pwa-maskable-512.png', [512, 512]],
  ['apps/desktop/resources/stable/dmg-background.png', [660, 420]],
  ['apps/desktop/resources/preview/dmg-background.png', [660, 420]],
  ['assets/brand/exports/distribution/social-card.png', [1200, 630]],
  ['assets/brand/exports/distribution/github-social-preview.png', [1280, 640]],
  ['assets/brand/exports/distribution/release-card-stable.png', [1200, 630]],
  ['assets/brand/exports/distribution/release-card-preview.png', [1200, 630]],
  ['assets/brand/exports/review/logo-scale-test.png', [1200, 560]],
  ['assets/brand/exports/review/process-icon-board.png', [1200, 760]],
  ['assets/brand/raster/readme-hero.png', [2400, 900]],
  ['assets/brand/raster/install-desktop.webp', [1800, 600]],
  ['assets/brand/raster/install-server.webp', [1800, 600]],
  ['assets/brand/raster/welcome.png', [960, 1035]],
  ['assets/brand/raster/upgrade-complete.png', [960, 818]],
  ['assets/brand/screenshots/channel-conversation.png', [1440, 900]],
  ['assets/brand/screenshots/agent-workbench.png', [1600, 900]],
  ['assets/brand/screenshots/connections.png', [1600, 900]],
  ['assets/brand/screenshots/creator-workbench.png', [1600, 900]],
])
for (const [file, [width, height]] of expectedPngs) {
  const data = await read(file)
  if (!data) continue
  const metadata = await sharp(data).metadata()
  expect(metadata.width === width && metadata.height === height, `${file} 尺寸应为 ${width}×${height}`)
  expect(!metadata.exif && !metadata.xmp && !metadata.iptc, `${file} 含不应公开的图片元数据`)
}

for (const channel of ['stable', 'preview']) {
  const ico = await read(`apps/desktop/resources/${channel}/icon.ico`)
  if (ico) {
    const count = ico.readUInt16LE(4)
    const frames = Array.from({ length: count }, (_, index) => ico.readUInt8(6 + index * 16) || 256)
    expect(frames.join(',') === '16,20,24,32,40,48,64,128,256', `${channel} ICO 帧不完整：${frames.join(',')}`)
  }
  const icns = await read(`apps/desktop/resources/${channel}/icon.icns`)
  if (icns) expect(icns.subarray(0, 4).toString('ascii') === 'icns', `${channel} ICNS 头无效`)
  for (const [name, width, height] of [
    ['installerSidebar.bmp', 164, 314],
    ['uninstallerSidebar.bmp', 164, 314],
    ['installerHeader.bmp', 150, 57],
  ]) {
    const bmp = await read(`apps/desktop/resources/${channel}/${name}`)
    if (!bmp) continue
    expect(bmp.subarray(0, 2).toString('ascii') === 'BM', `${channel}/${name} 不是 BMP`)
    expect(bmp.readInt32LE(18) === width && bmp.readInt32LE(22) === height, `${channel}/${name} 尺寸错误`)
    expect(bmp.readUInt16LE(28) === 24, `${channel}/${name} 必须为 24-bit BMP`)
  }
}

const manifest = JSON.parse((await readFile(manifestPath)).toString('utf8'))
expect(manifest.schemaVersion === 2, '品牌 manifest schemaVersion 应为 2')
for (const item of manifest.files ?? []) {
  const file = path.join(brandRoot, item.path)
  const data = await readFile(file)
  const hash = createHash('sha256').update(data).digest('hex')
  expect(hash === item.sha256, `品牌 manifest 哈希失配：${item.path}`)
  expect(item.rightsCategory === 'brand-reserved', `品牌权利类别缺失：${item.path}`)
  expect(item.rights === 'Copyright © 2026 NekroAI. All rights reserved.', `品牌权利声明缺失：${item.path}`)
  expect(typeof item.usage === 'string' && item.usage.length > 0, `品牌用途缺失：${item.path}`)
  expect(typeof item.source === 'string' && item.source.length > 0, `品牌源文件缺失：${item.path}`)
}

const webMark = await read('apps/web/public/brand/mark.svg')
if (webMark) {
  expect(webMark.includes(Buffer.from('data:image/png;base64,')), 'Web Logo 必须自包含，不能依赖页面相对路径')
  expect(!webMark.includes(Buffer.from('href="mark-source.png"')), 'Web Logo 仍含页面相对资源引用')
}

const consumerPairs = [
  ['assets/brand/sources/logo/shuiyue-ying-avatar-source.png', 'apps/web/public/brand/mark-source.png'],
  ['assets/brand/exports/web/favicon.ico', 'apps/web/public/favicon.ico'],
  ['assets/brand/exports/web/pwa-512.png', 'apps/web/public/pwa-512.png'],
  ['assets/brand/exports/distribution/social-card.png', 'apps/web/public/brand/social-card.png'],
  ['assets/brand/generated/product/no-connections.svg', 'apps/web/public/brand/illustrations/no-connections.svg'],
  ['assets/brand/generated/product/no-extensions.svg', 'apps/web/public/brand/illustrations/no-extensions.svg'],
  ['assets/brand/raster/welcome.png', 'apps/web/public/brand/illustrations/welcome.png'],
  ['assets/brand/exports/stable/windows/icon.ico', 'apps/desktop/resources/stable/icon.ico'],
  ['assets/brand/exports/preview/windows/icon.ico', 'apps/desktop/resources/preview/icon.ico'],
]
for (const [source, consumer] of consumerPairs) {
  const [sourceData, consumerData] = await Promise.all([read(source), read(consumer)])
  if (sourceData && consumerData) expect(sourceData.equals(consumerData), `${consumer} 未与公开品牌导出同步`)
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`品牌资产检查通过：${manifest.files.length} 个生成或导出文件。`)
}
