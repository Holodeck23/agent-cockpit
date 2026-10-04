import { describe, expect, it } from 'vitest'
import { acpPrompt, claudeUserMessage, codexInput, withImagePaths } from '../server/agents/image-input.ts'
import type { OutgoingImage } from '../server/agents/types.ts'

const image: OutgoingImage = { path: '/state/attachments/t/abc.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' }

describe('images going to each agent (I2)', () => {
  it('Claude: base64 image blocks before the text, the shape Claude 2.1.289 read', () => {
    expect(claudeUserMessage('what is this?', [image], 'q1')).toEqual({
      type: 'user', uuid: 'q1',
      message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'text', text: 'what is this?' },
      ] },
    })
    expect(claudeUserMessage('hi')).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
  })
  it('Codex: localImage items naming the stored file', () => {
    expect(codexInput('look', [image])).toEqual([{ type: 'localImage', path: image.path }, { type: 'text', text: 'look', text_elements: [] }])
  })
  it('ACP: image blocks only when the agent takes them, otherwise the path in the text', () => {
    expect(acpPrompt('look', [image], true)).toEqual([{ type: 'image', data: image.data, mimeType: 'image/png' }, { type: 'text', text: 'look' }])
    const [only] = acpPrompt('look', [image], false)
    expect(only).toMatchObject({ type: 'text' })
    expect((only as { text: string }).text).toContain(image.path)
  })
  it('names each image by path, and leaves a message without images alone', () => {
    expect(withImagePaths('look')).toBe('look')
    expect(withImagePaths('look', [image])).toBe(`look\n\nAn image is attached to this message. To see it, open:\n- ${image.path}`)
    expect(withImagePaths('look', [image, { ...image, path: '/b.png' }])).toContain('2 images are attached')
  })
})
