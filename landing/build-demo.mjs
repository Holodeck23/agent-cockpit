// Build the actual Cockpit UI with local adapters, then embed it in the static page.
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const sampleSource = await readFile(resolve(repo, 'server/onboarding/sample.ts'), 'utf8')
const sample = sampleSource.match(/const html = '([^\n]+)';/)[1]
  .replace('A real app, running on your Mac.', 'A sample app, running in this browser.')
  .replace('Your agent can open it, inspect it, and help you change it.', 'In Cockpit, your agent opens the real app here. Try the counter.')
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
await writeFile(file, page.replace(/<script type="application\/json" id="cockpit-demo">[\s\S]*?<\/script>/, () => payload)
  .replace(/<style id="landing-style">[\s\S]*?<\/style>/, () => '<style id="landing-style">' + pageCss + '</style>')
  .replace(/<script id="demo-tour-script">[\s\S]*?<\/script>/, () => '<script id="demo-tour-script">' + tour + '</script>'))
console.log(`Embedded production UI: ${Math.round(js.length / 1024)} KB JS + ${Math.round(css.length / 1024)} KB CSS`)
