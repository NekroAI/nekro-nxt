import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { archFromString } from 'electron-builder'
import desktopDistributions from './distributions.json' with { type: 'json' }
import { desktopArchitectures } from '../../scripts/product-release.mjs'

const channel = process.env['NEKRO_DESKTOP_CHANNEL']
if (channel !== 'preview' && channel !== 'stable') {
  throw new Error(`NEKRO_DESKTOP_CHANNEL 无效：${channel ?? 'undefined'}`)
}
const distribution = desktopDistributions[channel]

export const signMacApplication = ({ app }) => {
  const result = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`macOS ad-hoc 签署失败：${app}`)
}

const packagedExecutable = (context) => {
  if (context.electronPlatformName === 'win32') {
    return path.join(context.appOutDir, `${distribution.executableName}.exe`)
  }
  if (context.electronPlatformName === 'linux') {
    return path.join(context.appOutDir, distribution.linuxExecutableName)
  }
  return path.join(context.appOutDir, `${distribution.productName}.app`, 'Contents', 'MacOS', distribution.productName)
}

const packagedResources = (context) =>
  context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${distribution.productName}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')

export const verifyPackagedServerRuntime = async (context) => {
  const hostPlatform = process.platform
  const targetPlatform = context.electronPlatformName
  const hostArch = archFromString(process.arch)
  if (targetPlatform !== hostPlatform) return
  const executable = context.arch === hostArch ? packagedExecutable(context) : process.execPath
  const result = spawnSync(
    process.execPath,
    [
      'scripts/verify-packaged-server-runtime.mjs',
      '--executable',
      executable,
      '--resources',
      packagedResources(context),
      '--release-id',
      `desktop-${channel}-${targetPlatform}-${process.arch}-smoke`,
    ],
    { cwd: new URL('.', import.meta.url), stdio: 'inherit', env: process.env },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Desktop 最终运行时验证失败（code ${result.status ?? 'unknown'}）。`)
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: distribution.appId,
  productName: distribution.productName,
  artifactName: `${distribution.artifactSlug}-\${os}-\${arch}-v\${version}.\${ext}`,
  extraMetadata: { name: distribution.artifactSlug },
  directories: {
    app: 'dist',
    buildResources: `resources/${channel}`,
    output: `release/${channel}`,
  },
  files: [
    'main.mjs',
    'main.mjs.map',
    'product-preload.cjs',
    'product-preload.cjs.map',
    'overlay-preload.cjs',
    'overlay-preload.cjs.map',
    'instance-overlay.html',
    'instance-overlay.css',
    'instance-overlay.js',
    'product-release.json',
    'package.json',
  ],
  extraResources: [
    { from: '../../LICENSE', to: 'LICENSE' },
    { from: '../../NOTICE', to: 'NOTICE' },
    { from: '../web/dist', to: 'web-dist' },
    { from: 'dist/runtime', to: 'server-runtime', filter: ['**/*', '!node_modules{,/**/*}'] },
    { from: 'dist/runtime/node_modules', to: 'server-runtime/node_modules', filter: ['**/*'] },
  ],
  afterPack: verifyPackagedServerRuntime,
  asar: true,
  npmRebuild: false,
  mac: {
    category: 'public.app-category.productivity',
    icon: 'icon.icns',
    // 没有 Developer ID 证书时仍需完整 ad-hoc 签署应用包。直接跳过签名会保留
    // Electron 主可执行文件的 linker signature，Gatekeeper 会把下载后的应用判为损坏。
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
    // @electron/osx-sign 会并发遍历完整 server-runtime，在 GitHub macOS runner 上
    // 可能超过文件句柄上限；原生 codesign --deep 使用同一 ad-hoc 身份且不会触发该问题。
    sign: signMacApplication,
    // server-runtime 同时携带 darwin-arm64/darwin-x64 N-API prebuild，并在
    // 运行时按 process.arch 选择；mac 产物按架构独立打包，不做 Universal 合并。
    target: [{ target: 'dmg', arch: desktopArchitectures('mac') }],
  },
  win: {
    executableName: distribution.executableName,
    icon: 'icon.ico',
    artifactName: `${distribution.artifactSlug}-win-x64-v\${version}-setup.\${ext}`,
    // 未签名阶段跳过依赖 Wine 的 rcedit/sign；NSIS GUID 与安装身份仍完整保留。
    signAndEditExecutable: false,
    target: [{ target: 'nsis', arch: desktopArchitectures('win') }],
  },
  nsis: {
    guid: distribution.nsisGuid,
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: distribution.productName,
    deleteAppDataOnUninstall: false,
    installerIcon: 'installerIcon.ico',
    uninstallerIcon: 'uninstallerIcon.ico',
    installerSidebar: 'installerSidebar.bmp',
    uninstallerSidebar: 'uninstallerSidebar.bmp',
    installerHeader: 'installerHeader.bmp',
  },
  dmg: {
    background: 'dmg-background.png',
    iconSize: 108,
    window: { width: 660, height: 420 },
    contents: [
      { x: 190, y: 220, type: 'file' },
      { x: 470, y: 220, type: 'link', path: '/Applications' },
    ],
  },
  linux: {
    category: 'Utility',
    executableName: distribution.linuxExecutableName,
    icon: 'icons',
    artifactName: `${distribution.artifactSlug}-linux-x64-v\${version}.\${ext}`,
    target: [{ target: 'AppImage', arch: desktopArchitectures('linux') }],
  },
  publish: null,
}

export default config
