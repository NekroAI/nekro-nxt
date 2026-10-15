import type {
  CommandDefinition,
  CommandExecutionContext,
  CommandResult,
  ExtensionRevisionId,
} from '@nekro-nxt/contracts'

/** Host-only operations the built-in commands need beyond the public execution context. */
export interface CommandRunCapabilities {
  /** Usage and examples of one command, or the list of everything the caller may run. */
  help(target: string | undefined): CommandResult
  statusText(): string
  /** Pauses the channel; also stops the current turn. */
  pause(): Promise<{ readonly changed: boolean; readonly stopped: boolean }>
  resume(): Promise<{ readonly changed: boolean }>
}

export interface RegisteredCommand {
  readonly definition: CommandDefinition
  readonly fullName: string
  readonly source: string
  readonly extensionRevisionId?: ExtensionRevisionId
  readonly unavailableReason?: string
  /** Extension handlers ignore the second argument; built-ins use it for host-only operations. */
  readonly invoke: (
    context: CommandExecutionContext,
    host: CommandRunCapabilities,
  ) => CommandResult | Promise<CommandResult>
}

/** A refusal the platform must not hear about (unknown or unauthorized): recorded, never answered. */
export class SilentCommandError extends Error {}

export const textResult = (text: string): CommandResult => ({ parts: [{ type: 'text', text }] })
