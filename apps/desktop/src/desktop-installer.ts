import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { chmod, copyFile, rename } from 'node:fs/promises'
import type { DesktopPlatform } from './desktop-update.js'

/**
 * Opens a downloaded installer after the app's Host has stopped (#87). Windows runs the setup program; macOS mounts
 * the disk image and shows it in Finder for the drag into Applications; a Linux AppImage replaces the running file
 * and the app starts again from it.
 */
export const openInstaller = async (
  file: string,
  platform: DesktopPlatform,
  relaunch: (execPath: string) => void,
): Promise<void> => {
  if (platform === 'win') {
    spawn(file, [], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (platform === 'mac') {
    const failure = await shell.openPath(file)
    if (failure !== '') throw new Error(failure)
    return
  }
  const current = process.env['APPIMAGE']
  if (current === undefined || current === '') {
    shell.showItemInFolder(file)
    return
  }
  const staged = `${current}.update`
  await copyFile(file, staged)
  await chmod(staged, 0o755)
  await rename(staged, current)
  relaunch(current)
}
