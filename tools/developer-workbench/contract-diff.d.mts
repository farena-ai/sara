export interface Finding { code: string; severity: 'breaking' | 'compatible'; before: string; after: string }
export interface ContractResult { compatible: boolean; complete: true; findings: Finding[] }
export function compareContracts(before: unknown, after: unknown): ContractResult;
