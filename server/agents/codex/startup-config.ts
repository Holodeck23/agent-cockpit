/**
 * Stock Codex 0.162.1 launch controls. Keep the selected CODEX_HOME in place: these
 * override executable features, not the account's credential or memory location.
 *
 * An empty mcp_servers table would merge with inherited servers. These controls
 * do NOT suppress those servers; startup-review.ts supplies per-thread MCP controls.
 * Higher-precedence legacy managed config also needs refusal/qualification before
 * the compatibility release can claim trusted startup.
 */
export function codexStartupConfigArgs(): string[] {
  return [
    'features.hooks=false',
    'features.plugins=false',
    'features.apps=false',
    'features.enable_mcp_apps=false',
    'features.skill_mcp_dependency_install=false',
    'notify=[]',
  ].flatMap((override) => ['-c', override])
}
