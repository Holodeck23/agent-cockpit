// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { defaultValueCtx, Editor, editorViewCtx, parserCtx, rootCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import type { Node } from '@milkdown/kit/prose/model'
import { Transform } from '@milkdown/kit/prose/transform'
import { baselineOf, markdownOf, sameContent, type Baseline } from '../web/src/markdown/document.ts'

const FIXTURE = `---
title: Garden
tags: [plants]
---
# Garden notes

* water on *Mondays*
* ~~prune~~ roses

- [ ] Open task
- [x] Done task

| Plant | Days |
| --- | --- |
| Tomato | 2 |

<!-- keep-comment -->

---

\`\`\`text
alpha <beta>
\`\`\`

[Example](https://example.com)
`

let editor: Editor
beforeAll(async () => {
  editor = await Editor.make().config((ctx) => ctx.set(rootCtx, document.createElement('div'))).use(commonmark).use(gfm).create()
})
const withCtx = <T>(fn: (ctx: Ctx) => T): T => editor.action(fn)
function open(markdown: string): { baseline: Baseline; doc: Node } {
  return withCtx((ctx) => {
    const result = baselineOf(ctx, markdown)
    if (!result.ok) throw new Error(result.reason)
    return { baseline: result.baseline, doc: result.baseline.doc }
  })
}
const write = (baseline: Baseline, doc: Node): string => withCtx((ctx) => {
  const result = markdownOf(ctx, baseline, doc)
  if (!result.ok) throw new Error(result.reason)
  return result.markdown
})
function findNode(doc: Node, test: (node: Node) => boolean): number {
  let found = -1
  doc.descendants((node, pos) => { if (found < 0 && test(node)) found = pos; return found < 0 })
  return found
}

describe('document view writes Markdown back without reformatting', () => {
  it('returns the exact text when nothing changed', () => {
    const { baseline, doc } = open(FIXTURE)
    expect(write(baseline, doc)).toBe(FIXTURE)
  })

  it('ticking a task changes only that line', () => {
    const { baseline, doc } = open(FIXTURE)
    const pos = findNode(doc, (n) => n.type.name === 'list_item' && n.attrs.checked === false)
    const edited = new Transform(doc).setNodeMarkup(pos, undefined, { ...doc.nodeAt(pos)!.attrs, checked: true }).doc
    expect(write(baseline, edited)).toBe(FIXTURE.replace('- [ ] Open task', '- [x] Open task'))
  })

  it('editing one paragraph leaves front matter, table, comment, rule and fences untouched', () => {
    const { baseline, doc } = open(FIXTURE)
    const pos = findNode(doc, (n) => n.type.name === 'heading')
    const edited = new Transform(doc).insert(pos + 1 + 'Garden notes'.length, doc.type.schema.text(' and more')).doc
    const out = write(baseline, edited)
    expect(out).toBe(FIXTURE.replace('# Garden notes', '# Garden notes and more'))
  })

  it('a new block at the end is added without touching what was there', () => {
    const { baseline, doc } = open(FIXTURE)
    const schema = doc.type.schema
    const edited = new Transform(doc).insert(doc.content.size, schema.nodes.paragraph!.create(null, schema.text('Added line.'))).doc
    expect(write(baseline, edited)).toBe(`${FIXTURE}\nAdded line.\n`)
  })

  it('an empty file can be written from the document view', () => {
    const { baseline, doc } = open('')
    const edited = new Transform(doc).insert(1, doc.type.schema.text('First words')).doc
    expect(write(baseline, edited)).toBe('First words\n')
  })

  it('a rewritten list keeps its own bullet marker, so it does not merge into a neighbouring list', () => {
    const { baseline, doc } = open('* one\n* two\n\n- [ ] task\n')
    const pos = findNode(doc, (n) => n.type.name === 'list_item' && n.attrs.checked === false)
    const edited = new Transform(doc).setNodeMarkup(pos, undefined, { ...doc.nodeAt(pos)!.attrs, checked: true }).doc
    expect(write(baseline, edited)).toBe('* one\n* two\n\n- [x] task\n')
  })

  it('refuses a change that would not read back as shown', () => {
    const { baseline, doc } = open('Plain.\n')
    // Text typed as "# " at the start of a paragraph would re-read as a heading.
    const edited = new Transform(doc).insert(1, doc.type.schema.text('# ')).doc
    const result = withCtx((ctx) => markdownOf(ctx, baseline, edited))
    if (result.ok) expect(withCtx((ctx) => ctx.get(parserCtx)(result.markdown).eq(edited))).toBe(true)
    else expect(result.reason).toMatch(/cannot be written/)
  })

  it('works on the document the editor view shows, whose headings carry generated ids', async () => {
    const root = document.createElement('div'); document.body.append(root)
    const body = FIXTURE.replace(/^---[\s\S]*?---\n/, '')
    const viewEditor = await Editor.make().config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, body) }).use(commonmark).use(gfm).create()
    const out = viewEditor.action((ctx) => {
      const result = baselineOf(ctx, FIXTURE)
      if (!result.ok) throw new Error(result.reason)
      const view = ctx.get(editorViewCtx)
      expect(view.state.doc.eq(result.baseline.doc)).toBe(false) // the heading id differs…
      expect(sameContent(view.state.doc, result.baseline.doc)).toBe(true) // …but the content does not
      let pos = -1
      view.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === 'list_item' && n.attrs.checked === false) pos = p; return pos < 0 })
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...view.state.doc.nodeAt(pos)!.attrs, checked: true }))
      return markdownOf(ctx, result.baseline, view.state.doc)
    })
    expect(out).toEqual({ ok: true, markdown: FIXTURE.replace('- [ ] Open task', '- [x] Open task') })
  })
})

describe('a space typed at the end of a paragraph', () => {
  it('is written as typed instead of being refused', () => {
    const { baseline, doc } = open('Then run\n')
    const at = findNode(doc, (n) => n.type.name === 'paragraph')
    const end = at + 1 + doc.nodeAt(at)!.content.size
    const typed = new Transform(doc).insert(end, doc.type.schema.text(' @workflow:review ')).doc
    expect(write(baseline, typed)).toBe('Then run @workflow:review \n')
  })
  it('never trims spaces inside a code block', async () => {
    const { withoutEdgeSpaces } = await import('../web/src/markdown/document.ts')
    const { doc } = open('```\ncode  \n```\n')
    expect(sameContent(withoutEdgeSpaces(doc), doc)).toBe(true)
  })
})
