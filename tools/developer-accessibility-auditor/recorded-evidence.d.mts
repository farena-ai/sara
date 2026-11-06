export function sha256(bytes: Uint8Array|string): string;
export function recordedEvidence(privateBytes: Uint8Array|string): {schemaVersion:number;kind:string;freshCapture:boolean;provenance:{sourceEvidenceSha256:string;captureSourceSha256:string;projectionSourceSha256:string};evidence:any};
