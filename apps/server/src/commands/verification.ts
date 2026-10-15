import { parseCommandArguments, type CommandDefinition } from '@nekro-nxt/contracts'

/** Build a parser-checked sample without treating literal choices as command syntax. */
export function commandVerificationArguments(definition: CommandDefinition) {
  const options: string[] = []
  const positions: string[] = []
  for (const parameter of definition.parameters) {
    if (!parameter.required || parameter.default !== undefined) continue
    const tokensFor = (value: string) =>
      parameter.kind === 'option' ? [`--${parameter.name}=${value}`] : ['--', value]
    const candidates = parameter.choices ?? [
      parameter.type === 'string'
        ? '例'.repeat(Math.max(0, Math.ceil(parameter.min ?? Math.min(2, Math.floor(parameter.max ?? 2)))))
        : parameter.type === 'boolean'
          ? true
          : parameter.type === 'integer'
            ? Math.max(
                Math.ceil(parameter.min ?? Number.MIN_SAFE_INTEGER),
                Math.min(1, Math.floor(parameter.max ?? Number.MAX_SAFE_INTEGER)),
              )
            : Math.max(parameter.min ?? -Number.MAX_VALUE, Math.min(1, parameter.max ?? Number.MAX_VALUE)),
    ]
    const sample = candidates.map(String).find((value) => {
      try {
        parseCommandArguments({ ...definition, parameters: [parameter] }, tokensFor(value))
        return true
      } catch {
        return false
      }
    })
    if (sample === undefined)
      throw new Error(`命令 /${definition.name} 的参数 ${parameter.name} 没有符合约束的验证值。`)
    if (parameter.kind === 'option') options.push(...tokensFor(sample))
    else positions.push(sample)
  }
  return parseCommandArguments(definition, [...options, '--', ...positions])
}
