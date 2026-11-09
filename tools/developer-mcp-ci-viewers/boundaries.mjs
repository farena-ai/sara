// Fixture-only review boundary; not a Sara authorization extension or install recipe.
export function validateBuildRead(raw,args){
 if(raw!=='get_build')throw Error('Tool not reviewed');
 const expected={org_slug:'synthetic-owned',pipeline_slug:'historical-viewer',build_number:'42'};
 if(!args||Object.keys(args).sort().join(',')!==Object.keys(expected).sort().join(',')||Object.entries(expected).some(([k,v])=>args[k]!==v))throw Error('Only exact owned historical result admitted');
 return {...args};
}
