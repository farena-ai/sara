import type { Buffer } from 'node:buffer';
export interface SnapshotFile { path: string; bytes: number; sha256: string }
export interface MapOptions { depth?: number; maxFiles?: number }
export interface MapResult { complete: true; scope: 'staged-server-home-only'; buildExecuted: false; snapshotSha256: string; totalBytes: number; files: SnapshotFile[] }
export const MAP_LIMITS: Readonly<{ files: number; depth: number; fileBytes: number; bytes: number }>;
export function mapOptions(options: unknown): Required<MapOptions>;
export function stageSnapshot(source: string, home: string): Promise<{version: 1; files: SnapshotFile[]}>;
export function repoMap(home: string, options?: MapOptions, signal?: AbortSignal): Promise<MapResult>;
export function loadSnapshot(home: string, options?: MapOptions, signal?: AbortSignal): Promise<{files: (SnapshotFile & {data: Buffer})[]; total: number; snapshotSha256: string}>;
export function snapshotDocument(home: string, path: string, signal?: AbortSignal): Promise<{document: unknown; evidence:{file:string;sha256:string;snapshotSha256:string}}>;
