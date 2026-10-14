import { describe, expect, it } from 'vitest'
import { CommandDefinitionSchema } from '@nekro-nxt/contracts'
import { commandVerificationArguments } from '../src/commands/verification.js'

describe('command import verification arguments', () => {
  it.each([
    [{ type: 'string', min: 2, max: 3 }, '例例'],
    [{ type: 'string', max: 0 }, ''],
    [{ type: 'string', min: 1.5, max: 2.5 }, '例例'],
    [{ type: 'number', max: -2 }, -2],
    [{ type: 'number', min: 0.1, max: 0.5 }, 0.5],
    [{ type: 'integer', min: 2.3, max: 3.9 }, 3],
    [{ type: 'integer', max: -1.5 }, -2],
    [{ type: 'string', min: 2, max: 3, choices: ['过长的示例', '小明'] }, '小明'],
    [{ type: 'boolean', choices: [false] }, false],
  ])('supplies a legal value for %j', (constraints, expected) => {
    const definition = CommandDefinitionSchema.parse({
      name: 'sample',
      description: '验证',
      parameters: [{ name: 'value', kind: 'positional', required: true, ...constraints }],
    })
    expect(commandVerificationArguments(definition)).toEqual({ value: expected })
  })
  it('preserves option-like choices and defaults across mixed parameter kinds', () => {
    const definition = CommandDefinitionSchema.parse({
      name: 'sample',
      description: '验证',
      parameters: [
        { name: 'text', kind: 'positional', type: 'string', required: true, choices: ['--literal text'] },
        { name: 'flag', kind: 'option', type: 'boolean', required: true, choices: [false] },
        { name: 'option', kind: 'option', type: 'string', required: true, choices: ['--'] },
        { name: 'count', kind: 'option', type: 'integer', required: true, default: 2 },
      ],
    })
    expect(commandVerificationArguments(definition)).toEqual({
      text: '--literal text',
      flag: false,
      option: '--',
      count: 2,
    })
  })
  it('reports an unsatisfiable integer range instead of invoking a handler with invalid input', () => {
    const definition = CommandDefinitionSchema.parse({
      name: 'sample',
      description: '验证',
      parameters: [{ name: 'value', kind: 'positional', type: 'integer', required: true, min: 0.1, max: 0.9 }],
    })
    expect(() => commandVerificationArguments(definition)).toThrow('没有符合约束的验证值')
  })
})
