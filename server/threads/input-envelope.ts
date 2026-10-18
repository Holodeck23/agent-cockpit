// W13 shared contract, intentionally not wired into dispatch before the feasibility gate.
// Host-owned, private data: never broadcast these records or their sensitive revision hashes.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sniffImage } from '../files/image-kind.ts'

export const INPUT_ENVELOPE_VERSION = 1
const id = z.string().min(1).max(300).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value))
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const provider = z.enum(['claude', 'codex', 'antigravity', 'opencode'])

/** Live identity and consent, with no future qualification receipt required for first dispatch. */
const bindingSchema = z.strictObject({
  threadId: id,
  projectId: id,
  workspaceId: id,
  bindingId: id,
  provider,
  providerVersion: id,
  runtimeRevision: id,
  adapterVersion: id,
  accountId: id,
  accountGeneration: generation,
  principalId: id,
  credentialContextId: id,
  nativeSessionId: id,
  launchGeneration: generation,
  manifestId: id,
  sourceRevision: id,
  authorizationRevision: id,
})

const skillRevisionShape = {
  /** Qualified identity: a same-name skill from another source is a different ID. */
  id,
  provider: z.enum(['claude', 'codex']),
  scope: z.enum(['user', 'project', 'worktree', 'plugin', 'linked', 'system', 'admin']),
  sourceId: id,
  selectionId: id,
  selectionRevision: revision,
  sourceRevision: revision,
  nativeName: id,
  /** References only; the host resolves reviewed resources and executable paths at dispatch. */
  resources: z.array(z.strictObject({ id, revision })).max(100),
}
const skillRevisionSchema = z.strictObject(skillRevisionShape)
const skillInputSchema = z.strictObject({ ...skillRevisionShape, arguments: z.string().max(200_000) })
const imageSchema = z.strictObject({
  /** Conversation-owned, content-addressed attachment name. No client-supplied absolute path. */
  file: z.string().regex(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  name: z.string().max(200).optional(),
}).refine((image) => {
  const ext = image.file.slice(image.file.lastIndexOf('.') + 1)
  return image.mediaType === `image/${ext === 'jpg' ? 'jpeg' : ext}`
})
const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(INPUT_ENVELOPE_VERSION),
  operationId: z.uuid(),
  runId: id,
  intent: z.enum(['message', 'steer']),
  binding: bindingSchema,
  content: z.strictObject({
    text: z.string().max(200_000),
    /** The host's exact expansion at acceptance, not a later reread of edited workflows. */
    agentText: z.string().max(1_000_000),
    images: z.array(imageSchema).max(8),
    skills: z.array(skillInputSchema).max(32),
    workflows: z.array(z.strictObject({ name: z.string().min(1).max(80), prompt: z.string().max(200_000) })).max(50),
    fromConversation: z.strictObject({ id, title: z.string().max(200) }).optional(),
  }),
}).refine((input) => input.content.text.trim().length > 0 || input.content.images.length > 0 || input.content.skills.length > 0)
  .refine((input) => input.content.skills.every((skill) => skill.provider === input.binding.provider))

type Immutable<T> = T extends readonly (infer Item)[] ? readonly Immutable<Item>[]
  : T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> } : T
export type InputEnvelope = Immutable<z.output<typeof envelopeSchema>>
export type InputBinding = InputEnvelope['binding']
export type InputSkillRevision = Immutable<z.output<typeof skillRevisionSchema>>

/** Deliberately omits raw input, paths, skill arguments and Zod issue payloads. */
export class InputEnvelopeError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'STALE_BINDING' | 'STALE_SKILL' | 'STALE_IMAGE') {
    super(code === 'INVALID_INPUT' ? 'Input envelope is invalid'
      : code === 'STALE_BINDING' ? 'Input belongs to a different run or setup binding'
        : code === 'STALE_IMAGE' ? 'An attached image changed or is no longer available'
          : 'A selected skill or resource changed; review the original selection')
  }
}

function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value as Immutable<T>
}

export function parseInputBinding(raw: unknown): InputBinding {
  const parsed = bindingSchema.safeParse(raw)
  if (!parsed.success) throw new InputEnvelopeError('INVALID_INPUT')
  return freeze(parsed.data)
}

/** Parse at the trusted host boundary; parsing alone grants no execution authority. */
export function parseInputEnvelope(raw: unknown): InputEnvelope {
  const parsed = envelopeSchema.safeParse(raw)
  if (!parsed.success) throw new InputEnvelopeError('INVALID_INPUT')
  return freeze(parsed.data)
}

/** Zod reconstructs fields in schema order, independent of JSON object insertion order. */
export const serializeInputEnvelope = (input: InputEnvelope): string => JSON.stringify(parseInputEnvelope(input))
/** One fingerprint for persistence, queue identity, steering and recovery, not just visible text. */
export const inputEnvelopeHash = (input: InputEnvelope): string => createHash('sha256')
  .update('cockpit-input-envelope-v1\0').update(serializeInputEnvelope(input)).digest('hex')

/** A replay answers with the durable original result; it never authorizes another dispatch. */
export function compareInputOperation(original: InputEnvelope, next: InputEnvelope): 'different-operation' | 'replay' | 'conflict' {
  const first = parseInputEnvelope(original), second = parseInputEnvelope(next)
  if (first.operationId !== second.operationId) return 'different-operation'
  return inputEnvelopeHash(first) === inputEnvelopeHash(second) ? 'replay' : 'conflict'
}

/** Identity check only. Readiness, reviewed executable dependencies and consent stay separate. */
export function assertInputReferencesCurrent(input: InputEnvelope, current: {
  readonly binding: InputBinding
  readonly runId: string
  readonly skills: readonly InputSkillRevision[]
}): void {
  const envelope = parseInputEnvelope(input), binding = bindingSchema.safeParse(current.binding)
  if (!binding.success || envelope.runId !== current.runId || JSON.stringify(envelope.binding) !== JSON.stringify(binding.data)) {
    throw new InputEnvelopeError('STALE_BINDING')
  }
  for (const selected of envelope.content.skills) {
    const matches = current.skills.filter((skill) => skill.id === selected.id)
    const match = matches.length === 1 ? skillRevisionSchema.safeParse(matches[0]) : undefined
    // Parse to the revision schema without arguments; do not silently substitute the current skill.
    const { arguments: _arguments, ...original } = selected
    if (!match?.success || JSON.stringify(original) !== JSON.stringify(match.data)) throw new InputEnvelopeError('STALE_SKILL')
  }
}

/** Read only from this conversation's trusted image store, then dispatch these exact byte snapshots. */
export function assertInputAttachmentsCurrent(input: InputEnvelope, images: readonly {
  readonly file: string; readonly bytes: Buffer
}[]): void {
  const envelope = parseInputEnvelope(input)
  for (const image of envelope.content.images) {
    const matches = images.filter((row) => row.file === image.file)
    const bytes = matches.length === 1 ? matches[0]!.bytes : undefined
    const kind = bytes ? sniffImage(bytes) : undefined
    if (!bytes || !kind || kind.mime !== image.mediaType
      || `${createHash('sha256').update(bytes).digest('hex')}.${kind.ext}` !== image.file) {
      throw new InputEnvelopeError('STALE_IMAGE')
    }
  }
}

export type InputRecovery =
  | { readonly kind: 'restore-draft'; readonly envelope: InputEnvelope; readonly automaticReplay: false }
  | { readonly kind: 'needs-recovery'; readonly envelope: InputEnvelope; readonly automaticReplay: false }
  | { readonly kind: 'consumed'; readonly automaticReplay: false }

/** Only a verified no-dispatch/withdrawal restores a draft. Uncertainty never means unsent. */
export function inputRecovery(input: InputEnvelope, delivery: 'not-dispatched' | 'withdrawn' | 'uncertain' | 'consumed'): InputRecovery {
  const envelope = parseInputEnvelope(input)
  if (delivery === 'consumed') return { kind: 'consumed', automaticReplay: false }
  if (delivery === 'uncertain') return { kind: 'needs-recovery', envelope, automaticReplay: false }
  if (delivery === 'not-dispatched' || delivery === 'withdrawn') return { kind: 'restore-draft', envelope, automaticReplay: false }
  throw new InputEnvelopeError('INVALID_INPUT')
}
