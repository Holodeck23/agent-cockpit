# Synthetic Claude proof providers need the host grant that real Claude passes only
# to the Cockpit MCP child. Read it from the private config in these fixtures.
fixture_node=${COCKPIT_FIXTURE_NODE:-node}
fixture_replay=0
previous=''
config=''
for argument in "$@"; do
  [ "$argument" = '--replay-user-messages' ] && fixture_replay=1
  if [ "$previous" = '--mcp-config' ]; then config=$argument; fi
  previous=$argument
done
if [ -n "$config" ] && [ "$COCKPIT_FIXTURE_LEGACY_ENV" != '1' ]; then
  COCKPIT_MCP_TOKEN=$("$fixture_node" -e 'const fs=require("fs");const value=process.argv[1];const config=JSON.parse(value.startsWith("{")?value:fs.readFileSync(value,"utf8"));process.stdout.write(config.mcpServers.cockpit.env.COCKPIT_MCP_TOKEN)' "$config") || return 1
  COCKPIT_MCP_URL=$("$fixture_node" -e 'const fs=require("fs");const value=process.argv[1];const config=JSON.parse(value.startsWith("{")?value:fs.readFileSync(value,"utf8"));process.stdout.write(config.mcpServers.cockpit.env.COCKPIT_MCP_URL)' "$config") || return 1
  export COCKPIT_MCP_TOKEN COCKPIT_MCP_URL
fi

# Consume Claude's initialization request before a stand-in handles user turns.
# The helper starts the configured packaged stdio bridge and checks its scoped host.
fixture_read_line() {
  while IFS= read -r line; do
    case "$line" in
      *'"type":"control_request"'*'"subtype":"initialize"'*)
        request_id=$(printf '%s\n' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
        [ -n "$request_id" ] || return 1
        if "$fixture_node" "$(dirname "$0")/../claude-mcp-ready.mjs" "$config" >/dev/null; then
          printf '{"type":"control_response","response":{"request_id":"%s","subtype":"success","response":{}}}\n' "$request_id"
        else
          printf '{"type":"control_response","response":{"request_id":"%s","subtype":"error","response":{"message":"Fixture bridge initialization failed"}}}\n' "$request_id"
        fi
        ;;
      *) return 0 ;;
    esac
  done
  return 1
}

fixture_replay_line() {
  [ "$fixture_replay" = 1 ] || return 0
  "$fixture_node" -e 'const message=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({...message,isReplay:true})+"\n")' "$line"
}
