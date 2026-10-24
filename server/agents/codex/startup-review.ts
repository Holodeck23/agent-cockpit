import { isAbsolute } from 'node:path'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const REFUSED = 'Codex setup could not be reviewed. Your message was not delivered.'
const MANAGED = 'This managed Codex setup is not supported by Cockpit yet. Your message was not delivered.'

/**
 * Review the native effective configuration before creating or resuming a thread.
 * Empty tables merge: disable each inherited MCP server by its resolved name.
 * The host's bridge is retained only when no lower layer contributes to its name.
 * startup-binding.ts rechecks native identities. Neither qualifies atomic loader
 * isolation or pre-app-server cloud-managed startup.
 */
export function codexReviewedThreadConfig(response: unknown, hostBridge: boolean): Record<string, unknown> {
  const refuse = (): never => { throw new Error(REFUSED) }
  if (!record(response) || !record(response.config)) return refuse()
  const config = response.config
  if (!record(config.features) || !Array.isArray(config.notify) || config.notify.length !== 0) return refuse()
  for (const name of ['hooks', 'plugins', 'apps', 'enable_mcp_apps', 'skill_mcp_dependency_install']) {
    if (config.features[name] !== false) return refuse()
  }
  if (config.mcpServers !== undefined) return refuse()
  const servers = config.mcp_servers ?? {}
  if (!record(servers) || Object.keys(servers).length > 64) return refuse()
  for (const [name, server] of Object.entries(servers)) {
    if (!name || name.length > 256 || !record(server)) return refuse()
  }
  if (!Array.isArray(response.layers) || !response.layers.length || response.layers.length > 64) return refuse()
  let flags = 0
  let bridge: Record<string, unknown> | undefined
  for (const layer of response.layers) {
    if (!record(layer) || !record(layer.name) || !record(layer.config)) return refuse()
    const source = layer.name
    if (['mdm', 'enterpriseManaged', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm'].includes(String(source.type))) {
      throw new Error(MANAGED)
    }
    if (source.type === 'sessionFlags') flags++
    else if (['packagedDefaults', 'system', 'user'].includes(String(source.type))) {
      if (typeof source.file !== 'string' || !isAbsolute(source.file)) return refuse()
    } else if (source.type === 'project') {
      const folder = source.dotCodexFolder ?? source.dot_codex_folder
      if (typeof folder !== 'string' || !isAbsolute(folder)) return refuse()
    } else return refuse()
    const layerServers = layer.config.mcp_servers
    if (layerServers !== undefined) {
      if (!record(layerServers)) return refuse()
      if (Object.hasOwn(layerServers, 'cockpit') && (source.type !== 'sessionFlags' || !hostBridge)) return refuse()
      if (source.type === 'sessionFlags' && Object.keys(layerServers).some(name => name !== 'cockpit')) return refuse()
      if (source.type === 'sessionFlags' && Object.hasOwn(layerServers, 'cockpit')) {
        if (!record(layerServers.cockpit)) return refuse()
        bridge = layerServers.cockpit
      }
    }
  }
  if (flags !== 1 || (Object.hasOwn(servers, 'cockpit') && (!hostBridge || !bridge))) return refuse()
  // Thread-level tables can replace launch tables. Retain the raw host flag layer;
  // normalized effective config contains null defaults that cannot round-trip as TOML.
  // Computed names are JSON object keys, never interpolated into TOML paths.
  return { mcp_servers: Object.fromEntries(Object.keys(servers).map(name => [name, name === 'cockpit' ? structuredClone(bridge) : { enabled: false }])) }
}
