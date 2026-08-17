export type DialogCloseReason = 'cancel' | 'close-button' | 'escape' | 'outside'

const userCloseReasons: ReadonlySet<DialogCloseReason> = new Set(['cancel', 'close-button', 'escape', 'outside'])

/** Pending confirmation owns the modal until it settles. */
export function canCloseDialog(pending: boolean, reason: DialogCloseReason): boolean {
  return !pending || !userCloseReasons.has(reason)
}
