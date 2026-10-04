// Build the actual Cockpit UI with local adapters, then embed it in the static page.
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const sample = await readFile(resolve(here, 'demo/sample-app.html'), 'utf8')
const result = await build({
  entryPoints: [resolve(here, 'demo/entry.tsx')], bundle: true, write: false, outdir: 'out', minify: true,
  jsx: 'automatic', format: 'iife', target: ['chrome120', 'safari17'], legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"', localStorage: 'demoStorage' },
  inject: [resolve(here, 'demo/storage.ts')],
  plugins: [{ name: 'local-demo-adapters', setup(plugin) {
    plugin.onResolve({ filter: /(?:^|\/)api(?:\.ts)?$/ }, args => args.importer.includes('/web/src/') ? { path: resolve(here, 'demo/api.ts') } : undefined)
    plugin.onResolve({ filter: /(?:^|\/)native(?:\.ts)?$/ }, args => args.importer.includes('/web/src/') ? { path: resolve(here, 'demo/native.ts') } : undefined)
    plugin.onLoad({ filter: /web\/src\/components\/PreviewPane\.tsx$/ }, async args => ({
      contents: 'const sampleHtml = ' + JSON.stringify(sample) + ';\nconst sampleLink = URL.createObjectURL(new Blob([sampleHtml], {type:"text/html"}));\n' +
        (await readFile(args.path, 'utf8')).replace('src={url}', 'srcDoc={sampleHtml}').replace('href={url}', 'href={sampleLink}'),
      loader: 'tsx',
    }))
  } }],
})
const css = result.outputFiles.find(f => f.path.endsWith('.css')).text
const js = result.outputFiles.find(f => f.path.endsWith('.js')).text
// Offline and network-blocked even if a future production component adds a fetch.
const html = '<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' blob:; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; frame-src about: blob:; connect-src \'none\'; form-action \'none\'"><style>' + css + '</style><body><div id="root"></div><script>' + js.replace(/<\/script/gi, '<\\/script') + '</script></body></html>'
const file = resolve(here, 'index.html')
const page = await readFile(file, 'utf8')
const payload = '<script type="application/json" id="cockpit-demo">' + JSON.stringify(html).replace(/</g, '\\u003c') + '</script>'
if (!page.includes('id="cockpit-demo"')) throw new Error('Missing cockpit-demo embed marker')
const pageCss = await readFile(resolve(here, 'page.css'), 'utf8')
const tour = await readFile(resolve(here, 'demo-tour.js'), 'utf8')
const featureGroups = JSON.parse(await readFile(resolve(here, 'features.json'), 'utf8'))
const featureCount = featureGroups.reduce((count, group) => count + group.items.length, 0)
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const featureDirectory = `<details class="feature-directory"><summary>Browse all ${featureCount} features <span aria-hidden="true">↘</span></summary><div class="feature-groups">${featureGroups.map(group => `<div class="feature-group"><h3>${escapeHtml(group.title)}</h3><ul>${group.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`).join('')}</div></details>`
const directoryMarker = /<!-- FEATURE_DIRECTORY_START -->[\s\S]*?<!-- FEATURE_DIRECTORY_END -->/
if (!directoryMarker.test(page)) throw new Error('Missing feature directory marker')
await writeFile(file, page.replace(/<script type="application\/json" id="cockpit-demo">[\s\S]*?<\/script>/, () => payload)
  .replace(/<style id="landing-style">[\s\S]*?<\/style>/, () => '<style id="landing-style">' + pageCss + '</style>')
  .replace(/<script id="demo-tour-script">[\s\S]*?<\/script>/, () => '<script id="demo-tour-script">' + tour + '</script>')
  .replace(directoryMarker, () => `<!-- FEATURE_DIRECTORY_START -->${featureDirectory}<!-- FEATURE_DIRECTORY_END -->`))
console.log(`Embedded production UI: ${Math.round(js.length / 1024)} KB JS + ${Math.round(css.length / 1024)} KB CSS`)
