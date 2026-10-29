import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
await mkdir(path.join(root, 'dist', 'tray'), { recursive: true })
await Promise.all(
  ['stable', 'preview'].map((channel) =>
    copyFile(path.join(root, 'resources', channel, 'icon.ico'), path.join(root, 'dist', 'tray', `${channel}.ico`)),
  ),
)
await Promise.all(
  [
    'instance-overlay.html',
    'instance-overlay.css',
    'instance-overlay.js',
    'startup.html',
    'startup.css',
    'startup.js',
    'data-move-view.html',
    'data-move-view.js',
  ].map((name) => copyFile(path.join(root, 'src', name), path.join(root, 'dist', name))),
)
