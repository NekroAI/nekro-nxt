import { mergeServerImage } from './lib/server-image.mjs'

// Usage: node scripts/merge-server-image.mjs <image>; merges <image>-amd64 and <image>-arm64 into <image>.
const image = process.argv[2]
if (process.argv.length !== 3 || !/^[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]+)+:[A-Za-z0-9._-]+$/u.test(image ?? '')) {
  console.error('用法：node scripts/merge-server-image.mjs <镜像:标签>')
  process.exit(1)
}
console.log(`${image}@${mergeServerImage(image)}`)
