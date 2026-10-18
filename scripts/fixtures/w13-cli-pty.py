"""Private, bounded PTY for the isolated native CLI /hooks review flow; no desktop UI control."""
import json
import fcntl
import hashlib
import os
import pty
import re
import select
import signal
import sys
import struct
import termios
import time
from pathlib import Path

os.umask(0o077)
root = Path(os.environ['COCKPIT_PROOF_PRIVATE_DIR']).resolve()
context_file = Path(os.environ.get('COCKPIT_PROOF_CONTEXT', str(root / 'fixture-context-private.json'))).resolve()
assert context_file.parent == root
context = json.loads(context_file.read_text())
assert Path(context['project']).parent == root
assert Path(context['env']['HOME']).parent == root and Path(context['env']['CODEX_HOME']).parent == root
assert context['manifest']['cli'] == '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0'
assert context['manifest']['runtime'] == '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b'
for key, file in {'cli': context['cli'], 'runtime': context['runtime'], 'callback': root / 'stop-observer.cjs',
                  'hooks': root / 'codex-home/hooks.json', 'config': root / 'codex-home/config.toml'}.items():
    with Path(file).open('rb') as source:
        assert hashlib.file_digest(source, 'sha256').hexdigest() == context['manifest'][key]
terminal_name = os.environ.get('COCKPIT_PROOF_TERMINAL_ATTEMPT', 'terminal-01')
assert re.fullmatch(r'[a-z0-9-]{1,60}', terminal_name)
terminal = root / terminal_name
terminal.mkdir(mode=0o700)
log = (terminal / 'native-trust-terminal-private.log').open('xb')
pid, fd = pty.fork()
if pid == 0:
    os.chdir(context['project'])
    os.execve(context['cli'], [context['cli'], '--no-daemon', '--no-alt-screen'], context['env'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))

buffer = bytearray()
started = time.monotonic()
exited = False
commands = ''
print(json.dumps({'ready': True}), flush=True)
try:
    while time.monotonic() - started < 90:
        ready, _, _ = select.select([fd, sys.stdin], [], [], 0.2)
        if fd in ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            log.write(chunk)
            log.flush()
            buffer.extend(chunk)
            if len(buffer) > 2_000_000:
                raise RuntimeError('Native trust terminal output exceeded bound')
            # Answer the isolated terminal's cursor-position query; never touch the physical terminal.
            if b'\x1b[6n' in chunk:
                os.write(fd, b'\x1b[1;1R')
        if sys.stdin in ready:
            line = sys.stdin.readline()
            if not line:
                break
            command = json.loads(line)
            if 'send' in command:
                value = command['send']
                assert isinstance(value, str) and len(value) <= 200
                commands += value
                assert len(commands) <= 10_000
                os.write(fd, value.encode())
            if command.get('snapshot'):
                text = buffer.decode(errors='replace')
                text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', text)
                text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
                text = text.replace(str(root), '<fixture>').replace(context['runtime'], '<pinned-node>')
                text = re.sub(r"/Users/[^\s'\"<>]+", '<private-path>', text)
                print(json.dumps({'screen': text[-9000:]}), flush=True)
            if command.get('quit'):
                break
        status = os.waitpid(pid, os.WNOHANG)
        if status[0]:
            exited = True
            print(json.dumps({'nativeExited': True, 'status': status[1]}), flush=True)
            break
finally:
    if not exited:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        until = time.monotonic() + 1.5
        while time.monotonic() < until:
            if os.waitpid(pid, os.WNOHANG)[0]:
                exited = True
                break
            time.sleep(0.05)
        if not exited:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
    log.close()
    (terminal / 'native-trust-input-private.json').write_text(json.dumps({'inputs': commands, 'noDesktopControl': True, 'sharedDaemonDisabled': True}) + '\n')
