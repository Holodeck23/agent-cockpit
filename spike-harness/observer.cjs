// Synthetic-only observer. Never record the general inherited environment.
const fs = require('node:fs');
const readline = require('node:readline');
const [kind, output] = process.argv.slice(2);
fs.appendFileSync(output, JSON.stringify({
  kind, pid: process.pid, ppid: process.ppid, argv: process.argv,
  token: process.env.COCKPIT_MCP_TOKEN ?? null,
  url: process.env.COCKPIT_MCP_URL ?? null,
}) + '\n');
if (kind === 'hook') {
  process.stdin.resume();
  process.stdin.on('end', () => process.stdout.write('{}\n'));
} else {
  readline.createInterface({input: process.stdin}).on('line', line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const result = message.method === 'initialize'
      ? {protocolVersion: message.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'synthetic-observer', version: '1.0.0'}}
      : message.method === 'tools/list' ? {tools: []} : {};
    process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result}) + '\n');
  });
}
