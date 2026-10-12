import { AdapterDeliveryReceiptSchema, redactAdapterDiagnosticText } from '@nekro-nxt/adapter-sdk'
import { MessageDeliverySummarySchema } from '@nekro-nxt/contracts'
import { z } from 'zod'

const receiptRecord = z.object({ receipt: AdapterDeliveryReceiptSchema })

/** Preserve diagnostic results in the rendered content used by both native and PTC tool histories. */
export function renderChannelMessageResult(value: {
  readonly logicalMessageId: string
  readonly status: string
  readonly receipts: readonly unknown[]
}): string {
  if (value.status === 'sent') return `消息 ${value.logicalMessageId}：sent`
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
    }),
  )
}
