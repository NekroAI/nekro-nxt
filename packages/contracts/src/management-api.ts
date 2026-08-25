import { z } from 'zod'

const NonEmptyStringSchema = z.string().trim().min(1)
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u)

export const ServerInstanceIdSchema = z
  .string()
  .regex(/^nxt_instance_[0-9A-HJKMNP-TV-Z]{26}$/u)
  .brand<'ServerInstanceId'>()
export type ServerInstanceId = z.output<typeof ServerInstanceIdSchema>

export const ManagementDeviceIdSchema = z
  .string()
  .regex(/^nxt_device_[0-9A-HJKMNP-TV-Z]{26}$/u)
  .brand<'ManagementDeviceId'>()
export type ManagementDeviceId = z.output<typeof ManagementDeviceIdSchema>

export const InstanceDescriptorWireSchema = z
  .object({
    format: z.literal('nxt.instance-descriptor'),
    descriptorVersion: z.number().int().positive(),
    instanceId: ServerInstanceIdSchema,
    releaseId: NonEmptyStringSchema.max(256),
    productVersion: NonEmptyStringSchema.max(64),
    managementProtocol: z.number().int().positive(),
    desktopChromeProtocol: z.number().int().positive(),
    transport: NonEmptyStringSchema.max(80),
  })
  .passthrough()
export type InstanceDescriptorWire = z.output<typeof InstanceDescriptorWireSchema>

export const InstanceDescriptorSchema = z
  .object({
    format: z.literal('nxt.instance-descriptor'),
    descriptorVersion: z.literal(1),
    instanceId: ServerInstanceIdSchema,
    releaseId: NonEmptyStringSchema.max(256),
    productVersion: NonEmptyStringSchema.max(64),
    managementProtocol: z.union([z.literal(1), z.literal(2)]),
    desktopChromeProtocol: z.literal(1),
    transport: z.enum(['loopback-http', 'auto-tls-pinned-v1', 'explicit-http-v1']),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      (value.managementProtocol === 1 &&
        (value.transport === 'loopback-http' || value.transport === 'auto-tls-pinned-v1')) ||
      (value.managementProtocol === 2 && value.transport === 'explicit-http-v1')
    if (!valid) context.addIssue({ code: 'custom', message: 'management protocol 与 transport 不匹配。' })
  })
export type InstanceDescriptor = z.output<typeof InstanceDescriptorSchema>

export const ManagementChallengeResponseSchema = z
  .object({
    challengeId: Base64UrlSchema,
    serverNonce: Base64UrlSchema,
    instanceId: ServerInstanceIdSchema,
    spkiSha256: Base64UrlSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict()
export type ManagementChallengeResponse = z.output<typeof ManagementChallengeResponseSchema>

export const InsecureHttpManagementChallengeResponseSchema = z
  .object({
    challengeId: Base64UrlSchema,
    serverNonce: Base64UrlSchema,
    instanceId: ServerInstanceIdSchema,
    transportBinding: Base64UrlSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict()
export type InsecureHttpManagementChallengeResponse = z.output<typeof InsecureHttpManagementChallengeResponseSchema>

export const ManagementDeviceEnrollmentRequestSchema = z
  .object({
    challengeId: Base64UrlSchema,
    clientNonce: Base64UrlSchema,
    proof: Base64UrlSchema,
    label: z.string().trim().min(1).max(80),
    clientReleaseId: NonEmptyStringSchema.max(256),
  })
  .strict()
export type ManagementDeviceEnrollmentRequest = z.input<typeof ManagementDeviceEnrollmentRequestSchema>

export const ManagementDeviceEnrollmentResponseSchema = z
  .object({
    deviceId: ManagementDeviceIdSchema,
    deviceSecret: Base64UrlSchema,
  })
  .strict()
export type ManagementDeviceEnrollmentResponse = z.output<typeof ManagementDeviceEnrollmentResponseSchema>

export const ManagementSessionRequestSchema = z
  .object({ deviceId: ManagementDeviceIdSchema, deviceSecret: Base64UrlSchema })
  .strict()
export type ManagementSessionRequest = z.input<typeof ManagementSessionRequestSchema>

export const ManagementSessionResponseSchema = z
  .object({ authenticated: z.literal(true), deviceId: ManagementDeviceIdSchema, csrfToken: Base64UrlSchema })
  .strict()
export type ManagementSessionResponse = z.output<typeof ManagementSessionResponseSchema>

export const ManagementDeviceViewSchema = z
  .object({
    id: ManagementDeviceIdSchema,
    label: z.string().trim().min(1).max(80),
    createdAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().optional(),
    revokedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
export type ManagementDeviceView = z.output<typeof ManagementDeviceViewSchema>

export const ClientNotificationSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    kind: z.enum(['action-required']),
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(240),
    occurredAt: z.number().int().nonnegative(),
    route: z
      .string()
      .regex(/^\/(?:work|connections|users|extensions|settings)(?:\/[^?#]*)?$/u)
      .optional(),
  })
  .strict()
export type ClientNotification = z.output<typeof ClientNotificationSchema>

export const MANAGEMENT_PAIR_PROOF_PREFIX = 'nxt-management-pair-v1' as const

export const managementPairProofMessage = (input: {
  readonly challengeId: string
  readonly serverNonce: string
  readonly clientNonce: string
  readonly instanceId: ServerInstanceId
  readonly spkiSha256: string
}): string =>
  [
    MANAGEMENT_PAIR_PROOF_PREFIX,
    input.challengeId,
    input.serverNonce,
    input.clientNonce,
    input.instanceId,
    input.spkiSha256,
  ].join('\n')

export const INSECURE_HTTP_MANAGEMENT_PAIR_PROOF_PREFIX = 'nxt-management-pair-insecure-http-v1' as const

export const insecureHttpManagementPairProofMessage = (input: {
  readonly challengeId: string
  readonly serverNonce: string
  readonly clientNonce: string
  readonly instanceId: ServerInstanceId
  readonly transportBinding: string
}): string =>
  [
    INSECURE_HTTP_MANAGEMENT_PAIR_PROOF_PREFIX,
    input.challengeId,
    input.serverNonce,
    input.clientNonce,
    input.instanceId,
    input.transportBinding,
  ].join('\n')
