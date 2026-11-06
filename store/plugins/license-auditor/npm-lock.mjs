// npm package-lock v2/v3 installed-package inventory, not an npm resolver or executable installer.
export function inventory(text) {
  if(typeof text!=='string'||text.length>65536||Buffer.byteLength(text)>65536) throw new Error('input');
  let lock; try { lock=JSON.parse(text); } catch { throw new Error('input'); }
  if(!lock||![2,3].includes(lock.lockfileVersion)||!lock.packages||Array.isArray(lock.packages)||typeof lock.packages!=='object') throw new Error('input');
  const nameRe=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const versionRe=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  function identity(name,version) { if(typeof name!=='string'||name.length>128||!nameRe.test(name)||typeof version!=='string'||version.length>80||!versionRe.test(version)) throw new Error('input'); return {name,version}; }
  const root=lock.packages['']; if(!root||root.link) throw new Error('input');
  const project=identity(root.name??lock.name,root.version??lock.version);
  const paths=Object.keys(lock.packages).filter(p=>p!=='').sort(); if(paths.length>60) throw new Error('limit');
  const packages=paths.map(path=>{
    if(path.length>240||! /^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/.test(path)) throw new Error('input');
    const p=lock.packages[path]; if(!p||typeof p!=='object'||p.link) throw new Error('input');
    const derived=path.slice(path.lastIndexOf('node_modules/')+13);
    return {path,...identity(p.name??derived,p.version),license:typeof p.license==='string'?p.license:undefined,integrity:p.integrity};
  });
  return {project,packages,lockfileVersion:lock.lockfileVersion};
}
