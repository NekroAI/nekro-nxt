declare module 'qrcode-terminal/vendor/QRCode' {
  export default class QRCode {
    constructor(typeNumber: number, errorCorrectLevel: number)

    addData(data: string): void
    isDark(row: number, col: number): boolean
    getModuleCount(): number
    make(): void
  }
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel' {
  const QRErrorCorrectLevel: {
    readonly L: number
    readonly M: number
    readonly Q: number
    readonly H: number
  }

  export default QRErrorCorrectLevel
}
