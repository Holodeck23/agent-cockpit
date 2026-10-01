import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImageError, MAX_IMAGE_BYTES, readProjectImage, removeProjectImages, saveProjectImage } from '../server/projects/images.ts'
import { createProjectStore } from '../server/projects/store.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`

describe('project pictures', () => {
  it('stores a real image under the app root and replaces the previous one', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-img-'))
    const first = saveProjectImage(root, '/work/site', dataUrl('image/png', PNG), 1)
    const second = saveProjectImage(root, '/work/site', dataUrl('image/png', PNG), 2)
    expect(second).toMatch(/^[a-f0-9]{16}-2\.png$/)
    expect(readdirSync(join(root, 'project-images'))).toEqual([second])
    expect(readProjectImage(root, first)).toBeUndefined()
    expect(readProjectImage(root, second)).toMatchObject({ mime: 'image/png' })
    removeProjectImages(root, '/work/site')
    expect(existsSync(join(root, 'project-images', second))).toBe(false)
  })

  it('refuses SVG, mislabelled bytes, empty and oversized files', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-img-'))
    const bad = [
      dataUrl('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')),
      dataUrl('image/png', Buffer.from('GIF89a not a png')),
      'data:image/png;base64,',
      dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])),
      'https://example.com/x.png',
    ]
    for (const url of bad) expect(() => saveProjectImage(root, '/work/site', url)).toThrow(ImageError)
    expect(readProjectImage(root, '../projects.json')).toBeUndefined()
  })
})

describe('removing a project', () => {
  it('hides it from the list without forgetting it, and opening it again brings it back', () => {
    const store = createProjectStore(mkdtempSync(join(tmpdir(), 'cockpit-proj-')))
    store.open('/work/site', { pinned: true, instructions: 'Use pnpm' })
    const hidden = store.hide('/work/site')
    expect(hidden).toMatchObject({ hidden: true, pinned: false, instructions: 'Use pnpm' })
    expect(store.list()).toEqual([])
    expect(store.list({ includeHidden: true })).toHaveLength(1)
    store.ensure([{ path: '/work/site', at: new Date().toISOString() }]) // its conversations don't re-add it
    expect(store.list()).toEqual([])
    expect(store.open('/work/site')).toMatchObject({ hidden: undefined, instructions: 'Use pnpm' })
    expect(store.list()).toHaveLength(1)
  })

  it('keeps the picture name with the project', () => {
    const store = createProjectStore(mkdtempSync(join(tmpdir(), 'cockpit-proj-')))
    store.open('/work/site')
    expect(store.setImage('/work/site', '0123456789abcdef-5.png').image).toBe('0123456789abcdef-5.png')
    expect(store.setImage('/work/site', undefined).image).toBeUndefined()
    expect(() => store.setImage('/work/site', '../evil.png')).toThrow()
  })
})
