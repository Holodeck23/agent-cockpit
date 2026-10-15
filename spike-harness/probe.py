"""Bounded startup probes; no user prompt, real token, or model request."""
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

parser = argparse.ArgumentParser()
parser.add_argument('case', choices=['project-loose', 'project-strict', 'token', 'token-scoped'])
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent
out = Path(args.output).resolve() / args.case
out.mkdir(parents=True, exist_ok=False)
profile = out / 'profile'
profile.mkdir(mode=0o700)
cwd = root / ('fixture-' + args.case + '-' + uuid4().hex[:8])
cwd.mkdir(exist_ok=False)
observer = root / 'observer.cjs'
observations = out / 'observations.jsonl'
node = shutil.which('node')
cli = shutil.which('claude')
server = {'type': 'stdio', 'command': node, 'args': [str(observer), 'mcp', str(observations)]}
settings = {'disableAllHooks': True}
if args.case.startswith('token'):
    import shlex
    settings = {'hooks': {'SessionStart': [{'hooks': [{'type': 'command', 'command': shlex.join([node, str(observer), 'hook', str(observations)]), 'timeout': 5}]}]}}
else:
    (cwd / '.mcp.json').write_text(json.dumps({'mcpServers': {'synthetic_project': server}}))
mcp_config = {'mcpServers': {'unrelated': server} if args.case.startswith('token') else {}}
mcp_argument = json.dumps(mcp_config)
if args.case == 'token-scoped':
    # Proposed narrow transport: secret in an owner-only config FILE and only
    # in the intended child's env entry. Provider argv contains a path only.
    mcp_config['mcpServers']['cockpit_synthetic'] = {**server, 'args': [str(observer), 'cockpit', str(observations)], 'env': {
        'COCKPIT_MCP_TOKEN': 'synthetic-codex1-token-not-a-credential', 'COCKPIT_MCP_URL': 'http://127.0.0.1:1/synthetic'}}
    config_file = profile / 'private-mcp.json'
    with open(config_file, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
        json.dump(mcp_config, handle)
    mcp_argument = str(config_file)
argv = [cli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio',
        '--setting-sources', 'project', '--no-session-persistence', '--no-chrome',
        '--settings', json.dumps(settings), '--mcp-config', mcp_argument]
if args.case != 'project-loose':
    argv += ['--strict-mcp-config']
env = os.environ.copy()
for key in ['COCKPIT_MCP_TOKEN', 'COCKPIT_MCP_URL', 'CLAUDECODE']:
    env.pop(key, None)
env.update(CLAUDE_CONFIG_DIR=str(profile), DISABLE_AUTOUPDATER='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
if args.case == 'token':
    env.update(COCKPIT_MCP_TOKEN='synthetic-codex1-token-not-a-credential', COCKPIT_MCP_URL='http://127.0.0.1:1/synthetic')
(out / 'launch.json').write_text(json.dumps({'argv': argv, 'cwd': str(cwd), 'profile': str(profile), 'version': subprocess.check_output([cli, '--version'], text=True).strip(), 'control': 'initialize only; no user prompt'}, indent=2))
process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
process.stdin.write((json.dumps({'type': 'control_request', 'request_id': 'synthetic-init', 'request': {'subtype': 'initialize', 'hooks': None}}) + '\n').encode())
process.stdin.flush()
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
buffers = {'stdout': bytearray(), 'stderr': bytearray()}
started = time.monotonic()
while time.monotonic() - started < 15 and process.poll() is None:
    for key, _ in selector.select(timeout=0.25):
        data = os.read(key.fileobj.fileno(), 65536)
        if data:
            buffers[key.data].extend(data)
        else:
            selector.unregister(key.fileobj)
    if sum(map(len, buffers.values())) > 2_000_000:
        break
# Terminate only this probe's process group, including its synthetic children.
try:
    os.killpg(process.pid, signal.SIGTERM)
except ProcessLookupError:
    pass
try:
    process.wait(timeout=3)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=3)
for name, data in buffers.items():
    (out / (name + '.log')).write_bytes(data)
result = {'case': args.case, 'exit': process.returncode, 'elapsedSeconds': round(time.monotonic() - started, 2), 'observations': [json.loads(line) for line in observations.read_text().splitlines()] if observations.exists() else []}
(out / 'result.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
