# SPDX-License-Identifier: MIT
"""Operator-only seeding of the bundled deterministic synthetic fixture, never an MCP tool."""
import json,sys,hashlib,runpy
from pathlib import Path
home=Path(sys.argv[1])
assert home.is_absolute() and home.is_dir() and not any(home.iterdir()),'fresh dedicated home required'
api=runpy.run_path(str(Path(__file__).with_name('server.py')))
assert home.name.startswith('mcp-qdrant-') and '..' not in home.parts,'dedicated home required'
for p in [*reversed(home.parents),home]:api['checked'](p)
api['isolate'](home)
from qdrant_client.local.qdrant_local import QdrantLocal
from qdrant_client import models
source=Path(__file__).resolve().parents[2]/'test/fixtures/developer/mcp-qdrant/vectors.json'
data=json.loads(source.read_text())
store=home/'store'
client=QdrantLocal(str(store))
try:
    client.create_collection(data['collection'],vectors_config=models.VectorParams(size=data['dimension'],distance=models.Distance.COSINE))
    client.upsert(data['collection'],[models.PointStruct(**p) for p in data['points']])
finally:client.close()
files={p.relative_to(store).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in store.rglob('*') if p.is_file()}
manifest={'version':1,'collection':data['collection'],'dimension':data['dimension'],'points':len(data['points']),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'files':files}
seal=home/'fixture-seal.json';seal.write_text(json.dumps(manifest,sort_keys=True))
print(json.dumps({'seal':hashlib.sha256(seal.read_bytes()).hexdigest(),'engine':'qdrant_client.local.qdrant_local.QdrantLocal'}))
