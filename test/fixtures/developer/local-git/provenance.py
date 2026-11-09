"""Offline byte provenance and deterministic evidence bundle; run in locked venv."""
import hashlib
from importlib import metadata
import json
from pathlib import Path
import platform
import sys
import tarfile
import zipfile

root = Path(__file__).resolve().parents[4]
out = root / 'outputs/developer-addons/local-git'
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
archive = out / 'upstream.tar.gz'
assert digest(archive) == '23a1ecc621f2a8aa8f235ce2c42d8dec345f9e0da18033b2c97d13e72a7c25db'
source = metadata.distribution('mcp-server-git')
with tarfile.open(archive) as tar:
    stream = tar.extractfile('mcp_server_git-2026.11.4/src/mcp_server_git/server.py')
    assert stream is not None
    member = stream.read()
installed = Path(str(source.locate_file('mcp_server_git/server.py')))
assert installed.read_bytes() == member
receipt = json.loads((out / 'host-receipt.json').read_text())
files = ['src/tools/mcp.ts','src/tools/registry.ts','src/settings.ts','test/fixtures/developer/local-git/recipe-preview.json','test/developer-local-git.test.ts','test/fixtures/developer/local-git/launch.py','test/fixtures/developer/local-git/provenance.py','test/fixtures/developer/local-git/tools.json']
manifest = {
    'python': sys.version, 'platform': platform.platform(),
    'runtimeArtifacts': {str(p): digest(p) for p in [Path(sys.executable), Path(getattr(sys, '_base_executable', sys.executable)), Path('C:/Program Files/nodejs/node.exe'), Path('C:/Program Files/Git/cmd/git.exe')]},
    'upstreamArchiveSha256': digest(archive), 'installedServerSha256': digest(installed),
    'dependencyLockSha256': digest(out / 'requirements.lock'),
    'dependencies': sorted([{'name': d.metadata['Name'], 'version': d.version} for d in metadata.distributions()], key=lambda x:x['name'].lower()),
    'schemaSha256': hashlib.sha256(json.dumps(receipt['schemas'],sort_keys=True,separators=(',',':')).encode()).hexdigest(),
    'files': {p:digest(root / p) for p in files},
    'status': 'unpublished-preview; Windows direct registered fixture only; account none'
}
(out / 'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n')
with zipfile.ZipFile(out / 'local-git-qualification-preview.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
    for p in files[3:] + ['docs/ops/DEVELOPER_LOCAL_GIT_QUALIFICATION.md']:
        z.write(root / p,p)
    for p in ['requirements.lock','host-receipt.json','policy-before-features.json','provenance.json','upstream.tar.gz']:
        z.write(out / p,'evidence/'+p)
print(json.dumps(manifest,indent=2))
print('bundle SHA256',digest(out / 'local-git-qualification-preview.zip'))
