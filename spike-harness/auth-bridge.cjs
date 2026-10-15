// Transparent probe wrapper around the actual source bridge; inserts one read-only call.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const {createHash, randomUUID} = require('node:crypto');
const readline = require('node:readline');
const [out, repo] = process.argv.slice(2);
const log = value => fs.appendFileSync(`${out}/bridge.jsonl`, JSON.stringify(value) + '\n');
const source = `${repo}/server/mcp/stdio.ts`;
const tsx = fs.realpathSync(`${repo}/node_modules/tsx/dist/cli.mjs`);
const command = fs.realpathSync(process.execPath);
log({kind:'start', command, tsx, source,
  sourceSha256:createHash('sha256').update(fs.readFileSync(source)).digest('hex')});
const bridge = spawn(command, [tsx, source], {stdio:['pipe','pipe','inherit']});
const probeId = `probe-${randomUUID()}`;
let inserted = false;
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  bridge.stdin.write(line+'\n');
  if (!inserted && message.method === 'notifications/initialized') {
    inserted = true;
    bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:probeId,method:'tools/call',
      params:{name:'list_processes',arguments:{}}})+'\n');
  }
}).on('close', () => bridge.stdin.end());
readline.createInterface({input:bridge.stdout}).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === probeId) log({kind:'authenticated-call', response:message});
  else process.stdout.write(line+'\n');
});
bridge.on('error', error => { log({kind:'spawn-error',message:error.message}); process.exitCode=1; });
bridge.on('exit', code => { process.exitCode=code ?? 1; });
