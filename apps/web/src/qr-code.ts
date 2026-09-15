import QRCode from 'qrcode-terminal/vendor/QRCode'
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel'

const QR_CODE_QUIET_ZONE = 4

const createQrCodeSvg = (payload: string): string => {
  const qrCode = new QRCode(-1, QRErrorCorrectLevel.M)
  qrCode.addData(payload)
  qrCode.make()

  const moduleCount = qrCode.getModuleCount()
  const viewBoxSize = moduleCount + QR_CODE_QUIET_ZONE * 2
  const darkModules: string[] = []

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qrCode.isDark(row, col)) {
        darkModules.push('M' + String(col + QR_CODE_QUIET_ZONE) + ' ' + String(row + QR_CODE_QUIET_ZONE) + 'h1v1h-1z')
      }
    }
  }

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    String(viewBoxSize) +
    ' ' +
    String(viewBoxSize) +
    '" shape-rendering="crispEdges">' +
    '<rect width="100%" height="100%" fill="#fff"/>' +
    '<path fill="#172a45" d="' +
    darkModules.join('') +
    '"/>' +
    '</svg>'
  )
}

export const createQrCodeSvgDataUrl = (payload: string): string => {
  const trimmedPayload = payload.trim()
  if (!trimmedPayload) return ''
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(createQrCodeSvg(trimmedPayload))
}
