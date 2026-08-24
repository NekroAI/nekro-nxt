import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const repositoryRoot = process.cwd()
const brandRoot = path.join(repositoryRoot, 'assets/brand')
const manifestPath = path.join(brandRoot, 'manifest.json')
const exec = promisify(execFile)
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
const embedSvgAssets = async (source) => {
  let svg = await readFile(source, 'utf8')
  const references = [...svg.matchAll(/href="([^"#]+\.(?:png|svg))"/gu)].map((match) => match[1])
  for (const reference of new Set(references)) {
    const data = await readFile(path.resolve(path.dirname(source), reference))
    const mime = reference.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
    svg = svg.replaceAll(reference, `data:${mime};base64,${data.toString('base64')}`)
  }
  return Buffer.from(svg)
}
const renderSvgRaw = async (source, size) =>
  sharp(await embedSvgAssets(source), { density: 384 })
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer()
const parseIcnsChunks = (data) => {
  if (data.subarray(0, 4).toString('ascii') !== 'icns') throw new Error('ICNS 文件头无效')
  if (data.readUInt32BE(4) !== data.length) throw new Error('ICNS 总长度字段无效')
  const chunks = new Map()
  for (let offset = 8; offset < data.length;) {
    if (offset + 8 > data.length) throw new Error('ICNS chunk 头被截断')
    const type = data.toString('ascii', offset, offset + 4)
    const length = data.readUInt32BE(offset + 4)
    if (length < 8 || offset + length > data.length) throw new Error(`ICNS ${type} chunk 长度无效`)
    if (chunks.has(type)) throw new Error(`ICNS 含重复 ${type} chunk`)
    chunks.set(type, data.subarray(offset + 8, offset + length))
    offset += length
  }
  return chunks
}
const decodeIcnsArgb = (data, size) => {
  if (data.subarray(0, 4).toString('ascii') !== 'ARGB') throw new Error(`${size}px ICNS ARGB 头无效`)
  let offset = 4
  const channels = []
  for (let channel = 0; channel < 4; channel += 1) {
    const output = []
    while (output.length < size * size) {
      if (offset >= data.length) throw new Error(`${size}px ICNS ARGB 数据被截断`)
      const control = data[offset]
      offset += 1
      if (control < 128) {
        const count = control + 1
        if (offset + count > data.length) throw new Error(`${size}px ICNS ARGB literal 被截断`)
        for (let index = 0; index < count; index += 1) output.push(data[offset + index])
        offset += count
      } else {
        const count = control - 125
        if (offset >= data.length) throw new Error(`${size}px ICNS ARGB run 被截断`)
        const value = data[offset]
        offset += 1
        for (let index = 0; index < count; index += 1) output.push(value)
      }
      if (output.length > size * size) throw new Error(`${size}px ICNS ARGB channel 溢出`)
    }
    channels.push(output)
  }
  if (offset !== data.length) throw new Error(`${size}px ICNS ARGB 含尾随数据`)
  const rgba = Buffer.alloc(size * size * 4)
  for (let index = 0; index < size * size; index += 1) {
    rgba[index * 4] = channels[1][index]
    rgba[index * 4 + 1] = channels[2][index]
    rgba[index * 4 + 2] = channels[3][index]
    rgba[index * 4 + 3] = channels[0][index]
  }
  return rgba
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
  'assets/brand/generated/platform/app-icon-macos-stable.svg',
  'assets/brand/generated/platform/app-icon-macos-preview.svg',
  'assets/brand/generated/platform/app-icon-macos-micro-16-stable.svg',
  'assets/brand/generated/platform/app-icon-macos-micro-16-preview.svg',
  'assets/brand/generated/platform/app-icon-macos-micro-32-stable.svg',
  'assets/brand/generated/platform/app-icon-macos-micro-32-preview.svg',
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

for (const channel of ['stable', 'preview']) {
  const genericIcon = (await read(`assets/brand/generated/platform/app-icon-${channel}.svg`))?.toString('utf8')
  const macosIcon = (await read(`assets/brand/generated/platform/app-icon-macos-${channel}.svg`))?.toString('utf8')
  if (genericIcon) expect(!genericIcon.includes('data-platform="macos"'), `${channel} 通用图标不得变成 macOS 专用源`)
  if (macosIcon) {
    expect(macosIcon.includes('data-platform="macos"'), `${channel} macOS 图标缺少平台标记`)
    expect(macosIcon.includes('translate(-82 -82) scale(1.16)'), `${channel} macOS 图标头像章没有按中心放大`)
    expect(macosIcon.includes('<rect width="1024" height="1024" fill="#021a3e"/>'), `${channel} macOS 图标缺少满版底`)
    expect(!macosIcon.includes('macos-app-shape'), `${channel} macOS 图标不应预绘系统圆角遮罩`)
  }
  if (channel === 'preview' && macosIcon) {
    expect(macosIcon.includes('三节点 Preview 校准标记'), 'Preview macOS 图标缺少校准标记说明')
    expect(macosIcon.includes('<circle cx="119" cy="66" r="22" fill="#3fb1ea"/>'), 'Preview macOS 图标缺少校准标记')
  }
  for (const logicalSize of [16, 32]) {
    const microIcon = (
      await read(`assets/brand/generated/platform/app-icon-macos-micro-${logicalSize}-${channel}.svg`)
    )?.toString('utf8')
    if (!microIcon) continue
    expect(microIcon.includes(`data-logical-size="${logicalSize}"`), `${channel} macOS ${logicalSize}px micro 标记错误`)
    expect(microIcon.includes('fill="#021a3e"'), `${channel} macOS ${logicalSize}px micro 缺少满版底`)
    if (channel === 'preview') {
      expect(microIcon.includes('三节点 Preview 校准标记'), `Preview macOS ${logicalSize}px micro 缺少校准标记说明`)
    }
  }

  const dmgSvg = (await read(`assets/brand/generated/platform/dmg-background-${channel}.svg`))?.toString('utf8')
  if (dmgSvg) {
    const safeHeight = Number(dmgSvg.match(/data-initial-visible-safe-height="(\d+)"/u)?.[1])
    const essentialBottoms = [...dmgSvg.matchAll(/data-essential-bottom="(\d+)"/gu)].map((match) => Number(match[1]))
    expect(safeHeight === 356, `${channel} DMG 首屏安全高度必须为 356`)
    expect(essentialBottoms.length > 0, `${channel} DMG 缺少首屏必要内容标记`)
    expect(
      essentialBottoms.every((bottom) => bottom <= safeHeight),
      `${channel} DMG 必要内容超出首屏安全高度`,
    )
  }
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
  const { data, info } = await sharp(path.join(brandRoot, `exports/${channel}/macos/dmg-background.png`))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let maxArtworkY = -1
  let pixelsBelowSafeRow = 0
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 4
      const isBackground =
        data[offset] === 255 && data[offset + 1] === 253 && data[offset + 2] === 249 && data[offset + 3] === 255
      if (!isBackground) {
        maxArtworkY = Math.max(maxArtworkY, y)
        if (y > 356) pixelsBelowSafeRow += 1
      }
    }
  }
  expect(
    maxArtworkY <= 356 && pixelsBelowSafeRow === 0,
    `${channel} DMG 栅格图在安全行下仍有 ${pixelsBelowSafeRow} 个非背景像素，最大 y=${maxArtworkY}`,
  )
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

const portableIcnsRoutes = [
  ['icon_16x16.png', 16, 'ic04', 'argb', 'micro-16-'],
  ['icon_16x16@2x.png', 32, 'ic11', 'png', 'micro-16-'],
  ['icon_32x32.png', 32, 'ic05', 'argb', 'micro-32-'],
  ['icon_32x32@2x.png', 64, 'ic12', 'png', 'micro-32-'],
  ['icon_128x128.png', 128, 'ic07', 'png', ''],
  ['icon_128x128@2x.png', 256, 'ic13', 'png', ''],
  ['icon_256x256.png', 256, 'ic08', 'png', ''],
  ['icon_256x256@2x.png', 512, 'ic14', 'png', ''],
  ['icon_512x512.png', 512, 'ic09', 'png', ''],
  ['icon_512x512@2x.png', 1024, 'ic10', 'png', ''],
]
const portableDecodedFrames = new Map()
for (const channel of ['stable', 'preview']) {
  const icns = await readFile(path.join(brandRoot, `exports/${channel}/macos/icon.icns`))
  const chunks = parseIcnsChunks(icns)
  for (const [frame, size, chunkType, encoding, variant] of portableIcnsRoutes) {
    const chunk = chunks.get(chunkType)
    if (!chunk) {
      failures.push(`${channel} ICNS 缺少 ${frame} 对应的 ${chunkType} chunk`)
      continue
    }
    const actual = encoding === 'argb' ? decodeIcnsArgb(chunk, size) : await sharp(chunk).ensureAlpha().raw().toBuffer()
    const source = path.join(brandRoot, 'generated/platform', `app-icon-macos-${variant}${channel}.svg`)
    const expected = await renderSvgRaw(source, size)
    portableDecodedFrames.set(`${channel}/${frame}`, actual)
    expect(actual.equals(expected), `${channel}/${frame} ICNS chunk 与 ${path.basename(source)} 的新鲜渲染不一致`)
  }
}
for (const frame of ['icon_16x16.png', 'icon_16x16@2x.png', 'icon_32x32.png', 'icon_32x32@2x.png']) {
  const stable = portableDecodedFrames.get(`stable/${frame}`)
  const preview = portableDecodedFrames.get(`preview/${frame}`)
  if (!stable || !preview) continue
  let changedPixels = 0
  for (let offset = 0; offset < stable.length; offset += 4) {
    if (
      Math.abs(stable[offset] - preview[offset]) > 8 ||
      Math.abs(stable[offset + 1] - preview[offset + 1]) > 8 ||
      Math.abs(stable[offset + 2] - preview[offset + 2]) > 8
    ) {
      changedPixels += 1
    }
  }
  const changedRatio = changedPixels / (stable.length / 4)
  expect(changedRatio >= 0.05, `Preview ${frame} 与 Stable 像素区分不足：${(changedRatio * 100).toFixed(3)}%`)
}

if (process.platform === 'darwin') {
  const expectedIcnsFrames = new Map([
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
  ])
  const decodedFrames = new Map()
  for (const channel of ['stable', 'preview']) {
    const reviewDirectory = await mkdtemp(path.join(tmpdir(), `nekro-nxt-${channel}-icns-`))
    const iconset = path.join(reviewDirectory, 'icon.iconset')
    try {
      await exec('/usr/bin/iconutil', [
        '-c',
        'iconset',
        path.join(repositoryRoot, `apps/desktop/resources/${channel}/icon.icns`),
        '-o',
        iconset,
      ])
      const frames = (await readdir(iconset)).sort()
      expect(
        frames.join(',') === [...expectedIcnsFrames.keys()].sort().join(','),
        `${channel} ICNS 解码后必须包含十个标准帧：${frames.join(',')}`,
      )
      for (const [name, expectedSize] of expectedIcnsFrames) {
        if (!frames.includes(name)) continue
        const { data, info } = await sharp(path.join(iconset, name))
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        decodedFrames.set(`${channel}/${name}`, data)
        let minX = info.width
        let minY = info.height
        let maxX = -1
        let maxY = -1
        let visiblePixels = 0
        let alphaSum = 0
        for (let y = 0; y < info.height; y += 1) {
          for (let x = 0; x < info.width; x += 1) {
            const alpha = data[(y * info.width + x) * 4 + 3]
            alphaSum += alpha
            if (alpha > 0) {
              visiblePixels += 1
              minX = Math.min(minX, x)
              minY = Math.min(minY, y)
              maxX = Math.max(maxX, x)
              maxY = Math.max(maxY, y)
            }
          }
        }
        const coverage = visiblePixels / (info.width * info.height)
        const meanAlpha = alphaSum / (255 * info.width * info.height)
        expect(info.width === expectedSize && info.height === expectedSize, `${channel}/${name} 尺寸错误`)
        expect(
          minX === 0 && minY === 0 && maxX === expectedSize - 1 && maxY === expectedSize - 1,
          `${channel}/${name} alpha bounds 未占满画布：${[minX, minY, maxX, maxY].join(',')}`,
        )
        expect(coverage >= 0.999, `${channel}/${name} 非透明覆盖率过低：${(coverage * 100).toFixed(3)}%`)
        expect(meanAlpha >= 0.999, `${channel}/${name} 平均 alpha 过低：${(meanAlpha * 100).toFixed(3)}%`)
      }
    } finally {
      await rm(reviewDirectory, { recursive: true, force: true })
    }
  }
  for (const channel of ['stable', 'preview']) {
    for (const [frame, size, source] of /** @type {Array<[string, number, string]>} */ ([
      ['icon_16x16@2x.png', 32, `app-icon-macos-micro-16-${channel}.svg`],
      ['icon_32x32@2x.png', 64, `app-icon-macos-micro-32-${channel}.svg`],
      ['icon_128x128.png', 128, `app-icon-macos-${channel}.svg`],
    ])) {
      const expected = await renderSvgRaw(path.join(brandRoot, 'generated/platform', source), size)
      const actual = decodedFrames.get(`${channel}/${frame}`)
      expect(actual?.equals(expected), `${channel}/${frame} 未由 ${source} 可复现生成`)
    }
  }
  for (const frame of ['icon_16x16.png', 'icon_16x16@2x.png', 'icon_32x32.png', 'icon_32x32@2x.png']) {
    const stable = decodedFrames.get(`stable/${frame}`)
    const preview = decodedFrames.get(`preview/${frame}`)
    if (!stable || !preview) continue
    let changedPixels = 0
    for (let offset = 0; offset < stable.length; offset += 4) {
      if (
        Math.abs(stable[offset] - preview[offset]) > 8 ||
        Math.abs(stable[offset + 1] - preview[offset + 1]) > 8 ||
        Math.abs(stable[offset + 2] - preview[offset + 2]) > 8
      ) {
        changedPixels += 1
      }
    }
    const changedRatio = changedPixels / (stable.length / 4)
    expect(changedRatio >= 0.05, `Preview ${frame} 与 Stable 像素区分不足：${(changedRatio * 100).toFixed(3)}%`)
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
for (const channel of ['stable', 'preview']) {
  const macosIcon = manifest.files.find((item) => item.path === `exports/${channel}/macos/icon.icns`)
  expect(
    macosIcon?.source ===
      `generated/platform/app-icon-macos-{micro-16-,micro-32-,}${channel}.svg + scripts/export-brand-assets.mjs`,
    `${channel} ICNS manifest 必须指向 macOS 专用母版`,
  )
  const expectedSourceRouting = {
    'icon_16x16.png': `generated/platform/app-icon-macos-micro-16-${channel}.svg`,
    'icon_16x16@2x.png': `generated/platform/app-icon-macos-micro-16-${channel}.svg`,
    'icon_32x32.png': `generated/platform/app-icon-macos-micro-32-${channel}.svg`,
    'icon_32x32@2x.png': `generated/platform/app-icon-macos-micro-32-${channel}.svg`,
    'icon_128x128.png': `generated/platform/app-icon-macos-${channel}.svg`,
    'icon_128x128@2x.png': `generated/platform/app-icon-macos-${channel}.svg`,
    'icon_256x256.png': `generated/platform/app-icon-macos-${channel}.svg`,
    'icon_256x256@2x.png': `generated/platform/app-icon-macos-${channel}.svg`,
    'icon_512x512.png': `generated/platform/app-icon-macos-${channel}.svg`,
    'icon_512x512@2x.png': `generated/platform/app-icon-macos-${channel}.svg`,
  }
  expect(
    JSON.stringify(macosIcon?.sourceRouting) === JSON.stringify(expectedSourceRouting),
    `${channel} ICNS manifest 帧来源路由错误`,
  )
  for (const relativePath of [
    `exports/${channel}/app-icon-1024.png`,
    `exports/${channel}/windows/icon.ico`,
    `exports/${channel}/linux/icons/512x512.png`,
  ]) {
    const item = manifest.files.find((candidate) => candidate.path === relativePath)
    expect(
      item?.source === `generated/platform/app-icon-${channel}.svg + scripts/export-brand-assets.mjs`,
      `${relativePath} 必须继续指向通用图标母版`,
    )
  }
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
  ['assets/brand/exports/stable/macos/icon.icns', 'apps/desktop/resources/stable/icon.icns'],
  ['assets/brand/exports/preview/macos/icon.icns', 'apps/desktop/resources/preview/icon.icns'],
  ['assets/brand/exports/stable/macos/dmg-background.png', 'apps/desktop/resources/stable/dmg-background.png'],
  ['assets/brand/exports/preview/macos/dmg-background.png', 'apps/desktop/resources/preview/dmg-background.png'],
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
