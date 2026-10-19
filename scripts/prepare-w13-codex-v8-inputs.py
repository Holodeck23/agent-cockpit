"""One-shot, approved preparation of an isolated public-dependency Cargo cache."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tomllib
import urllib.request

os.umask(0o077)
parser = argparse.ArgumentParser()
parser.add_argument('--candidate', type=Path, required=True)
parser.add_argument('--audit', type=Path, required=True)
parser.add_argument('--evidence', type=Path, required=True)
parser.add_argument('--verify-prepared', action='store_true')
args = parser.parse_args()
candidate = args.candidate.resolve()
cache = candidate / 'target.noindex/w13-source-cargo-home'
inputs = candidate / 'target.noindex/w13-build-inputs'
original = Path.home() / '.cargo'
index = 'index.crates.io-1949cf8c6b5b557f'
sha = lambda data: hashlib.sha256(data).hexdigest()

def run(argv, **kwargs):
    return subprocess.check_output(argv, stderr=subprocess.PIPE, **kwargs)

assert run(['git', 'rev-parse', 'HEAD'], cwd=candidate).decode().strip() == '9e8562bd9e4785ffa855d33b6b112c9ba22910a6'
assert not run(['git', 'status', '--porcelain'], cwd=candidate)
lock_bytes = (candidate / 'codex-rs/Cargo.lock').read_bytes()
assert sha(lock_bytes) == '765110795bf3385d734bf1acfcae77660d29a6c678d5b77015d7ffe49f26e69f'
lock = tomllib.loads(lock_bytes.decode())['package']
audit = json.loads(args.audit.read_text())['missingDeclaredInputsUnderV8Source']
assert len(audit) == 813
rust_prefix = 'third_party/rust/chromium_crates_io/vendor/'
crates = sorted({p.removeprefix(rust_prefix).split('/')[0] for p in audit if p.startswith(rust_prefix)})
assert len(crates) == 45
rust_revision = '26e8ff47f18a8d28d6187a04b6a16cb7332356f8'
archive_root = inputs / ('chromium-rust-' + rust_revision)
archive_root.mkdir(parents=True, exist_ok=True)

def download(name):
    assert name and '/' not in name and '..' not in name
    url = f'https://chromium.googlesource.com/chromium/src/third_party/rust/+archive/{rust_revision}/chromium_crates_io/vendor/{name}.tar.gz'
    path = archive_root / (name + '.tar.gz')
    if path.exists():
        # Retained downloads from this approved preparation; never overwrite.
        data = path.read_bytes()
        if name == 'core_maths-v0_1':
            assert sha(data) == '4b145d5a5aaaff56b929126662ef7a443737c4225dc97dc0620ad0be599c1285'
    else:
        with urllib.request.urlopen(url, timeout=45) as response:
            data = response.read(100_000_001)
        assert len(data) <= 100_000_000
        with path.open('xb') as output:
            output.write(data)
    return dict(crate=name, url=url, archiveSha256=sha(data), bytes=len(data))

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    archives = list(pool.map(download, crates))
print(json.dumps({'pinnedRustArchivesPrepared': len(archives)}), flush=True)

vendor_url = f'https://chromium.googlesource.com/chromium/src/third_party/rust/+/{rust_revision}/chromium_crates_io/vendor/?format=JSON'
with urllib.request.urlopen(vendor_url, timeout=30) as response:
    vendor = json.loads(response.read().decode().removeprefix(")]}'\n"))
expected_trees = {entry['name']: entry['id'] for entry in vendor['entries'] if entry['type'] == 'tree'}

def git_object(kind, content):
    return hashlib.sha1(kind + b' ' + str(len(content)).encode() + b'\0' + content).digest()

def git_tree(tree):
    entries = []
    for name, value in tree.items():
        if isinstance(value, dict):
            entries.append((name + '/', b'40000', name, git_tree(value)))
        else:
            mode, digest = value
            entries.append((name, mode, name, digest))
    content = b''.join(mode + b' ' + name.encode() + b'\0' + digest
                       for _, mode, name, digest in sorted(entries, key=lambda entry: entry[0].encode()))
    return git_object(b'tree', content)

for archive in archives:
    tree = {}
    with tarfile.open(archive_root / (archive['crate'] + '.tar.gz'), 'r:gz') as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            assert not path.is_absolute() and '..' not in path.parts
            assert member.isdir() or member.isfile()
            if member.isfile():
                current = tree
                for part in path.parts[:-1]:
                    current = current.setdefault(part, {})
                assert path.name not in current
                current[path.name] = (b'100755' if member.mode & 0o111 else b'100644',
                                      git_object(b'blob', tar.extractfile(member).read()))
    actual = git_tree(tree).hex()
    assert actual == expected_trees[archive['crate']], archive['crate']
    archive['verifiedGitTreeSha1'] = actual

if args.verify_prepared:
    prepared = json.loads((args.evidence / 'companion-source-inputs-04-prepared.json').read_text())
    v8 = cache / 'registry/src' / index / 'v8-150.4.0'
    original_v8 = original / 'registry/src' / index / 'v8-150.4.0'
    for entry in prepared['restoredInputs']:
        assert sha((v8 / entry['path']).read_bytes()) == entry['sha256']
        assert not (original_v8 / entry['path']).exists()
    verified = dict(status='VERIFIED_PREPARED_SOURCE_INPUTS', archives=archives,
                    pinnedRustGitTreesVerified=len(archives), restoredInputFilesVerified=len(prepared['restoredInputs']),
                    missingDeclaredInputsRestored=len(audit), globalCargoSourceCacheModified=False)
    with (args.evidence / 'companion-source-inputs-04-verified.json').open('x') as output:
        json.dump(verified, output, indent=2)
        output.write('\n')
    print(json.dumps({key: verified[key] for key in ['status', 'pinnedRustGitTreesVerified', 'restoredInputFilesVerified']}), flush=True)
    raise SystemExit(0)

# Clone only locked crates.io sources and their public index. Never copy Cargo
# config, credentials, unrelated registry sources, or unrelated Git histories.
cache.mkdir(mode=0o700)
registry = cache / 'registry'
(registry / 'index').mkdir(parents=True)
index_source = original / 'registry/index' / index
index_config = json.loads((index_source / 'config.json').read_text())
assert index_config.get('dl') == 'https://static.crates.io/crates'
assert index_config.get('api') == 'https://crates.io'
assert not index_config.get('auth-required', False)
run(['/bin/cp', '-cR', str(index_source), str(registry / 'index' / index)])
for folder in ['cache', 'src']:
    (registry / folder / index).mkdir(parents=True)
registry_count = 0
for package in lock:
    source = package.get('source', '')
    if not source.startswith('registry+'):
        continue
    assert source == 'registry+https://github.com/rust-lang/crates.io-index'
    name = f"{package['name']}-{package['version']}"
    archive = original / 'registry/cache' / index / (name + '.crate')
    if archive.exists():
        assert sha(archive.read_bytes()) == package['checksum'], name
        run(['/bin/cp', '-c', str(archive), str(registry / 'cache' / index / archive.name)])
        registry_count += 1
print(json.dumps({'lockedPublicCrateArchivesCloned': registry_count}), flush=True)

git_sources = sorted({p['source'] for p in lock if p.get('source', '').startswith('git+')})
git_records = []
for source in git_sources:
    url, revision = source.removeprefix('git+').split('#')
    url = url.split('?')[0]
    assert url.startswith('https://github.com/') and '@' not in url
    assert len(revision) == 40 and all(c in '0123456789abcdef' for c in revision)
    matches = []
    for db in (original / 'git/db').iterdir():
        probe = subprocess.run(['git', '--git-dir=' + str(db), 'cat-file', '-e', revision + '^{commit}'], capture_output=True)
        if probe.returncode == 0:
            matches.append(db)
    assert len(matches) == 1, 'Pinned public Git object missing or ambiguous'
    dest = cache / 'git/db' / matches[0].name
    dest.parent.mkdir(parents=True, exist_ok=True)
    run(['git', 'init', '--bare', str(dest)])
    run(['git', '--git-dir=' + str(dest), 'fetch', '--depth=1', str(matches[0]), revision])
    assert run(['git', '--git-dir=' + str(dest), 'rev-parse', 'FETCH_HEAD']).decode().strip() == revision
    git_records.append(dict(url=url, revision=revision, onlyPinnedCommitFetched=True))

v8 = registry / 'src' / index / 'v8-150.4.0'
original_v8 = original / 'registry/src' / index / 'v8-150.4.0'
run(['/bin/cp', '-cR', str(original_v8), str(v8)])
# Modern Cargo uses .cargo-ok rather than directory-source checksum files.
# Verify every published file against the locked .crate archive itself.
published_files = 0
with tarfile.open(registry / 'cache' / index / 'v8-150.4.0.crate', 'r:gz') as tar:
    for member in tar:
        path = PurePosixPath(member.name)
        assert path.parts[0] == 'v8-150.4.0' and '..' not in path.parts
        assert member.isfile() or member.isdir()
        if member.isfile():
            data = tar.extractfile(member).read()
            assert (v8 / Path(*path.parts[1:])).read_bytes() == data, member.name
            published_files += 1
restored = []

def write_new(relative, data):
    path = v8 / relative
    assert path.resolve().is_relative_to(v8.resolve())
    if path.exists():
        assert path.read_bytes() == data, 'Refusing to change an existing source input'
        return
    assert not (original_v8 / relative).exists(), 'Input unexpectedly exists in global source cache'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as output:
        output.write(data)
    restored.append(dict(path=relative, sha256=sha(data), bytes=len(data)))

icu = inputs / 'icu-ee5f27adc28bd3f15b2c293f726d14d2e336cbd5/icudtl.dat'
icu_data = icu.read_bytes()
assert sha(icu_data) == '1cf67874b5a87a8363a86fb3f81e3cbbed54d389062dab8fb52308d5cf8c8612'
write_new('third_party/icu/common/icudtl.dat', icu_data)
for archive in archives:
    with tarfile.open(archive_root / (archive['crate'] + '.tar.gz'), 'r:gz') as tar:
        for member in tar:
            name = PurePosixPath(member.name)
            assert not name.is_absolute() and '..' not in name.parts
            assert member.isdir() or member.isfile(), 'Links/special files are outside this preparation'
            if member.isfile():
                data = tar.extractfile(member).read()
                write_new(rust_prefix + archive['crate'] + '/' + name.as_posix(), data)
for path in audit:
    assert (v8 / path).is_file() and not (original_v8 / path).exists(), path
assert (candidate / 'codex-rs/Cargo.lock').read_bytes() == lock_bytes
assert not run(['git', 'status', '--porcelain'], cwd=candidate)
record = dict(status='PREPARED_ISOLATED_PINNED_INPUTS', cargoHome=str(cache), registryArchivesCloned=registry_count,
              gitSources=git_records, rustRevision=rust_revision, archives=archives, restoredInputs=restored,
              originalV8PublishedFilesVerifiedAgainstLockedArchive=published_files, auditedMissingInputsRestored=len(audit),
              candidateSourceClean=True, candidateLockUnchanged=True, globalCargoCacheModified=False,
              cargoCredentialsCopied=False, unrelatedSourcesCopied=False)
with (args.evidence / 'companion-source-inputs-04-prepared.json').open('x') as output:
    json.dump(record, output, indent=2)
    output.write('\n')
print(json.dumps({k: record[k] for k in ['status', 'registryArchivesCloned', 'auditedMissingInputsRestored', 'globalCargoCacheModified']}), flush=True)
