/** Keep protocol errors useful without exposing credentials, download URLs or local paths. */
export function redactAdapterDiagnosticText(message: string, secrets: readonly string[] = []): string {
  let text = message
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[已隐藏]')
  }
  return text
    .replace(/\bBearer\s+[^\s,;"']+/giu, 'Bearer [已隐藏]')
    .replace(
      /((?:access[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|token|secret|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu,
      '$1[已隐藏]',
    )
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/giu, '[地址已隐藏]')
    .replace(/(?:[a-z]:\\|\/(?:Users|home|data|tmp|var|opt)\/)[^\s"'<>]+/giu, '[路径已隐藏]')
    .slice(0, 1000)
}
