import { AUTO_ALLOWED_TOOLS, MCP_SERVER_NAME, type CockpitMcpLaunch } from './sessions.ts'

// How each CLI is told about the cockpit MCP server. Verified against
// claude 2.1.284 (stdio servers inherit the agent's env) and codex 0.147
// (only variables named in env_vars are forwarded).

export function claudeMcpOptions(launch: CockpitMcpLaunch) {
  return {
    mcpConfig: {
      mcpServers: {
        [MCP_SERVER_NAME]: { type: 'stdio', command: launch.command, args: [...launch.args], env: { ...launch.env } },
      },
    },
    allowedTools: AUTO_ALLOWED_TOOLS.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool}`),
    env: launch.secretEnv,
  }
}

/** JSON strings and string arrays are valid TOML, which is what `-c` values are parsed as. */
const toml = (value: string | readonly string[]): string => JSON.stringify(value)

export function codexMcpConfigArgs(launch: CockpitMcpLaunch): string[] {
  const key = `mcp_servers.${MCP_SERVER_NAME}`
  const env = Object.entries(launch.env ?? {})
  const pairs: string[] = [
    `${key}.command=${toml(launch.command)}`,
    `${key}.args=${toml([...launch.args])}`,
    `${key}.env_vars=${toml(Object.keys(launch.secretEnv))}`,
    ...(env.length ? [`${key}.env={${env.map(([name, value]) => `${toml(name)}=${toml(value)}`).join(', ')}}`] : []),
    ...AUTO_ALLOWED_TOOLS.map((tool) => `${key}.tools.${tool}.approval_mode="approve"`),
  ]
  return pairs.flatMap((pair) => ['-c', pair])
}
