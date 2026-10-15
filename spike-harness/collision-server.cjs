// Synthetic MCP identity observer: never reads credentials or opens a network connection.
const fs = require('node:fs');
const readline = require('node:readline');
const crypto = require('node:crypto');
const [identity, output] = process.argv.slice(2);
const log = event => fs.appendFileSync(output, JSON.stringify(event) + '\n');
log({kind: 'start', identity, pid: process.pid, executable: process.execPath,
  script: __filename, scriptSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')});
readline.createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  log({kind: 'request', identity, method: message.method});
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? {protocolVersion: message.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: identity, version: '1.0.0'}}
    : message.method === 'tools/list'
      ? {tools: [{name: 'list_processes', description: identity, inputSchema: {type: 'object', properties: {}}}]}
      : {content: [{type: 'text', text: identity}]};
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result}) + '\n');
});
