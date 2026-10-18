import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { assertInputAttachmentsCurrent, assertInputReferencesCurrent, compareInputOperation, inputEnvelopeHash, inputRecovery,
  InputEnvelopeError, parseInputEnvelope, serializeInputEnvelope, type InputEnvelope, type InputSkillRevision } from '../server/threads/input-envelope.ts'

const hash = (letter = 'a') => letter.repeat(64)
function fixture() {
  return {
    schemaVersion: 1, operationId: '7b0f6c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f', runId: 'run-one', intent: 'message',
    binding: { threadId: 'thread-one', projectId: 'project-one', workspaceId: 'worktree-one', bindingId: 'binding-one',
      provider: 'claude', providerVersion: 'fixture-1', runtimeRevision: 'runtime-one', adapterVersion: 'adapter-one',
      accountId: 'account-one', accountGeneration: 1, principalId: 'principal-one', credentialContextId: 'credential-one',
      nativeSessionId: 'session-one', launchGeneration: 1, manifestId: 'manifest-one', sourceRevision: 'setup-one', authorizationRevision: 'consent-one' },
    content: { text: 'Use the selected skill', agentText: 'Frozen workflow expansion\nUse the selected skill',
      images: [{ file: `${hash()}.png`, mediaType: 'image/png', name: 'example.png' }],
      skills: [{ id: 'claude:plugin:source-one:review', provider: 'claude', scope: 'plugin', sourceId: 'source-one',
        selectionId: 'selection-one', selectionRevision: hash('b'), sourceRevision: hash('c'), nativeName: 'fixture:review',
        resources: [{ id: 'resource-one', revision: hash('d') }], arguments: '  --target "a b"\nżółć  ' }],
      workflows: [{ name: 'Review', prompt: 'Frozen workflow expansion' }], fromConversation: { id: 'other-thread', title: 'Original context' } },
  }
}
function current(input: InputEnvelope) {
  return { binding: input.binding, runId: input.runId, skills: input.content.skills.map(({ arguments: _arguments, ...skill }) => skill) }
}

describe('complete host input envelope', () => {
  it('round trips the complete private payload without losing whitespace, arguments, attachments or provenance', () => {
    const raw = fixture(), input = parseInputEnvelope(raw)
    expect(parseInputEnvelope(JSON.parse(serializeInputEnvelope(input)))).toEqual(raw)
    expect(input.content.skills[0]!.arguments).toBe('  --target "a b"\nżółć  ')
    raw.content.skills[0]!.arguments = 'mutated after acceptance'
    expect(input.content.skills[0]!.arguments).not.toBe(raw.content.skills[0]!.arguments)
    expect(Object.isFrozen(input.content.skills[0]!.resources)).toBe(true)
    expect(() => { (input.content.skills[0] as { arguments: string }).arguments = 'changed' }).toThrow()
  })

  it('canonicalizes object keys while retaining meaningful array and string order', () => {
    const input = parseInputEnvelope(fixture())
    const reverseKeys = (value: any): any => Array.isArray(value) ? value.map(reverseKeys)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value
    expect(inputEnvelopeHash(parseInputEnvelope(reverseKeys(fixture())))).toBe(inputEnvelopeHash(input))
    const changed = fixture(); changed.content.skills[0]!.arguments += ' '
    expect(inputEnvelopeHash(parseInputEnvelope(changed))).not.toBe(inputEnvelopeHash(input))
  })

  it.each(Object.keys(fixture().binding))('binds hashing and current-reference checks to %s', (field) => {
    const input = parseInputEnvelope(fixture()), changed = fixture()
    const binding = changed.binding as Record<string, unknown>
    binding[field] = typeof binding[field] === 'number' ? 2 : field === 'provider' ? 'codex' : 'different'
    if (field === 'provider') changed.content.skills = []
    const next = parseInputEnvelope(changed)
    expect(inputEnvelopeHash(next)).not.toBe(inputEnvelopeHash(input))
    expect(() => assertInputReferencesCurrent(input, { ...current(input), binding: next.binding })).toThrow(InputEnvelopeError)
    expect(compareInputOperation(input, next)).toBe('conflict')
  })

  it.each(['arguments', 'sourceRevision', 'selectionRevision', 'sourceId', 'selectionId', 'nativeName'] as const)('conflicts on a changed skill %s under the same operation ID', (field) => {
    const input = parseInputEnvelope(fixture()), changed = fixture()
    changed.content.skills[0]![field] = field.endsWith('Revision') ? hash('e') : 'different'
    expect(compareInputOperation(input, parseInputEnvelope(changed))).toBe('conflict')
  })

  it('also fingerprints agent expansion, workflow snapshots, images, resources, run and steering intent', () => {
    const input = parseInputEnvelope(fixture())
    const changes = [
      (value: ReturnType<typeof fixture>) => { value.content.agentText += 'changed' },
      (value: ReturnType<typeof fixture>) => { value.content.workflows[0]!.prompt += 'changed' },
      (value: ReturnType<typeof fixture>) => { value.content.fromConversation.id = 'different-thread' },
      (value: ReturnType<typeof fixture>) => { value.content.images[0]!.file = `${hash('f')}.png` },
      (value: ReturnType<typeof fixture>) => { value.content.skills[0]!.resources[0]!.revision = hash('f') },
      (value: ReturnType<typeof fixture>) => { value.runId = 'different-run' },
      (value: ReturnType<typeof fixture>) => { value.intent = 'steer' },
    ]
    for (const change of changes) {
      const next = fixture(); change(next)
      expect(compareInputOperation(input, parseInputEnvelope(next))).toBe('conflict')
    }
    const next = fixture(); next.operationId = '8b0f6c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f'
    expect(compareInputOperation(input, parseInputEnvelope(next))).toBe('different-operation')
    expect(compareInputOperation(input, parseInputEnvelope(JSON.parse(serializeInputEnvelope(input))))).toBe('replay')
  })

  it('retains distinct same-name skills and invocation order', () => {
    const raw = fixture(), first = raw.content.skills[0]!
    raw.content.skills.push({ ...first, id: 'claude:project:other:review', scope: 'project', sourceId: 'other', arguments: '--other' })
    const input = parseInputEnvelope(raw)
    expect(input.content.skills).toHaveLength(2)
    assertInputReferencesCurrent(input, current(input))
    raw.content.skills.reverse()
    expect(compareInputOperation(input, parseInputEnvelope(raw))).toBe('conflict')
  })

  it('rejects changed, removed, ambiguous and same-name substituted skill/resource revisions', () => {
    const input = parseInputEnvelope(fixture()), live = current(input)
    assertInputReferencesCurrent(input, live)
    const skill = live.skills[0]!
    const alternatives: InputSkillRevision[][] = [[], [skill, skill], [{ ...skill, id: 'different-id' }],
      [{ ...skill, sourceRevision: hash('e') }], [{ ...skill, nativeName: 'other:review' }],
      [{ ...skill, resources: [{ id: 'resource-one', revision: hash('e') }] }]]
    for (const skills of alternatives) expect(() => assertInputReferencesCurrent(input, { ...live, skills })).toThrow(InputEnvelopeError)
    expect(() => assertInputReferencesCurrent(input, { ...live, runId: 'other-run' })).toThrow(InputEnvelopeError)
  })

  it('accepts skill-only/image-only input but cannot invent skills in legacy text/image input', () => {
    const raw = fixture(); raw.content.text = ''; raw.content.agentText = ''; raw.content.images = []
    expect(parseInputEnvelope(raw).content.skills).toHaveLength(1)
    const imageOnly = fixture(); imageOnly.content.text = ''; imageOnly.content.skills = []
    expect(parseInputEnvelope(imageOnly).content.images).toHaveLength(1)
    raw.content.skills = []
    expect(() => parseInputEnvelope(raw)).toThrow(InputEnvelopeError)
    expect(() => parseInputEnvelope({ kind: 'user_text', text: 'legacy /review', runId: 'old' })).toThrow(InputEnvelopeError)
  })

  it.each(['version', 'unknown-field', 'path', 'mime', 'provider', 'generation', 'hash', 'operation', 'missing-skills'] as const)('rejects %s without reflecting raw private input in the error', (which) => {
    const raw: any = fixture(), canary = 'PRIVATE_INPUT_CANARY'
    if (which === 'version') raw.schemaVersion = 2
    if (which === 'unknown-field') raw.content.secret = canary
    if (which === 'path') raw.content.images[0].file = `/private/${canary}.png`
    if (which === 'mime') raw.content.images[0].mediaType = 'image/jpeg'
    if (which === 'provider') raw.binding.provider = 'codex'
    if (which === 'generation') raw.binding.launchGeneration = 0
    if (which === 'hash') raw.content.skills[0].sourceRevision = canary
    if (which === 'operation') raw.operationId = canary
    if (which === 'missing-skills') delete raw.content.skills
    expect(() => parseInputEnvelope(raw)).toThrow('Input envelope is invalid')
    try { parseInputEnvelope(raw) } catch (error) {
      expect(JSON.stringify(error)).not.toContain(canary)
      expect(String(error)).not.toContain(canary)
    }
  })

  it.each(['not-dispatched', 'withdrawn'] as const)('restores every original field only after verified %s', (delivery) => {
    const input = parseInputEnvelope(fixture()), recovered = inputRecovery(input, delivery)
    expect(recovered).toEqual({ kind: 'restore-draft', envelope: input, automaticReplay: false })
    if (recovered.kind === 'restore-draft') expect(inputEnvelopeHash(recovered.envelope)).toBe(inputEnvelopeHash(input))
  })

  it('keeps uncertain delivery in recovery without dispatch permission or an unsent claim', () => {
    const input = parseInputEnvelope(fixture())
    expect(inputRecovery(input, 'uncertain')).toEqual({ kind: 'needs-recovery', envelope: input, automaticReplay: false })
    expect(inputRecovery(input, 'consumed')).toEqual({ kind: 'consumed', automaticReplay: false })
    expect(input.binding).not.toHaveProperty('qualificationId')
    expect(() => inputRecovery(input, 'unknown' as 'uncertain')).toThrow(InputEnvelopeError)
  })

  it('verifies the exact current image bytes rather than trusting a stored filename', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const file = `${createHash('sha256').update(bytes).digest('hex')}.png`
    const raw = fixture(); raw.content.images[0]!.file = file
    const input = parseInputEnvelope(raw), image = { file, bytes }
    assertInputAttachmentsCurrent(input, [image])
    expect(() => assertInputAttachmentsCurrent(input, [])).toThrow(InputEnvelopeError)
    expect(() => assertInputAttachmentsCurrent(input, [image, image])).toThrow(InputEnvelopeError)
    expect(() => assertInputAttachmentsCurrent(input, [{ file, bytes: Buffer.from('replaced') }])).toThrow(InputEnvelopeError)
    expect(() => assertInputAttachmentsCurrent(input, [{ file, bytes: Buffer.concat([bytes, Buffer.from('changed')]) }])).toThrow(InputEnvelopeError)
  })
})
