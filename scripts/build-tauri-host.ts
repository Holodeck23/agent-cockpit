// Prepares everything the Tauri shell bundles beside its Rust binary (src-tauri/tauri.conf.json):
//   dist-tauri/sidecar.cjs  the server host (src-tauri/host/sidecar.ts)
//   dist-tauri/mcp.cjs      the cockpit MCP server each agent session spawns
//   dist-tauri/dist/        the web build (run `npm run build` first)
//   src-tauri/binaries/node-<target>  the Node runtime that runs both, copied from this machine
// Nothing here is tracked: dist-tauri/ and src-tauri/binaries/ are build output.
import { build, type BuildOptions } from 'esbuild'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}dist-tauri`
if (!existsSync(`${root}dist/index.html`)) throw new Error('No web build: run `npm run build` first.')

const common: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logLevel: 'warning',
  define: { 'process.env.COCKPIT_RELEASE_BUILD': JSON.stringify(process.env.COCKPIT_RELEASE_BUILD === '1' ? '1' : '') },
}
rmSync(out, { recursive: true, force: true })
await Promise.all([
  build({ ...common, entryPoints: ['src-tauri/host/sidecar.ts'], outfile: `${out}/sidecar.cjs` }),
  build({ ...common, entryPoints: ['server/mcp/stdio.ts'], outfile: `${out}/mcp.cjs` }),
])
cpSync(`${root}dist`, `${out}/dist`, { recursive: true })

// Tauri's externalBin wants <name>-<rust target triple>; it becomes Contents/MacOS/node.
const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
const node = realpathSync(process.env.COCKPIT_NODE_BINARY ?? process.execPath)
const target = `${root}src-tauri/binaries/node-${triple}`
mkdirSync(`${root}src-tauri/binaries`, { recursive: true })
cpSync(node, target)
chmodSync(target, 0o755)
const version = execFileSync(target, ['--version'], { encoding: 'utf8' }).trim()
console.log(`[build-tauri-host] dist-tauri/{sidecar.cjs,mcp.cjs,dist/}, src-tauri/binaries/node-${triple} (Node ${version})`)
