// Connects the Milkdown editor to the splice: records where each block sat in the source
// when the Document view opened, and turns the edited document back into Markdown that
// keeps every untouched block byte for byte.
import { parserCtx, remarkCtx, schemaCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { Mark, type Node } from '@milkdown/kit/prose/model'
import { SerializerState } from '@milkdown/kit/transformer'
import { spliceMarkdown, type SourceBlock } from './splice.ts'

const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/

export interface Baseline {
  /** YAML front matter, kept verbatim and not shown as editable. */
  readonly frontMatter: string
  readonly body: string
  readonly ranges: readonly SourceBlock[]
  readonly blocks: readonly Node[]
  /** The document as first shown; unchanged, it writes back the exact original text. */
  readonly doc: Node
  readonly markdown: string
}

export type BaselineResult = { readonly ok: true; readonly baseline: Baseline } | { readonly ok: false; readonly reason: string }
export type MarkdownResult = { readonly ok: true; readonly markdown: string } | { readonly ok: false; readonly reason: string }

const childrenOf = (doc: Node): Node[] => {
  const out: Node[] = []
  doc.forEach((child) => { out.push(child) })
  return out
}

export const splitFrontMatter = (markdown: string): { frontMatter: string; body: string } => {
  const frontMatter = FRONT_MATTER.exec(markdown)?.[0] ?? ''
  return { frontMatter, body: markdown.slice(frontMatter.length) }
}

/** The markers a block was written with, so a rewritten block looks like its neighbours. */
export interface MarkdownStyle { bullet?: '*' | '+' | '-'; bulletOrdered?: '.' | ')'; rule?: '*' | '-' | '_'; fence?: '`' | '~' }

export function styleOf(markdown: string): MarkdownStyle {
  const style: { -readonly [K in keyof MarkdownStyle]: MarkdownStyle[K] } = {}
  const bullet = /^[ \t]*([*+-])[ \t]/m.exec(markdown)?.[1]
  if (bullet === '*' || bullet === '+' || bullet === '-') style.bullet = bullet
  const ordered = /^[ \t]*\d+([.)])[ \t]/m.exec(markdown)?.[1]
  if (ordered === '.' || ordered === ')') style.bulletOrdered = ordered
  const rule = /^[ \t]*([*_-])(?:[ \t]*\1){2,}[ \t]*$/m.exec(markdown)?.[1]
  if (rule === '*' || rule === '-' || rule === '_') style.rule = rule
  const fence = /^[ \t]*(`{3,}|~{3,})/m.exec(markdown)?.[1]?.[0]
  if (fence === '`' || fence === '~') style.fence = fence
  return style
}

/**
 * Same content, ignoring attributes the editor view derives for itself: Milkdown gives each
 * heading an id from its text, which a plain parse leaves empty. Plain eq() would call every
 * document with a heading changed.
 */
export function sameContent(a: Node, b: Node): boolean {
  if (a.type !== b.type || a.text !== b.text || a.childCount !== b.childCount || !Mark.sameSet(a.marks, b.marks)) return false
  const ignored = a.type.name === 'heading' ? 'id' : undefined
  const keys = new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])
  for (const key of keys) if (key !== ignored && JSON.stringify(a.attrs[key]) !== JSON.stringify(b.attrs[key])) return false
  for (let i = 0; i < a.childCount; i += 1) if (!sameContent(a.child(i), b.child(i))) return false
  return true
}

interface Positioned { position?: { start?: { offset?: number }; end?: { offset?: number } } }

export function baselineOf(ctx: Ctx, markdown: string): BaselineResult {
  try { return readBaseline(ctx, markdown) } catch (error) {
    console.warn('[cockpit] document view could not read this file:', error)
    return { ok: false, reason: 'The Document view could not read this file, so it opens in Source.' }
  }
}

function readBaseline(ctx: Ctx, markdown: string): BaselineResult {
  const { frontMatter, body } = splitFrontMatter(markdown)
  const remark = ctx.get(remarkCtx)
  const tree = remark.runSync(remark.parse(body), body) as unknown as { children: Positioned[] }
  const doc = ctx.get(parserCtx)(body)
  // An empty body still shows one empty paragraph; it has no source to keep.
  const blocks = tree.children.length === 0 && body.trim() === '' ? [] : childrenOf(doc)
  const ranges: SourceBlock[] = []
  for (const child of tree.children) {
    const start = child.position?.start?.offset
    const end = child.position?.end?.offset
    if (start === undefined || end === undefined || end < start || start < (ranges.at(-1)?.end ?? 0)) {
      return { ok: false, reason: 'Part of this document cannot be mapped back to its Markdown, so it opens in Source.' }
    }
    ranges.push({ start, end })
  }
  if (ranges.length !== blocks.length) {
    return { ok: false, reason: 'This document uses Markdown the Document view does not show, so it opens in Source to keep it intact.' }
  }
  return { ok: true, baseline: { frontMatter, body, ranges, blocks, doc, markdown } }
}

/** Markdown for the edited document, or a refusal when writing it would not read back as shown. */
export function markdownOf(ctx: Ctx, baseline: Baseline, doc: Node): MarkdownResult {
  if (sameContent(doc, baseline.doc)) return { ok: true, markdown: baseline.markdown }
  try { return writeMarkdown(ctx, baseline, doc) } catch (error) {
    console.warn('[cockpit] document view could not write this change:', error)
    return { ok: false, reason: 'This change cannot be written as Markdown without altering it. Undo it, or make it in Source.' }
  }
}

function writeMarkdown(ctx: Ctx, baseline: Baseline, doc: Node): MarkdownResult {
  const remark = ctx.get(remarkCtx)
  const schema = ctx.get(schemaCtx)
  const defaults: MarkdownStyle = { bullet: '-', rule: '-', fence: '`', ...styleOf(baseline.body) }
  const serializers = new Map<string, (doc: Node) => string>()
  const serializerFor = (style: MarkdownStyle) => {
    const key = JSON.stringify(style)
    let serializer = serializers.get(key)
    if (!serializer) {
      const styled = remark().data('settings', { ...remark.data('settings'), ...style })
      serializer = SerializerState.create(schema, styled as typeof remark)
      serializers.set(key, serializer)
    }
    return serializer
  }
  const body = spliceMarkdown({
    source: baseline.body,
    ranges: baseline.ranges,
    original: baseline.blocks,
    current: childrenOf(doc),
    same: sameContent,
    serialize: (block, replaces) => {
      const range = replaces === undefined ? undefined : baseline.ranges[replaces]
      const own = range ? styleOf(baseline.body.slice(range.start, range.end)) : {}
      return serializerFor({ ...defaults, ...own })(doc.type.create(null, block))
    },
  })
  // What we write must read back as exactly what is on screen, or it is not written.
  if (!sameContent(ctx.get(parserCtx)(body), doc)) {
    console.warn('[cockpit] document view refused a change that would not read back as shown')
    return { ok: false, reason: 'This change cannot be written as Markdown without altering it. Undo it, or make it in Source.' }
  }
  return { ok: true, markdown: baseline.frontMatter + body }
}
