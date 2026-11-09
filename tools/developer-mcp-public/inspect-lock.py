"""Inspect every locked archive before script-free local installation."""
from pathlib import Path
import json,urllib.request,tarfile,io,hashlib,base64,concurrent.futures
ROOT=Path(__file__).resolve().parents[2]; OUT=ROOT/'outputs/developer-addons/mcp-public'; LOCK=ROOT/'tools/developer-mcp-public/package-lock.json'
def inspect(item):
    name,meta=item
    url=meta['resolved'];assert url.startswith('https://registry.npmjs.org/')
    with urllib.request.urlopen(url,timeout=60) as r: b=r.read(35_000_001)
    assert len(b)<=35_000_000
    alg,digest=meta['integrity'].split('-',1);assert alg=='sha512' and base64.b64encode(hashlib.sha512(b).digest()).decode()==digest
    t=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz');files=[f for f in t.getmembers() if f.isfile()];members=sorted((f for f in files if Path(f.name).name=='package.json'),key=lambda f:len(Path(f.name).parts));assert members, name
    stream=t.extractfile(members[0]);assert stream is not None;pm=json.loads(stream.read())
    assert pm['version']==meta['version'], name
    licenses=[f for f in files if Path(f.name).name.lower().startswith(('license','copying'))]
    evidence={'path':name,'version':pm['version'],'integrity':meta['integrity'],'sha256':hashlib.sha256(b).hexdigest(),'license':pm.get('license'),'engines':pm.get('engines'),'scripts':pm.get('scripts',{}),'licenseMembers':{f.name:hashlib.sha256(t.extractfile(f).read()).hexdigest() for f in licenses},'bytes':len(b)}
    target=OUT/'dependency-inspection'/name.replace('node_modules/','').replace('/','__');target.mkdir(parents=True,exist_ok=True)
    (target/'package.json').write_text(json.dumps(pm,indent=2))
    for i,f in enumerate(licenses): (target/('LICENSE-'+str(i)+'.txt')).write_bytes(t.extractfile(f).read())
    return evidence
if __name__=='__main__':
    lock=json.loads(LOCK.read_text());items=[x for x in lock['packages'].items() if x[0]]
    records=list(concurrent.futures.ThreadPoolExecutor(8).map(inspect,items))
    result={'lockSha256':hashlib.sha256(LOCK.read_bytes()).hexdigest(),'records':records,'count':len(records),'bytes':sum(x['bytes'] for x in records),'missingLicense':[x['path'] for x in records if not x['license']]}
    (OUT/'dependency-inspection.json').write_text(json.dumps(result,indent=2)); print(json.dumps({k:v for k,v in result.items() if k!='records'},indent=2))
