import { AdapterDeliveryReceiptSchema, redactAdapterDiagnosticText } from '@nekro-nxt/adapter-sdk'
import { MessageDeliverySummarySchema } from '@nekro-nxt/contracts'
import { z } from 'zod'

const receiptRecord = z.object({ receipt: AdapterDeliveryReceiptSchema })

/** What the agent's outbound processors did, as carried in the send tool's result. */
export interface ChannelMessageProcessing {
  readonly processedBy: readonly string[]
  readonly rewritten: boolean
  readonly parts?: readonly unknown[] | undefined
  readonly followUps: readonly {
    readonly extension: string
    readonly logicalMessageId?: string | undefined
    readonly status: string
    readonly message?: string | undefined
  }[]
}

const quoted = (names: readonly string[]) => names.map((name) => `「${name}」`).join('、')

const followUpLines = (processing: ChannelMessageProcessing): string[] =>
  processing.followUps.map((followUp) =>
    followUp.logicalMessageId === undefined
      ? `「${followUp.extension}」追加的一条没有发出${followUp.message === undefined ? '' : `：${followUp.message}`}`
      : `「${followUp.extension}」追加了一条，消息 ${followUp.logicalMessageId}：${followUp.status}`,
  )

/** Preserve diagnostic results in the rendered content used by both native and PTC tool histories. */
export function renderChannelMessageResult(value: {
  readonly logicalMessageId?: string | undefined
  readonly status: string
  readonly receipts: readonly unknown[]
  readonly processing?: ChannelMessageProcessing | undefined
  readonly cancel?: { readonly extension: string; readonly reason: string } | undefined
}): string {
  if (value.status === 'cancelled') {
    const cancel = value.cancel ?? { extension: '扩展', reason: '没有说明原因' }
    return `这条消息没有发出：「${cancel.extension}」取消了它，原因：${cancel.reason}。可以按原因改一下再发。`
  }
  const processing = value.processing
  if (value.status === 'sent') {
    if (processing === undefined) return `消息 ${value.logicalMessageId}：sent`
    return [
      processing.processedBy.length === 0
        ? `消息 ${value.logicalMessageId}：sent`
        : `消息 ${value.logicalMessageId}：sent，内容经${quoted(processing.processedBy)}处理。`,
      ...(processing.parts === undefined ? [] : [`实际发出的内容：${JSON.stringify(processing.parts)}`]),
      ...followUpLines(processing),
    ].join('\n')
  }
  const issues = value.receipts.flatMap((record) => {
    const parsed = receiptRecord.safeParse(record)
    if (!parsed.success || parsed.data.receipt.status === 'sent') return []
    const receipt = parsed.data.receipt
    return [
      {
        status: receipt.status,
        message: redactAdapterDiagnosticText(receipt.status === 'failed' ? receipt.failure.message : receipt.message),
        ...(receipt.status === 'failed' ? { kind: receipt.failure.kind } : {}),
        ...(receipt.diagnostic?.action === undefined
          ? {}
          : { action: redactAdapterDiagnosticText(receipt.diagnostic.action).slice(0, 120) }),
        ...(receipt.diagnostic?.retcode === undefined ? {} : { retcode: receipt.diagnostic.retcode }),
      },
    ]
  })
  return JSON.stringify(
    MessageDeliverySummarySchema.parse({
      status: value.status,
      issues: issues.slice(0, 20),
      ...(issues.length > 20 ? { omittedIssues: issues.length - 20 } : {}),
      ...(processing === undefined || (processing.processedBy.length === 0 && processing.followUps.length === 0)
        ? {}
        : {
            processing: {
              processedBy: [...processing.processedBy],
              ...(processing.parts === undefined ? {} : { parts: [...processing.parts] }),
              ...(processing.followUps.length === 0 ? {} : { followUps: followUpLines(processing) }),
            },
          }),
    }),
  )
}
