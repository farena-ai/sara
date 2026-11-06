export function startFixtureApi(directory:string):Promise<{url:string;requests:Array<{method:string;path:string;allowed:boolean}>;close:()=>Promise<void>}>;
