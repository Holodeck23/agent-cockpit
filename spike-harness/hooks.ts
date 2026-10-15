// Startup/termination probes with real CLI + Cockpit stopChild; no model requests.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stopChild, signalAgent } from '../server/agents/stop.ts'

const root = resolve(process.argv[2]!)
const cli = process.argv[3]!
mkdirSync(root, { recursive: false, mode: 0o700 })
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
for (const operation of ['timeout', 'cancel']) {
  for (const descendants of ['ordinary', 'detached']) {
    const out = `${root}/${operation}-${descendants}`
    mkdirSync(out); mkdirSync(`${out}/profile`, { mode: 0o700 })
    const events = `${out}/events.jsonl`
    const command = [process.execPath, resolve('spike-harness/hook-probe.cjs'), events, descendants].map(shellQuote).join(' ')
    const settings = { hooks: { SessionStart: [{ hooks: [{ type:'command', command, timeout: operation === 'timeout' ? 1 : 10 }] }] } }
    const env = { ...process.env, CLAUDE_CONFIG_DIR:`${out}/profile`, DISABLE_AUTOUPDATER:'1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1' }
    for (const key of ['COCKPIT_MCP_TOKEN','COCKPIT_MCP_URL','CLAUDECODE']) delete env[key]
    const argv = ['--print','--verbose','--input-format','stream-json','--output-format','stream-json',
      '--permission-mode','manual','--permission-prompt-tool','stdio','--no-session-persistence','--no-chrome',
      '--setting-sources','project','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
      '--settings', JSON.stringify(settings)]
    writeFileSync(`${out}/launch.json`, JSON.stringify({cli,argv},null,2))
    const started = Date.now()
    const child = spawn(cli,argv,{cwd:out,env,detached:true,stdio:['pipe','pipe','pipe']})
    const logs: string[] = []
    let exited = false, cancelled = false, bytes = 0
    child.on('exit', (code,signal) => { exited=true; logs.push(JSON.stringify({kind:'provider-exit',code,signal,time:Date.now()})) })
    child.on('error', error => { exited=true; logs.push(JSON.stringify({kind:'spawn-error',error:error.message})) })
    for (const [name, stream] of [['stdout',child.stdout],['stderr',child.stderr]] as const) {
      stream.on('data', data => {
        bytes += data.length
        if (bytes < 2_000_000) logs.push(JSON.stringify({kind:name,time:Date.now(),data:data.toString()}))
      })
    }
    child.stdin.write(JSON.stringify({type:'control_request',request_id:'init',request:{subtype:'initialize'}})+'\n')
    // Safety watchdog is independent of stopChild, whose descendant behavior is under test.
    const watchdog = setTimeout(() => signalAgent(child,'SIGKILL'),9000)
    try {
      while (Date.now()-started < 7000) {
        if (operation === 'cancel' && !cancelled && existsSync(events) && readFileSync(events,'utf8').includes('descendant-start')) {
          cancelled = true
          logs.push(JSON.stringify({kind:'stop-request',time:Date.now()}))
          await stopChild(child, () => !exited)
          logs.push(JSON.stringify({kind:'stop-resolved',time:Date.now()}))
        }
        await delay(100)
      }
    } finally {
      signalAgent(child,'SIGTERM')
      await delay(200)
      signalAgent(child,'SIGKILL')
      clearTimeout(watchdog)
      writeFileSync(`${out}/stream.jsonl`,logs.join('\n')+'\n')
    }
    const observed = existsSync(events) ? readFileSync(events,'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
    const result = {operation,descendants,cancelled,observed,providerEvents:logs.map(line=>JSON.parse(line)).filter(event=>!['stdout','stderr'].includes(event.kind))}
    writeFileSync(`${out}/result.json`,JSON.stringify(result,null,2)+'\n')
    console.log(JSON.stringify(result))
    if (!observed.some(event => event.kind === 'hook-start')) throw new Error('Hook did not start; stop investigation')
  }
}
