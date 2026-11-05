import type {
  AgentId,
  ChannelId,
  CommandDefinition,
  CommandExecutionRecord,
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
  /** `/ext` and `/admin`; absent on hosts without extension governance. */
  readonly governance?: CommandGovernanceCall
  /** `/threshold`; absent on hosts that run no conversations. */
  readonly compactionThreshold?: CompactionThresholdCall
}

/** The compaction threshold of the channel's agent and its current conversation, as `/threshold` reads it. */
export interface CompactionThresholdState {
  /** The window of the agent's main model; undefined when the adapter does not say. */
  readonly contextWindow?: number
  /** The agent's own setting; undefined uses the default. */
  readonly setting?: number
  /** The current conversation's override, if it has one. */
  readonly override?: number
  /** Whether the channel has a conversation to override. */
  readonly hasConversation: boolean
}

export interface CompactionThresholdCall {
  read(): Promise<CompactionThresholdState>
  /** Overrides the current conversation's threshold until it next compacts; undefined returns to the setting. */
  set(ratio: number | undefined): void
}

/** Host side of `/threshold`. */
export interface CompactionThresholdPort {
  contextWindowOf(model: { readonly provider: string; readonly model: string }): Promise<number | undefined>
  compactionThresholdOverride(dshSessionId: string): number | undefined
  setCompactionThresholdOverride(dshSessionId: string, ratio: number | undefined): void
}

/** What `/ext` and `/admin` need from the host, bound to one execution's channel and caller. */
export interface CommandGovernanceCall {
  /** Whether the caller is an instance administrator (the console, or a listed platform account). */
  readonly administrator: boolean
  ext(input: { readonly subcommand?: string; readonly target?: string; readonly value?: string }): Promise<string>
  admin(input: { readonly action?: string; readonly value?: string }): Promise<string>
}

/** Host side of `/ext` and `/admin`, given the channel, its agent and who runs the command. */
export interface CommandGovernancePort {
  ext(
    input: { readonly subcommand?: string; readonly target?: string; readonly value?: string },
    context: CommandGovernanceContext,
  ): Promise<string>
  admin(
    input: { readonly action?: string; readonly value?: string },
    context: CommandGovernanceContext,
  ): Promise<string>
}

export interface CommandGovernanceContext {
  readonly channelId: ChannelId
  readonly agentId?: AgentId
  readonly identity: CommandExecutionRecord['identity']
  readonly administrator: boolean
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

/** Diagnostics only: observers must not change execution or delivery outcomes, and never see arguments. */
export interface CommandObserver {
  settled?(record: CommandExecutionRecord): void
  replyNotDelivered?(record: CommandExecutionRecord, ordinal: number): void
  rateLimited?(report: { readonly channelId: ChannelId; readonly dropped: number; readonly reason: string }): void
}

/** The caller lacks the grant. Platform members are told so unless the administrator turned that feedback off. */
export class UnauthorizedCommandError extends Error {}

export const textResult = (text: string): CommandResult => ({ parts: [{ type: 'text', text }] })
