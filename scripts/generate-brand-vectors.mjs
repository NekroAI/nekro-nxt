import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const repositoryRoot = process.cwd()
const brandRoot = path.join(repositoryRoot, 'assets/brand')
const sourceLogo = path.join(brandRoot, 'sources/logo/shuiyue-ying-avatar-source.png')
const generatedRoot = path.join(brandRoot, 'generated')

const pnpmFolders = await readdir(path.join(repositoryRoot, 'node_modules/.pnpm'))
const sharpFolder = pnpmFolders.find((name) => name.startsWith('sharp@'))
if (!sharpFolder) throw new Error('找不到 Sharp，无法生成品牌资产。请先运行 pnpm install。')
const { default: sharp } = await import(
  path.join(repositoryRoot, 'node_modules/.pnpm', sharpFolder, 'node_modules/sharp/dist/index.mjs')
)
const require = createRequire(import.meta.url)
const ImageTracer = require('imagetracerjs')

const ensureDirectory = (file) => mkdir(path.dirname(file), { recursive: true })
const writeAsset = async (relativePath, contents) => {
  const destination = path.join(generatedRoot, relativePath)
  await ensureDirectory(destination)
  await writeFile(destination, `${contents.trim().replace(/[ \t]+$/gmu, '')}\n`)
}

const traceLogo = async ({ size, colors, pathomit, blur, title, description }) => {
  const { data, info } = await sharp(sourceLogo)
    .resize(size, size, { fit: 'cover' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let svg = ImageTracer.imagedataToSVG(
    { width: info.width, height: info.height, data: new Uint8ClampedArray(data) },
    {
      ltres: 1.5,
      qtres: 1.5,
      pathomit,
      roundcoords: 1,
      numberofcolors: colors,
      colorsampling: 2,
      colorquantcycles: 3,
      blurradius: blur,
      blurdelta: 24,
      scale: 1024 / size,
    },
  )
  svg = svg
    .replace(
      /<svg[^>]*>/u,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">\n<title id="title">${title}</title>\n<desc id="desc">${description}</desc>`,
    )
    .replace('</svg>', '\n</svg>')
  return svg
}

const vectorPrimary = await traceLogo({
  size: 512,
  colors: 20,
  pathomit: 14,
  blur: 1,
  title: 'NekroNXT Logo',
  description: '水月荧侧脸头像、深蓝帽饰、圆框眼镜、金色圆环与水母头饰组成的项目标志。',
})
const vectorMicro = await traceLogo({
  size: 128,
  colors: 8,
  pathomit: 10,
  blur: 2,
  title: 'NekroNXT macOS 微型 Logo',
  description: '为 macOS 16–32px 图标减少色阶与细碎线条的水月荧头像章。',
})
const normalizedLogoBuffer = await sharp(await readFile(sourceLogo))
  .resize(1254, 1254, { fit: 'cover' })
  .png({ compressionLevel: 9 })
  .toBuffer()
const logoDataUrl = '../../sources/logo/shuiyue-ying-avatar-source.png'
const primary = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">
  <title id="title">NekroNXT Logo</title>
  <desc id="desc">水月荧侧脸头像、深蓝帽饰、圆框眼镜、金色圆环与水母头饰组成的项目标志。</desc>
  <defs><clipPath id="mark-circle"><circle cx="512" cy="512" r="500"/></clipPath></defs>
  <image href="${logoDataUrl}" width="1024" height="1024" preserveAspectRatio="xMidYMid slice" clip-path="url(#mark-circle)"/>
</svg>`
const microRaster = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">
  <title id="title">NekroNXT 微型 Logo</title>
  <desc id="desc">为小尺寸显示裁切的水月荧头像章。</desc>
  <defs><clipPath id="mark-circle"><circle cx="512" cy="512" r="500"/></clipPath></defs>
  <image href="${logoDataUrl}" width="1024" height="1024" preserveAspectRatio="xMidYMid slice" clip-path="url(#mark-circle)"/>
</svg>`

const bodyOf = (svg) =>
  svg
    .replace(/^.*?<desc[^>]*>.*?<\/desc>/su, '')
    .replace(/<svg[^>]*>/u, '')
    .replace('</svg>', '')
    .trim()
const primaryBody = bodyOf(primary)
const microBody = bodyOf(microRaster)
const vectorMicroBody = bodyOf(vectorMicro)
const monochrome = vectorPrimary
  .replace('<title id="title">NekroNXT Logo</title>', '<title id="title">NekroNXT 单色 Logo</title>')
  .replace(/fill="[^"]+"/gu, 'fill="currentColor"')
  .replace(/stroke="[^"]+"/gu, 'stroke="currentColor"')
  .replace(/ opacity="[^"]+"/gu, '')

await writeAsset('logo/mark-primary.svg', primary)
await writeAsset('logo/mark-dark.svg', primary)
await writeAsset('logo/mark-micro.svg', microRaster)
await writeAsset('logo/mark-micro-dark.svg', microRaster)
await writeAsset('logo/mark-monochrome.svg', monochrome)
await writeAsset('logo/mark-vector.svg', vectorPrimary)
await writeAsset(
  'logo/lockup-horizontal.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1520 420" role="img" aria-labelledby="title desc">
  <title id="title">NekroNXT 横向组合标</title>
  <desc id="desc">水月荧头像章与 NekroNXT 字标。</desc>
  <g transform="translate(24 10) scale(.39)">${primaryBody}</g>
  <text x="456" y="246" fill="#172a45" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="172" font-weight="700" letter-spacing="-5">NekroNXT</text>
  <text x="466" y="320" fill="#466394" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="38" font-weight="600" letter-spacing="6">NEKROAI · NXT</text>
</svg>`,
)

const appIcon = ({
  preview,
}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">
  <title id="title">NekroNXT${preview ? ' Preview' : ''} 应用图标</title>
  <desc id="desc">水月荧头像章${preview ? '，右下角带三节点 Preview 校准标记' : ''}。</desc>
  <defs><clipPath id="app-shape"><rect x="42" y="42" width="940" height="940" rx="224"/></clipPath></defs>
  <g clip-path="url(#app-shape)">${primaryBody}</g>
  <rect x="42" y="42" width="940" height="940" rx="224" fill="none" stroke="#d0a66c" stroke-width="24"/>
  ${
    preview
      ? '<g transform="translate(704 734)"><rect width="238" height="132" rx="66" fill="#fffdf9" stroke="#172a45" stroke-width="18"/><path d="M54 66h130" stroke="#b98c4a" stroke-width="14" stroke-linecap="round"/><circle cx="54" cy="66" r="22" fill="#d0a66c"/><circle cx="119" cy="66" r="22" fill="#3fb1ea"/><circle cx="184" cy="66" r="22" fill="#d0a66c"/></g>'
      : ''
  }
</svg>`
await writeAsset('platform/app-icon-stable.svg', appIcon({ preview: false }))
await writeAsset('platform/app-icon-preview.svg', appIcon({ preview: true }))

const macosAppIcon = ({
  preview,
}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc" data-platform="macos">
  <title id="title">NekroNXT${preview ? ' Preview' : ''} macOS 应用图标</title>
  <desc id="desc">为 macOS 系统遮罩提供满版深靛底，并居中放大水月荧头像章${preview ? '，右下角保留三节点 Preview 校准标记' : ''}。</desc>
  <rect width="1024" height="1024" fill="#021a3e"/>
  <g transform="translate(-82 -82) scale(1.16)">${primaryBody}</g>
  ${
    preview
      ? '<g transform="translate(704 734)"><rect width="238" height="132" rx="66" fill="#fffdf9" stroke="#172a45" stroke-width="18"/><path d="M54 66h130" stroke="#b98c4a" stroke-width="14" stroke-linecap="round"/><circle cx="54" cy="66" r="22" fill="#d0a66c"/><circle cx="119" cy="66" r="22" fill="#3fb1ea"/><circle cx="184" cy="66" r="22" fill="#d0a66c"/></g>'
      : ''
  }
</svg>`
await writeAsset('platform/app-icon-macos-stable.svg', macosAppIcon({ preview: false }))
await writeAsset('platform/app-icon-macos-preview.svg', macosAppIcon({ preview: true }))

const macosMicroAppIcon = ({ preview, logicalSize }) => {
  const scale = logicalSize === 16 ? 1.42 : 1.3
  const translate = logicalSize === 16 ? -215 : -154
  const micro16Body = `<path d="M112 650A430 430 0 0 1 778 176" fill="none" stroke="#f0be68" stroke-width="58" stroke-linecap="round"/>
  <path d="M196 636C164 468 278 286 486 250C690 214 838 364 822 570C808 738 686 838 506 842C346 846 230 766 196 636Z" fill="#f5f1ed" stroke="#0b2348" stroke-width="38" stroke-linejoin="round"/>
  <path d="M250 508C302 324 484 268 680 312C554 350 458 430 416 548C370 676 302 706 218 696C258 646 272 578 250 508Z" fill="#dfe8f2"/>
  <circle cx="596" cy="560" r="150" fill="#fff0db" stroke="#0b2348" stroke-width="54"/>
  <circle cx="622" cy="560" r="64" fill="#3fb1ea" stroke="#0b2348" stroke-width="32"/>
  <circle cx="642" cy="536" r="20" fill="#fffdf9"/>
  <path d="M448 556h-80" stroke="#0b2348" stroke-width="48" stroke-linecap="round"/>
  <circle cx="764" cy="246" r="92" fill="#fffdf9" stroke="#f0be68" stroke-width="38"/>
  <circle cx="736" cy="246" r="20" fill="#3fb1ea"/><circle cx="782" cy="246" r="20" fill="#3fb1ea"/>`
  const badge =
    logicalSize === 16
      ? '<g transform="translate(596 718)"><rect width="400" height="216" rx="108" fill="#0b2348" stroke="#fffdf9" stroke-width="32"/><path d="M82 108h236" stroke="#fffdf9" stroke-width="24" stroke-linecap="round"/><circle cx="82" cy="108" r="46" fill="#d0a66c"/><circle cx="200" cy="108" r="46" fill="#3fb1ea"/><circle cx="318" cy="108" r="46" fill="#d0a66c"/></g>'
      : '<g transform="translate(650 742)"><rect width="338" height="184" rx="92" fill="#0b2348" stroke="#fffdf9" stroke-width="26"/><path d="M72 92h194" stroke="#fffdf9" stroke-width="20" stroke-linecap="round"/><circle cx="72" cy="92" r="36" fill="#d0a66c"/><circle cx="169" cy="92" r="36" fill="#3fb1ea"/><circle cx="266" cy="92" r="36" fill="#d0a66c"/></g>'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc" data-platform="macos" data-logical-size="${logicalSize}">
  <title id="title">NekroNXT${preview ? ' Preview' : ''} macOS ${logicalSize}px 微型应用图标</title>
  <desc id="desc">低色阶、放大轮廓的水月荧头像章${preview ? '，使用适配小尺寸的三节点 Preview 校准标记' : ''}。</desc>
  <rect width="1024" height="1024" fill="#021a3e"/>
  ${
    logicalSize === 16
      ? micro16Body
      : `<defs><clipPath id="micro-circle"><circle cx="512" cy="512" r="500"/></clipPath></defs><g transform="translate(${translate} ${translate}) scale(${scale})" clip-path="url(#micro-circle)">${vectorMicroBody}</g>`
  }
  ${preview ? badge : ''}
</svg>`
}
for (const channel of ['stable', 'preview']) {
  for (const logicalSize of [16, 32]) {
    await writeAsset(
      `platform/app-icon-macos-micro-${logicalSize}-${channel}.svg`,
      macosMicroAppIcon({ preview: channel === 'preview', logicalSize }),
    )
  }
}
await writeAsset(
  'platform/app-icon-maskable.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="NekroNXT maskable 图标"><rect width="1024" height="1024" fill="#172a45"/><g transform="translate(112 112) scale(.78125)">${primaryBody}</g></svg>`,
)
await writeAsset(
  'platform/favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="NekroNXT favicon"><defs><clipPath id="c"><circle cx="512" cy="512" r="480"/></clipPath></defs><g clip-path="url(#c)">${microBody}</g></svg>`,
)
await writeAsset(
  'platform/favicon-preview.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="NekroNXT Preview favicon"><defs><clipPath id="c"><circle cx="512" cy="512" r="480"/></clipPath></defs><g clip-path="url(#c)">${microBody}</g><g transform="translate(660 746)"><rect width="300" height="152" rx="76" fill="#fffdf9" stroke="#172a45" stroke-width="22"/><circle cx="70" cy="76" r="26" fill="#d0a66c"/><circle cx="150" cy="76" r="26" fill="#3fb1ea"/><circle cx="230" cy="76" r="26" fill="#d0a66c"/></g></svg>`,
)
await writeAsset(
  'platform/pinned-tab.svg',
  monochrome.replace('viewBox="0 0 1024 1024"', 'viewBox="0 0 1024 1024" color="#000"'),
)

const iconFrame = (
  title,
  body,
  tone = '#3fb1ea',
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${title}">
  <circle cx="32" cy="32" r="27" fill="#fffdf9" stroke="#172a45" stroke-width="2.5"/>
  <path d="M10 25A23 23 0 0 1 50 15" fill="none" stroke="#b98c4a" stroke-width="2" stroke-linecap="round"/>
  <circle cx="50" cy="15" r="3" fill="#d0a66c"/>
  <g fill="none" stroke="${tone}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${body}</g>
</svg>`

const processIcons = {
  download: ['下载', '<path d="M32 17v21m-8-8 8 8 8-8"/><path d="M20 45h24"/>'],
  verify: ['校验', '<path d="M32 16 44 21v10c0 8-5 13-12 17-7-4-12-9-12-17V21Z"/><path d="m26 31 4 4 8-9"/>'],
  unpack: ['解包', '<path d="m18 25 14-8 14 8-14 8Z"/><path d="M18 25v16l14 7 14-7V25M32 33v15"/>'],
  install: ['安装', '<path d="M19 25h26v20H19Z"/><path d="M32 16v18m-7-7 7 7 7-7"/>'],
  configure: [
    '配置',
    '<path d="M20 21h24M20 32h24M20 43h24"/><circle cx="28" cy="21" r="3"/><circle cx="38" cy="32" r="3"/><circle cx="25" cy="43" r="3"/>',
  ],
  launch: ['启动', '<path d="M25 19 45 32 25 45Z"/>'],
  connect: [
    '连接',
    '<circle cx="22" cy="24" r="5"/><circle cx="42" cy="24" r="5"/><circle cx="32" cy="43" r="5"/><path d="m26 27 4 11m8-11-4 11M27 24h10"/>',
  ],
  upgrade: ['升级', '<path d="M32 46V19m-9 9 9-9 9 9"/><path d="M20 46h24"/>'],
  backup: [
    '备份',
    '<ellipse cx="29" cy="22" rx="11" ry="5"/><path d="M18 22v16c0 3 5 5 11 5 3 0 5-.4 7-1"/><path d="M18 30c0 3 5 5 11 5"/><path d="M43 31v14m-5-5 5 5 5-5"/>',
  ],
  restore: [
    '恢复',
    '<ellipse cx="29" cy="22" rx="11" ry="5"/><path d="M18 22v16c0 3 5 5 11 5"/><path d="M18 30c0 3 5 5 11 5"/><path d="M48 39a9 9 0 1 1-3-7m3-4v8h-8"/>',
  ],
  repair: [
    '修复',
    '<path d="m23 42 13-13"/><path d="M39 17a8 8 0 0 0-9 10L18 39a4 4 0 0 0 6 6l12-12a8 8 0 0 0 10-9l-6 6-5-5Z"/>',
  ],
  uninstall: ['卸载', '<path d="M19 25h26v20H19Z"/><path d="M25 18h14M24 35h16"/>'],
}
for (const [name, [title, body]] of Object.entries(processIcons)) {
  await writeAsset(`process/${name}.svg`, iconFrame(title, body))
}

const stateIcons = {
  waiting: ['等待', '<circle cx="32" cy="32" r="12"/><path d="M32 25v8l5 3"/>', '#466394'],
  running: [
    '进行中',
    '<path d="M42 24a13 13 0 0 0-20-2M22 40a13 13 0 0 0 20 2"/><path d="m22 16v6h6m14 26v-6h-6"/>',
    '#3fb1ea',
  ],
  success: ['成功', '<circle cx="32" cy="32" r="13"/><path d="m25 32 5 5 10-11"/>', '#157347'],
  warning: ['警告', '<path d="m32 17 16 29H16Z"/><path d="M32 27v8m0 6h.01"/>', '#9a5b00'],
  failure: ['失败', '<circle cx="32" cy="32" r="13"/><path d="m27 27 10 10m0-10L27 37"/>', '#b4232d'],
  offline: ['离线', '<path d="M20 28a13 13 0 0 1 22-5M24 41h16M17 17l30 30"/>', '#68758a'],
}
for (const [name, [title, body, tone]] of Object.entries(stateIcons)) {
  await writeAsset(`status/${name}.svg`, iconFrame(title, body, tone))
}

const productIllustration = (
  title,
  body,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320" role="img" aria-label="${title}">
  <circle cx="240" cy="154" r="104" fill="#5575a9" fill-opacity=".10" stroke="#7390c0" stroke-width="2"/>
  <path d="M70 258Q180 210 280 262T430 238" fill="none" stroke="#b98c4a" stroke-opacity=".45" stroke-width="3"/>
  <path d="M46 278Q178 230 284 284T456 258" fill="none" stroke="#3fb1ea" stroke-opacity=".24" stroke-width="3"/>
  <g fill="none" stroke="#5575a9" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">${body}</g>
</svg>`
const productIllustrations = {
  'no-agents': [
    '还没有智能体',
    '<circle cx="240" cy="126" r="36"/><path d="M177 226c8-42 31-64 63-64s55 22 63 64"/><path d="m316 92 8 14 14 8-14 8-8 14-8-14-14-8 14-8Z" stroke="#3fb1ea"/>',
  ],
  'no-connections': [
    '还没有连接或频道',
    '<circle cx="190" cy="138" r="24"/><circle cx="290" cy="138" r="24"/><path d="M214 138h20m12 0h20"/><path d="m232 122 16 32m0-32-16 32" stroke="#b4232d"/>',
  ],
  'no-extensions': [
    '还没有本地扩展',
    '<path d="M184 106h42c-7 8-2 25 12 25s19-17 12-25h46v42c-8-7-25-2-25 12s17 19 25 12v46h-46c7-8 2-25-12-25s-19 17-12 25h-42v-46c8 7 25 2 25-12s-17-19-25-12Z"/>',
  ],
  'host-unreachable': [
    '无法连接 Host',
    '<rect x="188" y="96" width="104" height="126" rx="12"/><path d="M210 126h60m-60 32h60m-60 32h26"/><path d="m174 82 132 154" stroke="#b4232d"/>',
  ],
}
for (const [name, [title, body]] of Object.entries(productIllustrations)) {
  await writeAsset(`product/${name}.svg`, productIllustration(title, body))
}

const card = ({
  title,
  eyebrow,
  preview = false,
  width = 1200,
  height = 630,
}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0a121f"/><stop offset=".62" stop-color="#172a45"/><stop offset="1" stop-color="#253857"/></linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <path d="M0 ${height * 0.78} Q ${width * 0.25} ${height * 0.48} ${width * 0.5} ${height * 0.8} T ${width} ${height * 0.72}" fill="none" stroke="#3fb1ea" stroke-opacity=".22" stroke-width="3"/>
  <path d="M0 ${height * 0.9} Q ${width * 0.3} ${height * 0.62} ${width * 0.56} ${height * 0.92} T ${width} ${height * 0.84}" fill="none" stroke="#d0a66c" stroke-opacity=".38" stroke-width="2"/>
  <g transform="translate(${width * 0.66} ${height * 0.12}) scale(${height / 1370})">${primaryBody}</g>
  <text x="80" y="120" fill="#d0a66c" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="28" font-weight="700" letter-spacing="5">${eyebrow}</text>
  <text x="76" y="230" fill="#fffdf9" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="76" font-weight="750">${title}</text>
  <text x="80" y="298" fill="#bdcfec" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="30">以 DSH 为核心引擎的高扩展智能体聊天系统</text>
  ${preview ? '<g transform="translate(80 360)"><rect width="250" height="72" rx="36" fill="#fffdf9"/><circle cx="55" cy="36" r="13" fill="#d0a66c"/><circle cx="125" cy="36" r="13" fill="#3fb1ea"/><circle cx="195" cy="36" r="13" fill="#d0a66c"/></g>' : ''}
</svg>`
await writeAsset('distribution/social-card.svg', card({ title: 'NekroNXT', eyebrow: 'NEKROAI · NXT' }))
await writeAsset(
  'distribution/github-social-preview.svg',
  card({ title: 'NekroNXT', eyebrow: 'NEKROAI · OPEN SOURCE', width: 1280, height: 640 }),
)
await writeAsset(
  'distribution/release-card-stable.svg',
  card({ title: 'NekroNXT Stable', eyebrow: 'OFFICIAL RELEASE' }),
)
await writeAsset(
  'distribution/release-card-preview.svg',
  card({ title: 'NekroNXT Preview', eyebrow: 'ROLLING PREVIEW', preview: true }),
)

const installerBackground = ({ channel, kind, width, height }) => {
  const preview = channel === 'preview'
  const title = preview ? 'NekroNXT Preview' : 'NekroNXT'
  const isDmg = width === 660 && height === 420
  const paths = isDmg
    ? '<path d="M0 318 Q218 250 430 316 Q548 340 660 296" fill="none" stroke="#466394" stroke-opacity=".16" stroke-width="2" data-essential-bottom="341"/><path d="M0 352 Q200 294 420 346 Q552 354 660 334" fill="none" stroke="#b98c4a" stroke-opacity=".45" stroke-width="2" data-essential-bottom="355"/>'
    : `<path d="M0 ${height * 0.82} Q ${width * 0.33} ${height * 0.52} ${width * 0.66} ${height * 0.82} T ${width} ${height * 0.7}" fill="none" stroke="#466394" stroke-opacity=".16" stroke-width="2"/>
  <path d="M0 ${height * 0.92} Q ${width * 0.28} ${height * 0.68} ${width * 0.6} ${height * 0.9} T ${width} ${height * 0.84}" fill="none" stroke="#b98c4a" stroke-opacity=".45" stroke-width="2"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title} ${kind}"${isDmg ? ' data-initial-visible-safe-height="356"' : ''}>
  <rect width="${width}" height="${height}" fill="#fffdf9"/>
  ${paths}
  ${width <= 300 ? `<g transform="translate(${width * 0.06} ${height * 0.08}) scale(${Math.min(width, height) / 1580})">${primaryBody}</g>` : ''}
  ${isDmg ? `<g data-essential-bottom="116"><text x="36" y="56" fill="#172a45" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="26" font-weight="700">${title}</text><text x="330" y="116" text-anchor="middle" fill="#466394" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="14">拖动 NekroNXT 到 Applications 完成安装</text></g>` : ''}
  ${preview ? `<g transform="translate(${width * 0.68} ${height * 0.08})"${isDmg ? ' data-essential-bottom="39"' : ''}><circle cx="0" cy="0" r="5" fill="#d0a66c"/><circle cx="18" cy="0" r="5" fill="#3fb1ea"/><circle cx="36" cy="0" r="5" fill="#d0a66c"/></g>` : ''}
</svg>`
}
for (const channel of ['stable', 'preview']) {
  await writeAsset(
    `platform/dmg-background-${channel}.svg`,
    installerBackground({ channel, kind: 'DMG 背景', width: 660, height: 420 }),
  )
  await writeAsset(
    `platform/installer-sidebar-${channel}.svg`,
    installerBackground({ channel, kind: '安装侧栏', width: 164, height: 314 }),
  )
  await writeAsset(
    `platform/uninstaller-sidebar-${channel}.svg`,
    installerBackground({ channel, kind: '卸载侧栏', width: 164, height: 314 }),
  )
  await writeAsset(
    `platform/installer-header-${channel}.svg`,
    installerBackground({ channel, kind: '安装页眉', width: 150, height: 57 }),
  )
}

await writeFile(sourceLogo, normalizedLogoBuffer)

console.log(`品牌矢量与模板已生成到 ${path.relative(repositoryRoot, generatedRoot)}`)
