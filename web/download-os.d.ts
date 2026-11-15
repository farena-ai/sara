export type Os = 'windows' | 'mac' | 'linux' | 'android' | 'iphone';
export const OSES: Os[];
export const PLAY_STORE: string;
export const RELEASES_PAGE: string;
export const LINUX_COMMAND: string;
export interface ReleaseFile {
  name: string;
  url: string;
  size: number;
}
export interface ReleaseAssetMap {
  version: string;
  page: string;
  windows: ReleaseFile | null;
  mac: ReleaseFile | null;
  android: ReleaseFile | null;
  linux: ReleaseFile | null;
  source: ReleaseFile | null;
}
export function detectOs(ua: string | undefined, maxTouchPoints?: number): Os;
export function releaseAssets(release: unknown): ReleaseAssetMap;
export function primaryLink(os: Os, assets: ReleaseAssetMap | undefined): string;
