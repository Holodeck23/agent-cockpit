// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { Editor, rootCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import type { Node } from '@milkdown/kit/prose/model'
import { Transform } from '@milkdown/kit/prose/transform'
import { baselineOf, markdownOf, type Baseline, type MarkdownResult } from '../../web/src/markdown/document.ts'

// u30-1: withoutEdgeSpaces() trims with trimStart()/trimEnd(), which strip every Unicode space
// (NBSP, ideographic space, ...). Markdown only drops spaces and tabs at a paragraph's edge, so the
// re-parsed body keeps the others and the read-back guard compared two different documents: any
// edit anywhere in a file with an unchanged block that starts or ends with NBSP was refused.
// CORRECT behaviour: an edit elsewhere in such a file is written, and the NBSP block stays as it was.

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
function typeAtEndOfLast(markdown: string, typed: string): MarkdownResult {
  const { baseline, doc } = open(markdown)
  let at = -1
  doc.forEach((child, offset) => { at = offset })
  const end = at + 1 + doc.nodeAt(at)!.content.size
  const edited = new Transform(doc).insert(end, doc.type.schema.text(typed)).doc
  return withCtx((ctx) => markdownOf(ctx, baseline, edited))
}

describe('an edit in a file with a block that starts or ends with a non-ASCII space', () => {
  const cases: Array<[string, string]> = [
    ['control', 'First\n\nSecond\n'],
    ['nbsp lead', ' First\n\nSecond\n'],
    ['ideographic lead', '　First\n\nSecond\n'],
    ['nbsp trail', 'First \n\nSecond\n'],
    ['nbsp heading lead', '#  Title\n\nSecond\n'],
  ]
  for (const [name, source] of cases) {
    it(`is written, not refused: ${name}`, () => {
      expect(typeAtEndOfLast(source, '!')).toEqual({ ok: true, markdown: source.replace('Second', 'Second!') })
    })
  }
})
