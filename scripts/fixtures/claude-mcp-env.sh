# Synthetic Claude proof providers need the host grant that real Claude passes only
# to the Cockpit MCP child. Read it from the private config in these fixtures.
[ -n "${COCKPIT_MCP_TOKEN:-}" ] && return 0
previous=''
config=''
for argument in "$@"; do
  if [ "$previous" = '--mcp-config' ]; then config=$argument; break; fi
  previous=$argument
done
[ -z "$config" ] && return 0
COCKPIT_MCP_TOKEN=$(node -e 'const fs=require("fs");const value=process.argv[1];const config=JSON.parse(value.startsWith("{")?value:fs.readFileSync(value,"utf8"));process.stdout.write(config.mcpServers.cockpit.env.COCKPIT_MCP_TOKEN)' "$config") || return 1
COCKPIT_MCP_URL=$(node -e 'const fs=require("fs");const value=process.argv[1];const config=JSON.parse(value.startsWith("{")?value:fs.readFileSync(value,"utf8"));process.stdout.write(config.mcpServers.cockpit.env.COCKPIT_MCP_URL)' "$config") || return 1
export COCKPIT_MCP_TOKEN COCKPIT_MCP_URL
