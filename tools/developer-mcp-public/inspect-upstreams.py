"""Bounded public GET/source inspection; never installs or executes upstream."""
from pathlib import Path
import urllib.request,json,hashlib,tarfile,io,concurrent.futures,base64
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'outputs/developer-addons/mcp-public'
OUT.mkdir(parents=True,exist_ok=True)
def fetch(name,url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Sara-public-qualification'}),timeout=60) as r:
            data=r.read(35_000_001)
        if len(data)>35_000_000: raise ValueError('source cap')
        (OUT/name).write_bytes(data)
        return {'file':name,'url':url,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
    except Exception as e:
        return {'file':name,'url':url,'error':str(e)}
if __name__=='__main__':
    urls=[('terraform-index.json','https://releases.hashicorp.com/terraform-mcp-server/1.4.1/index.json'),('terraform-readme.md','https://raw.githubusercontent.com/hashicorp/terraform-mcp-server/3781509a674482ca7e2821fab8159a25e3b29bdf/README.md'),('terraform-source.tar.gz','https://api.github.com/repos/hashicorp/terraform-mcp-server/tarball/3781509a674482ca7e2821fab8159a25e3b29bdf')]
    metadata=[]
    for key,package in [('storybook-core','storybook'),('storybook-addon','@storybook/addon-mcp'),('storybook-framework','@storybook/html-vite')]:
        receipt=fetch(key+'.json','https://registry.npmjs.org/'+package+'/10.6.6');assert 'error' not in receipt,receipt;metadata.append(receipt)
    for key in ['storybook-core','storybook-addon','storybook-framework']:
        m=json.loads((OUT/(key+'.json')).read_text()); urls.append((key+'.tgz',m['dist']['tarball']))
    receipts=list(concurrent.futures.ThreadPoolExecutor(5).map(lambda x:fetch(*x),urls))
    assert all('error' not in receipt for receipt in receipts),receipts
    for key in ['storybook-core','storybook-addon','storybook-framework']:
        data=(OUT/(key+'.tgz')).read_bytes();m=json.loads((OUT/(key+'.json')).read_text());assert 'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()==m['dist']['integrity']
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as t:
            for f in t.getmembers():
                if f.isfile() and '..' not in Path(f.name).parts and not Path(f.name).is_absolute() and f.name.endswith(('.js','.cjs','.json','LICENSE','LICENSE.md')):
                    target=OUT/'inspection'/key/f.name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(t.extractfile(f).read())
    with tarfile.open(OUT/'terraform-source.tar.gz') as archive:
        for member in archive.getmembers():
            parts=Path(member.name).parts[1:]
            if member.isfile() and '..' not in parts and member.name.endswith(('.go','go.mod','go.sum','LICENSE')):
                target=OUT/'inspection/terraform'/Path(*parts);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.extractfile(member).read())
    index=json.loads((OUT/'terraform-index.json').read_text());build=next(x for x in index['builds'] if x['os']=='windows' and x['arch']=='amd64')
    base='https://releases.hashicorp.com/terraform-mcp-server/1.4.1/'
    receipts.extend([fetch('terraform-SHA256SUMS',base+index['shasums']),fetch(build['filename'],build['url'])])
    data=(OUT/build['filename']).read_bytes();digest=hashlib.sha256(data).hexdigest()
    assert any(line.split()==[digest,build['filename']] for line in (OUT/'terraform-SHA256SUMS').read_text().splitlines())
    pins=json.loads((ROOT/'tools/developer-mcp-public/pins.json').read_text());assert digest==pins['terraform']['archiveSha256']
    import zipfile
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name in ['terraform-mcp-server.exe','LICENSE.txt']:
            target=OUT/'terraform-bin'/name;target.parent.mkdir(exist_ok=True);target.write_bytes(archive.read(name))
    assert hashlib.sha256((OUT/'terraform-bin/terraform-mcp-server.exe').read_bytes()).hexdigest()==pins['terraform']['binarySha256']
    (OUT/'source-fetches.json').write_text(json.dumps(metadata+receipts,indent=2))
    print(json.dumps(metadata+receipts,indent=2))
