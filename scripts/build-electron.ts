// Bundles the Electron main process (with the whole server) and the preload
// into CommonJS files under dist-electron/. Vite builds the page separately.
import { build, type BuildOptions } from 'esbuild'
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
}

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' }),
  // The cockpit MCP server each agent session spawns (see server/mcp/stdio.ts).
  build({ ...common, entryPoints: ['server/mcp/stdio.ts'], outfile: 'dist-electron/mcp.cjs' }),
])
console.log('[build-electron] dist-electron/main.cjs, dist-electron/preload.cjs, dist-electron/mcp.cjs')
