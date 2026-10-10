// Bundles the Electron main process (with the whole server) and the preload
// into CommonJS files under dist-electron/. Vite builds the page separately.
import { build, type BuildOptions } from 'esbuild'
import { cpSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const common: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'warning',
  // Fixed at bundle time, so nothing at run time can turn a release build into a debuggable one
  // (electron/debug-flags.ts). Only `npm run package` and scripts/release.ts set it.
  define: { 'process.env.COCKPIT_RELEASE_BUILD': JSON.stringify(process.env.COCKPIT_RELEASE_BUILD === '1' ? '1' : '') },
}

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' }),
  // The cockpit MCP server each agent session spawns (see server/mcp/stdio.ts).
  build({ ...common, entryPoints: ['server/mcp/stdio.ts'], outfile: 'dist-electron/mcp.cjs' }),
])
// Dock animation frames (scripts/make-dock-frames.ts), loaded by electron/dock-activity.ts.
// Cleared first, so a frame set that was removed from build/dock (the old dark set) is not left behind.
rmSync(`${root}dist-electron/dock`, { recursive: true, force: true })
cpSync(`${root}build/dock`, `${root}dist-electron/dock`, { recursive: true })
console.log(`[build-electron] ${process.env.COCKPIT_RELEASE_BUILD === '1' ? 'RELEASE build (debug flags refused), ' : ''}dist-electron/dock/, dist-electron/main.cjs, dist-electron/preload.cjs, dist-electron/mcp.cjs`)
