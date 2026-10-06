import type { IncomingMessage } from 'node:http'

/**
 * Identifies who is looking at the workspace for per-viewer read models. The management edge strips any
 * client-supplied value and sets `device:<deviceId>` for paired remote devices; loopback requests without
 * it belong to the local console, which already has full trust.
 */
export const VIEWER_HEADER = 'x-nxt-viewer'
export const LOCAL_VIEWER = 'local'
const DEVICE_VIEWER_PATTERN = /^device:nxt_device_[0-9A-Za-z]{1,64}$/u

export const viewerKeyFromRequest = (req: IncomingMessage): string => {
  const header = req.headers[VIEWER_HEADER]
  return typeof header === 'string' && DEVICE_VIEWER_PATTERN.test(header) ? header : LOCAL_VIEWER
}
