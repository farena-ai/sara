export interface ComparisonPair { index:number; viewport:'desktop'|'phone'; width:number; height:number; status:'changed'|'unchanged'; changedPixels:number; totalPixels:number; baselineSha256:string; candidateSha256:string; rect:{x:number;y:number;width:number;height:number}|null }
export function compare(input:unknown):{version:1;method:'exact-rgba8';pairs:ComparisonPair[]};
export function crc32(bytes:Uint8Array):number;
