#!/usr/bin/env node
/**
 * Render a page and assert the three things a code read cannot see.
 *
 *   1. SPECIFICITY — a descendant selector on a bare element (`.navlinks a`)
 *      silently outranking a component class (`.btn-dark`). The CSS reads
 *      correctly in isolation; only the computed value on the rendered node
 *      shows the collision.
 *   2. CONTRAST — computed against the resolved ancestor background, not the
 *      one the stylesheet appears to set.
 *   3. OVERFLOW at 390px — the page must not scroll horizontally; wide things
 *      scroll inside their own container.
 *
 * Usage:
 *   node check-render.mjs <file-or-url> [more targets...] [--width 390,1280]
 *
 * Exits non-zero on any FAIL. WARN lines are reported and do not fail.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Adapted from project-to-portfolio check-render; use this repo's browser dependency.
import { chromium } from 'playwright-core'

const LARGE_PX = 24
const LARGE_BOLD_PX = 18.66
const DEFAULT_WIDTHS = [390, 1280]

const parseArgs = (argv) => {
  const targets = []
  let widths = DEFAULT_WIDTHS
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--width') {
      widths = argv[++i].split(',').map((n) => parseInt(n, 10))
    } else {
      targets.push(argv[i])
    }
  }
  return { targets, widths }
}

const toUrl = (target) =>
  /^https?:\/\//.test(target) ? target : pathToFileURL(path.resolve(target)).href

// ---------------------------------------------------------------- in-page ---
// Runs in the browser. Returns plain data only.
const collect = () => {
  const parseRgb = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }

  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  })

  const luminance = ({ r, g, b }) => {
    const f = (c) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }

  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
    return (x + 0.05) / (y + 0.05)
  }

  // Resolved background: walk ancestors, compositing translucent layers.
  const resolvedBg = (el) => {
    const stack = []
    for (let n = el; n; n = n.parentElement) {
      const c = parseRgb(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0) {
        stack.push(c)
        if (c.a === 1) break
      }
    }
    let out = { r: 255, g: 255, b: 255, a: 1 }
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out)
    return out
  }

  const visible = (el) => {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const hasOwnText = (el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0)

  const label = (el) => {
    const id = el.id ? `#${el.id}` : ''
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).join('.')
      : ''
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`
  }

  // --- specificity -----------------------------------------------------
  const specificity = (sel) => {
    const s = sel.replace(/::[a-z-]+/g, ' ')
    const ids = (s.match(/#[\w-]+/g) || []).length
    const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length
    const types = (s.replace(/[#.:[][^\s>+~]*/g, ' ').match(/[a-zA-Z][\w-]*/g) || []).length
    return ids * 10000 + classes * 100 + types
  }

  // Does the selector's rightmost compound target a bare element (no class/id)?
  const bareTail = (sel) => {
    const tail = sel.trim().split(/[\s>+~]+/).pop() || ''
    return /^[a-zA-Z][\w-]*$/.test(tail)
  }
  const classTail = (sel) => {
    const tail = sel.trim().split(/[\s>+~]+/).pop() || ''
    return /[.#]/.test(tail)
  }

  const colorRules = []
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    if (!rules) continue
    const walk = (list) => {
      for (const rule of list) {
        if (rule.cssRules && !rule.selectorText) { walk(rule.cssRules); continue }
        if (!rule.selectorText || !rule.style) continue
        if (!rule.style.getPropertyValue('color')) continue
        for (const sel of rule.selectorText.split(',')) {
          const s = sel.trim()
          // state/pseudo-element rules do not describe the resting node
          if (/::|:hover|:focus|:active|:visited|:target/.test(s)) continue
          colorRules.push({ sel, spec: specificity(s), value: rule.style.getPropertyValue('color').trim() })
        }
      }
    }
    walk(rules)
  }

  const specificityFindings = []
  const seen = new Set()
  for (const { sel } of colorRules) {
    let nodes
    try { nodes = document.querySelectorAll(sel) } catch { continue }
    for (const el of nodes) {
      if (seen.has(el) || !visible(el) || !hasOwnText(el)) continue
      seen.add(el)
      const matching = colorRules.filter((r) => { try { return el.matches(r.sel) } catch { return false } })
      if (matching.length < 2) continue
      const top = matching.reduce((a, b) => (b.spec >= a.spec ? b : a))
      const losers = matching.filter((r) => r !== top && classTail(r.sel))
      if (bareTail(top.sel) && losers.length) {
        specificityFindings.push({
          node: label(el),
          winner: top.sel.trim(),
          winnerValue: top.value,
          overridden: losers.map((l) => `${l.sel.trim()} { color: ${l.value} }`),
          computed: getComputedStyle(el).color,
        })
      }
    }
  }

  // --- contrast --------------------------------------------------------
  const contrastFindings = []
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || !hasOwnText(el)) continue
    const s = getComputedStyle(el)
    const fg = parseRgb(s.color)
    if (!fg) continue
    const bg = resolvedBg(el)
    const composited = fg.a < 1 ? over(fg, bg) : fg
    const size = parseFloat(s.fontSize)
    const weight = parseInt(s.fontWeight, 10) || 400
    const large = size >= LARGE || (size >= LARGE_BOLD && weight >= 700)
    const need = large ? 3 : 4.5
    const got = ratio(composited, bg)
    if (got < need) {
      contrastFindings.push({
        node: label(el),
        ratio: Math.round(got * 100) / 100,
        need,
        fg: s.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      })
    }
  }

  // --- overflow --------------------------------------------------------
  const overflow = []
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.right > window.innerWidth + 1 || r.left < -1) {
        // ignore children of an element that scrolls on its own axis
        let scroller = false
        for (let n = el.parentElement; n; n = n.parentElement) {
          const ox = getComputedStyle(n).overflowX
          if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { scroller = true; break }
        }
        if (!scroller) overflow.push({ node: label(el), right: Math.round(r.right), left: Math.round(r.left) })
      }
    }
  }

  return {
    specificity: specificityFindings,
    contrast: contrastFindings,
    overflow: overflow.slice(0, 20),
    pageWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }
}

// -------------------------------------------------------------- runner ---
const run = async () => {
  const { targets, widths } = parseArgs(process.argv.slice(2))
  if (!targets.length) {
    console.error('usage: node check-render.mjs <file-or-url> [...] [--width 390,1280]')
    process.exit(2)
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  let failures = 0

  for (const target of targets) {
    const url = toUrl(target)
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const consoleErrors = []
      page.on('pageerror', (e) => consoleErrors.push(String(e)))
      try {
        const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
        if (res && !res.ok() && url.startsWith('http')) {
          console.log(`FAIL ${target} @${width}: HTTP ${res.status()}`)
          failures++
          await page.close()
          continue
        }
      } catch (e) {
        console.log(`FAIL ${target} @${width}: navigation ${e.message}`)
        failures++
        await page.close()
        continue
      }

      const r = await page.evaluate(
        `(() => { const LARGE = ${LARGE_PX}; const LARGE_BOLD = ${LARGE_BOLD_PX}; return (${collect.toString()})(); })()`
      )

      const head = `${target} @${width}px`
      const lines = []

      // Specificity and overflow are hard failures; contrast is a failure too,
      // but reported separately so the cause is legible.
      for (const f of r.specificity) {
        lines.push(
          `  FAIL specificity  ${f.node}\n` +
          `      winner: ${f.winner} { color: ${f.winnerValue} }  -> computed ${f.computed}\n` +
          `      overrides: ${f.overridden.join(' | ')}`
        )
      }
      for (const f of r.contrast) {
        lines.push(`  FAIL contrast     ${f.node}  ${f.ratio}:1 (needs ${f.need}) fg ${f.fg} on ${f.bg}`)
      }
      if (r.overflow.length) {
        lines.push(`  FAIL overflow     page ${r.pageWidth}px > viewport ${r.viewport}px`)
        for (const f of r.overflow) lines.push(`      ${f.node} (left ${f.left}, right ${f.right})`)
      }
      for (const e of consoleErrors) lines.push(`  WARN pageerror    ${e}`)

      failures += r.specificity.length + r.contrast.length + (r.overflow.length ? 1 : 0)
      console.log(lines.length ? `${head}\n${lines.join('\n')}` : `PASS ${head}`)
      await page.close()
    }
  }

  await browser.close()
  if (failures) {
    console.log(`\n${failures} failure(s).`)
    process.exit(1)
  }
  console.log('\nAll render checks passed.')
}

run()
