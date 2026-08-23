import { copyFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
await Promise.all(
  ['instance-overlay.html', 'instance-overlay.css', 'instance-overlay.js'].map((name) =>
    copyFile(path.join(root, 'src', name), path.join(root, 'dist', name)),
  ),
)
