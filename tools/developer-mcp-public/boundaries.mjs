// Qualification caller restrictions, NOT a Sara authorization system or OS/network fence.
const object=(x)=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,wanted)=>{if(!object(x)||Object.keys(x).sort().join('|')!==[...wanted].sort().join('|'))throw Error('Unreviewed argument shape');};
export function validateTerraform(name,args,knownIds){
 if(name==='search_provider_docs'){
  keys(args,['provider_namespace','provider_name','provider_version','service_slug','provider_document_type']);
  if(args.provider_namespace!=='hashicorp'||args.provider_name!=='random'||args.provider_version!=='3.7.2'||args.service_slug!=='string'||args.provider_document_type!=='resources')throw Error('Outside fixed public registry namespace/version');
 }else if(name==='get_provider_details'){
  keys(args,['provider_doc_id']);if(!/^\d{1,12}$/.test(args.provider_doc_id)||!knownIds.has(args.provider_doc_id))throw Error('Document ID was not discovered in this public search');
 }else throw Error('Unreviewed Terraform tool');
}
export function validateStorybook(name,args,knownStories,component){
 if(name==='stories-preview'){
  keys(args,['stories']);if(!Array.isArray(args.stories)||args.stories.length<1||args.stories.length>2)throw Error('Bounded stories required');
  for(const story of args.stories){keys(story,['storyId']);if(!knownStories.has(story.storyId))throw Error('Outside owned story namespace');}
 }else if(name==='stories-find-by-component'){
  keys(args,['componentPaths']);if(!Array.isArray(args.componentPaths)||args.componentPaths.length!==1||args.componentPaths[0]!==component)throw Error('Outside owned component path');
 }else throw Error('Unreviewed Storybook tool');
}
export function validatePreviewUrl(value,port,knownStories){
 const url=new URL(value);if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.port!==String(port)||url.username||url.password||url.hash||url.pathname!=='/'||[...url.searchParams.keys()].join('|')!=='path')throw Error('Outside owned preview endpoint');
 const path=url.searchParams.get('path');if(!path?.startsWith('/story/')||!knownStories.has(path.slice(7)))throw Error('Outside selected story');return url;
}
