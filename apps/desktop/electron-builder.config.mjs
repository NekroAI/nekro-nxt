const appId = 'io.github.nekroai.nekronxt'

/** @type {import('electron-builder').Configuration} */
const config = {
  appId,
  productName: 'NekroNxt',
  artifactName: `nekro-nxt-\${os}-\${arch}-v\${version}.\${ext}`,
  directories: {
    app: 'dist',
    output: 'release',
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
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
  },
  win: {
    executableName: 'NekroNxt',
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    guid: '2BED256D-E4EA-4EA9-B730-6B63FF416CE8',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'NekroNxt',
    deleteAppDataOnUninstall: false,
  },
  linux: {
    category: 'Utility',
    executableName: 'nekro-nxt',
    target: ['AppImage'],
  },
  publish: null,
}

export default config
