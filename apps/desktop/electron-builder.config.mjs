import desktopDistributions from './distributions.json' with { type: 'json' }

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
    output: `release/${channel}`,
  },
  files: ['main.mjs', 'main.mjs.map', 'product-release.json', 'package.json'],
  extraResources: [
    { from: '../web/dist', to: 'web-dist' },
    { from: 'dist/runtime', to: 'server-runtime', filter: ['**/*', '!node_modules{,/**/*}'] },
    { from: 'dist/runtime/node_modules', to: 'server-runtime/node_modules', filter: ['**/*'] },
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    category: 'public.app-category.productivity',
    identity: null,
    notarize: false,
    // server-runtime 同时携带 darwin-x64/arm64 N-API prebuild，并在运行时按
    // process.arch 选择；它们不应由 Universal 合并器再次执行 lipo。
    x64ArchFiles: 'Contents/Resources/server-runtime/node_modules/.pnpm/**',
    artifactName: `${distribution.artifactSlug}-mac-universal-v\${version}.\${ext}`,
    target: [{ target: 'dmg', arch: ['universal'] }],
  },
  win: {
    executableName: distribution.executableName,
    artifactName: `${distribution.artifactSlug}-win-x64-v\${version}-setup.\${ext}`,
    // 未签名阶段跳过依赖 Wine 的 rcedit/sign；NSIS GUID 与安装身份仍完整保留。
    signAndEditExecutable: false,
    target: [{ target: 'nsis', arch: ['x64'] }],
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
  },
  linux: {
    category: 'Utility',
    executableName: distribution.linuxExecutableName,
    artifactName: `${distribution.artifactSlug}-linux-x64-v\${version}.\${ext}`,
    target: [{ target: 'AppImage', arch: ['x64'] }],
  },
  publish: null,
}

export default config
