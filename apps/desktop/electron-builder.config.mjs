import desktopDistributions from './distributions.json' with { type: 'json' }
import { desktopArchitectures } from '../../scripts/product-release.mjs'

const channel = process.env['NEKRO_DESKTOP_CHANNEL']
if (channel !== 'preview' && channel !== 'stable') {
  throw new Error(`NEKRO_DESKTOP_CHANNEL 无效：${channel ?? 'undefined'}`)
}
const distribution = desktopDistributions[channel]

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
    { from: '../web/dist', to: 'web-dist' },
    { from: 'dist/runtime', to: 'server-runtime', filter: ['**/*', '!node_modules{,/**/*}'] },
    { from: 'dist/runtime/node_modules', to: 'server-runtime/node_modules', filter: ['**/*'] },
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    category: 'public.app-category.productivity',
    icon: 'icon.icns',
    identity: null,
    notarize: false,
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
