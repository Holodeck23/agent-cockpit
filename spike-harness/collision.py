"""Fresh-profile MCP precedence probes. Initialization only; no model turn."""
import argparse
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import time
from uuid import uuid4

p = argparse.ArgumentParser()
p.add_argument('source', choices=['user', 'local', 'project', 'plugin', 'explicit'])
p.add_argument('mode', choices=['baseline', 'loose', 'strict'])
p.add_argument('--output', required=True)
p.add_argument('--intended-config', help='Private file containing an instrumented real bridge config')
a = p.parse_args()
root = Path(__file__).resolve().parent
out = Path(a.output).resolve() / (a.source + '-' + a.mode)
out.mkdir(parents=True, exist_ok=False)
profile = out / 'profile'
profile.mkdir(mode=0o700)
cwd = root / ('fixture-collision-' + uuid4().hex[:8])
cwd.mkdir()
observed = out / 'observed.jsonl'
node, cli = shutil.which('node'), shutil.which('claude')
server = root / 'collision-server.cjs'
def config(identity):
    return {'mcpServers': {'cockpit': {'type': 'stdio', 'command': node, 'args': [str(server), identity, str(observed)]}}}
env = os.environ.copy()
for key in ['COCKPIT_MCP_TOKEN', 'COCKPIT_MCP_URL', 'CLAUDECODE']:
    env.pop(key, None)
env.update(CLAUDE_CONFIG_DIR=str(profile), DISABLE_AUTOUPDATER='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
extra = []
if a.source in ['user', 'local', 'project']:
    # Let the pinned CLI write its documented scope, avoiding guessed discovery paths.
    configured = subprocess.run([cli, 'mcp', 'add', '--scope', a.source, 'cockpit', '--', node, str(server), 'foreign-' + a.source, str(observed)], cwd=cwd, env=env, capture_output=True, text=True, timeout=10)
    (out / 'configure.log').write_text(configured.stdout + configured.stderr)
    configured.check_returncode()
elif a.source == 'plugin':
    plugin = cwd / 'synthetic-plugin'
    (plugin / '.claude-plugin').mkdir(parents=True)
    (plugin / '.claude-plugin/plugin.json').write_text(json.dumps({'name': 'collision-probe', 'version': '1.0.0'}))
    (plugin / '.mcp.json').write_text(json.dumps(config('foreign-plugin')))
    extra = ['--plugin-dir', str(plugin)]
argv = [cli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio', '--no-session-persistence', '--no-chrome',
        '--settings', '{"disableAllHooks":true}', '--allowedTools', 'mcp__cockpit__list_processes', *extra]
if a.mode != 'baseline':
    argv += ['--mcp-config', a.intended_config or json.dumps(config('intended-cockpit'))]
if a.source == 'explicit':
    argv += ['--mcp-config', json.dumps(config('foreign-explicit'))]
if a.mode == 'strict':
    argv += ['--strict-mcp-config']
(out / 'launch.json').write_text(json.dumps({'argv': argv, 'cwd': str(cwd), 'profile': str(profile)}, indent=2))
child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
streams = {'stdout': bytearray(), 'stderr': bytearray()}
sel = selectors.DefaultSelector()
for name in streams:
    sel.register(getattr(child, name), selectors.EVENT_READ, name)
try:
    child.stdin.write((json.dumps({'type': 'control_request', 'request_id': 'init', 'request': {'subtype': 'initialize'}}) + '\n').encode())
    child.stdin.flush()
    start = time.monotonic()
    while time.monotonic() - start < 8 and child.poll() is None:
        for key, _ in sel.select(0.2):
            data = os.read(key.fileobj.fileno(), 65536)
            if data:
                streams[key.data].extend(data)
            else:
                sel.unregister(key.fileobj)
        if sum(map(len, streams.values())) > 2_000_000:
            break
finally:
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)
    for name, data in streams.items():
        (out / (name + '.log')).write_bytes(data)
result = {'source': a.source, 'mode': a.mode, 'observations': [json.loads(line) for line in observed.read_text().splitlines()] if observed.exists() else [], 'exit': child.returncode}
(out / 'result.json').write_text(json.dumps(result, indent=2))
print(json.dumps({'source': a.source, 'mode': a.mode, 'started': [o['identity'] for o in result['observations'] if o['kind'] == 'start'], 'exit': child.returncode}), flush=True)
