import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

await import('./generate-brand-vectors.mjs')

const exec = promisify(execFile)
const repositoryRoot = process.cwd()
const brandRoot = path.join(repositoryRoot, 'assets/brand')
const generatedRoot = path.join(brandRoot, 'generated')
const exportsRoot = path.join(brandRoot, 'exports')
const desktopRoot = path.join(repositoryRoot, 'apps/desktop/resources')
const webRoot = path.join(repositoryRoot, 'apps/web/public')

const pnpmFolders = await readdir(path.join(repositoryRoot, 'node_modules/.pnpm'))
const sharpFolder = pnpmFolders.find((name) => name.startsWith('sharp@'))
if (!sharpFolder) throw new Error('找不到 Sharp，无法导出品牌资产。请先运行 pnpm install。')
const { default: sharp } = await import(
  path.join(repositoryRoot, 'node_modules/.pnpm', sharpFolder, 'node_modules/sharp/dist/index.mjs')
)

const ensure = (directory) => mkdir(directory, { recursive: true })
await rm(exportsRoot, { recursive: true, force: true })
await ensure(exportsRoot)
const embedSvgAssets = async (source) => {
  let svg = await readFile(source, 'utf8')
  const references = [...svg.matchAll(/href="([^"#]+\.(?:png|svg))"/gu)].map((match) => match[1])
  for (const reference of new Set(references)) {
    const absolute = path.resolve(path.dirname(source), reference)
    const data = await readFile(absolute)
    const mime = reference.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
    svg = svg.replaceAll(reference, `data:${mime};base64,${data.toString('base64')}`)
  }
  return Buffer.from(svg)
}
const render = async (source, destination, width, height = width, density = 384) => {
  await ensure(path.dirname(destination))
  const input = path.extname(source).toLowerCase() === '.svg' ? await embedSvgAssets(source) : source
  await sharp(input, { density }).resize(width, height).png({ compressionLevel: 9 }).toFile(destination)
}
const copy = async (source, destination) => {
  await ensure(path.dirname(destination))
  await copyFile(source, destination)
}

const createIco = async (frames, destination) => {
  const images = await Promise.all(frames.map((frame) => readFile(frame.path)))
  const directory = Buffer.alloc(6 + images.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  images.forEach((image, index) => {
    const { size } = frames[index]
    const entry = 6 + index * 16
    directory.writeUInt8(size === 256 ? 0 : size, entry)
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1)
    directory.writeUInt8(0, entry + 2)
    directory.writeUInt8(0, entry + 3)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(image.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.length
  })
  await ensure(path.dirname(destination))
  await writeFile(destination, Buffer.concat([directory, ...images]))
}

const createBmp24 = async (source, destination, width, height) => {
  const input = path.extname(source).toLowerCase() === '.svg' ? await embedSvgAssets(source) : source
  const { data } = await sharp(input, { density: 384 })
    .resize(width, height)
    .flatten({ background: '#fffdf9' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelSize = rowSize * height
  const output = Buffer.alloc(54 + pixelSize)
  output.write('BM', 0, 2, 'ascii')
  output.writeUInt32LE(output.length, 2)
  output.writeUInt32LE(54, 10)
  output.writeUInt32LE(40, 14)
  output.writeInt32LE(width, 18)
  output.writeInt32LE(height, 22)
  output.writeUInt16LE(1, 26)
  output.writeUInt16LE(24, 28)
  output.writeUInt32LE(pixelSize, 34)
  for (let y = 0; y < height; y += 1) {
    const sourceY = height - 1 - y
    const targetRow = 54 + y * rowSize
    for (let x = 0; x < width; x += 1) {
      const sourcePixel = (sourceY * width + x) * 3
      const targetPixel = targetRow + x * 3
      output[targetPixel] = data[sourcePixel + 2]
      output[targetPixel + 1] = data[sourcePixel + 1]
      output[targetPixel + 2] = data[sourcePixel]
    }
  }
  await ensure(path.dirname(destination))
  await writeFile(destination, output)
}

const primaryMark = path.join(generatedRoot, 'logo/mark-primary.svg')
for (const size of [1024, 512, 256]) {
  await render(primaryMark, path.join(exportsRoot, `logo/mark-${size}.png`), size)
}

const channels = ['stable', 'preview']
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const linuxSizes = [16, 24, 32, 48, 64, 128, 256, 512]
for (const channel of channels) {
  const appSource = path.join(generatedRoot, `platform/app-icon-${channel}.svg`)
  const faviconSource = path.join(generatedRoot, `platform/favicon${channel === 'preview' ? '-preview' : ''}.svg`)
  const channelExport = path.join(exportsRoot, channel)
  const desktopChannel = path.join(desktopRoot, channel)
  await render(appSource, path.join(channelExport, 'app-icon-1024.png'), 1024)

  const icoFrames = []
  for (const size of icoSizes) {
    const frame = path.join(channelExport, 'windows/ico-frames', `${size}x${size}.png`)
    await render(size < 48 ? faviconSource : appSource, frame, size)
    icoFrames.push({ size, path: frame })
  }
  const ico = path.join(channelExport, 'windows/icon.ico')
  await createIco(icoFrames, ico)
  await copy(ico, path.join(desktopChannel, 'icon.ico'))
  await copy(ico, path.join(desktopChannel, 'installerIcon.ico'))
  await copy(ico, path.join(desktopChannel, 'uninstallerIcon.ico'))

  for (const size of linuxSizes) {
    const output = path.join(channelExport, 'linux/icons', `${size}x${size}.png`)
    await render(size < 48 ? faviconSource : appSource, output, size)
    await copy(output, path.join(desktopChannel, 'icons', `${size}x${size}.png`))
  }

  const iconset = path.join(channelExport, 'macos/icon.iconset')
  /** @type {Array<[string, number]>} */
  const macFrames = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ]
  for (const [name, size] of macFrames) await render(appSource, path.join(iconset, name), size)
  if (process.platform === 'darwin') {
    const icns = path.join(channelExport, 'macos/icon.icns')
    await exec('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns])
    await copy(icns, path.join(desktopChannel, 'icon.icns'))
  }
  await rm(iconset, { recursive: true, force: true })

  const dmg = path.join(channelExport, 'macos/dmg-background.png')
  await render(path.join(generatedRoot, `platform/dmg-background-${channel}.svg`), dmg, 660, 420, 72)
  await copy(dmg, path.join(desktopChannel, 'dmg-background.png'))

  for (const name of ['installer-sidebar', 'uninstaller-sidebar']) {
    const bmp = path.join(channelExport, 'windows', `${name}.bmp`)
    await createBmp24(path.join(generatedRoot, `platform/${name}-${channel}.svg`), bmp, 164, 314)
    await copy(
      bmp,
      path.join(desktopChannel, `${name === 'installer-sidebar' ? 'installerSidebar' : 'uninstallerSidebar'}.bmp`),
    )
  }
  const header = path.join(channelExport, 'windows/installer-header.bmp')
  await createBmp24(path.join(generatedRoot, `platform/installer-header-${channel}.svg`), header, 150, 57)
  await copy(header, path.join(desktopChannel, 'installerHeader.bmp'))
}

const favicon = path.join(generatedRoot, 'platform/favicon.svg')
const webIcoFrames = []
for (const size of [16, 32, 48]) {
  const output = path.join(exportsRoot, 'web', `favicon-${size}.png`)
  await render(favicon, output, size)
  webIcoFrames.push({ size, path: output })
}
await createIco(webIcoFrames, path.join(exportsRoot, 'web/favicon.ico'))
await render(
  path.join(generatedRoot, 'platform/app-icon-stable.svg'),
  path.join(exportsRoot, 'web/apple-touch-icon.png'),
  180,
)
await render(path.join(generatedRoot, 'platform/app-icon-stable.svg'), path.join(exportsRoot, 'web/pwa-192.png'), 192)
await render(path.join(generatedRoot, 'platform/app-icon-stable.svg'), path.join(exportsRoot, 'web/pwa-512.png'), 512)
await render(
  path.join(generatedRoot, 'platform/app-icon-maskable.svg'),
  path.join(exportsRoot, 'web/pwa-maskable-512.png'),
  512,
)

const webMarkRaster = (await readFile(path.join(exportsRoot, 'logo/mark-256.png'))).toString('base64')
const webMark = (await readFile(primaryMark, 'utf8')).replace(
  '../../sources/logo/shuiyue-ying-avatar-source.png',
  `data:image/png;base64,${webMarkRaster}`,
)
await writeFile(path.join(webRoot, 'brand/mark.svg'), webMark)
await copy(
  path.join(brandRoot, 'sources/logo/shuiyue-ying-avatar-source.png'),
  path.join(webRoot, 'brand/mark-source.png'),
)
await copy(favicon, path.join(webRoot, 'favicon.svg'))
await copy(path.join(generatedRoot, 'platform/pinned-tab.svg'), path.join(webRoot, 'pinned-tab.svg'))
for (const name of ['favicon.ico', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png', 'pwa-maskable-512.png']) {
  await copy(path.join(exportsRoot, 'web', name), path.join(webRoot, name))
}

for (const name of ['social-card', 'github-social-preview', 'release-card-stable', 'release-card-preview']) {
  const svg = path.join(generatedRoot, `distribution/${name}.svg`)
  const dimensions = name === 'github-social-preview' ? [1280, 640] : [1200, 630]
  await render(svg, path.join(exportsRoot, 'distribution', `${name}.png`), ...dimensions)
}
await copy(path.join(exportsRoot, 'distribution/social-card.png'), path.join(webRoot, 'brand/social-card.png'))
for (const name of ['no-agents', 'no-connections', 'no-extensions', 'host-unreachable']) {
  await copy(path.join(generatedRoot, `product/${name}.svg`), path.join(webRoot, `brand/illustrations/${name}.svg`))
}
await copy(path.join(brandRoot, 'raster/welcome.png'), path.join(webRoot, 'brand/illustrations/welcome.png'))
await copy(
  path.join(brandRoot, 'raster/upgrade-complete.png'),
  path.join(webRoot, 'brand/illustrations/upgrade-complete.png'),
)

const stableIconData = (await embedSvgAssets(path.join(generatedRoot, 'platform/app-icon-stable.svg'))).toString(
  'base64',
)
const previewIconData = (await embedSvgAssets(path.join(generatedRoot, 'platform/app-icon-preview.svg'))).toString(
  'base64',
)
const scaleSizes = [16, 24, 32, 48, 64, 128]
const scaleItems = scaleSizes
  .map((size, index) => {
    const x = 72 + index * 184 + (128 - size) / 2
    return `<image href="data:image/svg+xml;base64,${stableIconData}" x="${x}" y="96" width="${size}" height="${size}"/><image href="data:image/svg+xml;base64,${previewIconData}" x="${x}" y="326" width="${size}" height="${size}"/><text x="${72 + index * 184 + 64}" y="252" text-anchor="middle" fill="#46556c" font-family="system-ui, sans-serif" font-size="18">${size}px</text>`
  })
  .join('')
const scaleBoard = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 560"><rect width="1200" height="280" fill="#fffdf9"/><rect y="280" width="1200" height="280" fill="#0a121f"/><text x="36" y="48" fill="#172a45" font-family="system-ui, sans-serif" font-size="22" font-weight="700">NekroNXT Stable · light surface</text><text x="36" y="318" fill="#f2f4f7" font-family="system-ui, sans-serif" font-size="22" font-weight="700">NekroNXT Preview · dark surface</text>${scaleItems}</svg>`
await ensure(path.join(exportsRoot, 'review'))
await sharp(Buffer.from(scaleBoard), { density: 192 })
  .resize(1200, 560)
  .png({ compressionLevel: 9 })
  .toFile(path.join(exportsRoot, 'review/logo-scale-test.png'))

const processNames = [
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
const processLabels = ['下载', '校验', '解包', '安装', '配置', '启动', '连接', '升级', '备份', '恢复', '修复', '卸载']
const stateNames = ['waiting', 'running', 'success', 'warning', 'failure', 'offline']
const stateLabels = ['等待', '进行中', '成功', '警告', '失败', '离线']
const boardItem = async (kind, name, label, index, rowOffset) => {
  const data = (await readFile(path.join(generatedRoot, `${kind}/${name}.svg`))).toString('base64')
  const column = index % 6
  const row = Math.floor(index / 6)
  const x = 54 + column * 190
  const y = rowOffset + row * 210
  return `<image href="data:image/svg+xml;base64,${data}" x="${x + 31}" y="${y}" width="96" height="96"/><text x="${x + 79}" y="${y + 132}" text-anchor="middle" fill="#172a45" font-family="system-ui, sans-serif" font-size="20">${label}</text>`
}
const processItems = await Promise.all(
  processNames.map((name, index) => boardItem('process', name, processLabels[index], index, 94)),
)
const stateItems = await Promise.all(
  stateNames.map((name, index) => boardItem('status', name, stateLabels[index], index, 518)),
)
const processBoard = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 760"><rect width="1200" height="760" fill="#fffdf9"/><text x="36" y="48" fill="#172a45" font-family="system-ui, sans-serif" font-size="26" font-weight="700">NekroNXT 安装过程与状态素材</text>${processItems.join('')}<path d="M36 472h1128" stroke="#e0e3e8"/><text x="36" y="520" fill="#172a45" font-family="system-ui, sans-serif" font-size="22" font-weight="700">状态</text>${stateItems.join('')}</svg>`
await sharp(Buffer.from(processBoard), { density: 192 })
  .resize(1200, 760)
  .png({ compressionLevel: 9 })
  .toFile(path.join(exportsRoot, 'review/process-icon-board.png'))

const collectFiles = async (directory) => {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await collectFiles(file)))
    else if (entry.name !== 'manifest.json') result.push(file)
  }
  return result
}
const files = [
  ...(await collectFiles(generatedRoot)),
  ...(await collectFiles(exportsRoot)),
  ...(await collectFiles(path.join(brandRoot, 'raster'))),
  ...(await collectFiles(path.join(brandRoot, 'screenshots'))),
].sort()
const describeManifestItem = (relativePath) => {
  if (relativePath.startsWith('generated/logo/')) {
    return {
      usage: 'Logo system master',
      source: 'sources/logo/shuiyue-ying-avatar-source.png + scripts/generate-brand-vectors.mjs',
    }
  }
  if (relativePath.startsWith('generated/platform/')) {
    return {
      usage: 'Platform and installer vector master',
      source: 'generated/logo/ + scripts/generate-brand-vectors.mjs',
    }
  }
  if (relativePath.startsWith('generated/process/')) {
    return { usage: 'Installation and maintenance process icon', source: 'scripts/generate-brand-vectors.mjs' }
  }
  if (relativePath.startsWith('generated/status/')) {
    return { usage: 'Installation and maintenance status icon', source: 'scripts/generate-brand-vectors.mjs' }
  }
  if (relativePath.startsWith('generated/product/')) {
    return { usage: 'Welcome or major empty-state illustration', source: 'scripts/generate-brand-vectors.mjs' }
  }
  if (relativePath.startsWith('generated/distribution/')) {
    return {
      usage: 'Repository, social or Release distribution artwork',
      source: 'generated/logo/ + scripts/generate-brand-vectors.mjs',
    }
  }
  if (relativePath.startsWith('exports/review/')) {
    return { usage: 'Human visual review board', source: 'generated/ + scripts/export-brand-assets.mjs' }
  }
  if (relativePath.startsWith('exports/')) {
    return { usage: 'Platform-ready generated export', source: 'generated/ + scripts/export-brand-assets.mjs' }
  }
  if (relativePath.startsWith('raster/')) {
    return {
      usage: 'README, installation or product brand illustration',
      source: 'raster/README.md imagegen specification',
    }
  }
  if (relativePath.startsWith('screenshots/')) {
    return {
      usage: 'Public product screenshot with fictional data',
      source: 'apps/web/e2e/product-quality.spec.ts production journey',
    }
  }
  return { usage: 'Brand production documentation', source: 'NekroAI brand production workflow' }
}
const manifest = []
for (const file of files) {
  const data = await readFile(file)
  const extension = path.extname(file).slice(1).toLowerCase()
  const relativePath = path.relative(brandRoot, file)
  /** @type {Record<string, unknown>} */
  const item = {
    path: relativePath,
    format: extension,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    rightsCategory: 'brand-reserved',
    rights: 'Copyright © 2026 NekroAI. All rights reserved.',
    ...describeManifestItem(relativePath),
  }
  if (extension === 'png' || extension === 'webp') {
    const metadata = await sharp(data).metadata()
    Object.assign(item, { width: metadata.width, height: metadata.height, alpha: metadata.hasAlpha })
  } else if (extension === 'svg') {
    const viewBox = data.toString('utf8').match(/viewBox="([^"]+)"/u)?.[1]
    if (viewBox) item.viewBox = viewBox
  } else if (extension === 'bmp') {
    Object.assign(item, {
      width: data.readInt32LE(18),
      height: data.readInt32LE(22),
      bitsPerPixel: data.readUInt16LE(28),
    })
  } else if (extension === 'ico') {
    const count = data.readUInt16LE(4)
    item.frames = Array.from({ length: count }, (_, index) => data.readUInt8(6 + index * 16) || 256)
  }
  manifest.push(item)
}
await writeFile(
  path.join(brandRoot, 'manifest.json'),
  `${JSON.stringify({ schemaVersion: 2, generatedBy: 'scripts/export-brand-assets.mjs', files: manifest }, null, 2)}\n`,
)

console.log(`品牌导出已同步到 ${path.relative(repositoryRoot, exportsRoot)}、Desktop 与 Web 消费目录。`)
