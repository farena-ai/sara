// 3.5.2: the companion's face for the desktop apps' icons (window, taskbar, tray, notifications,
// Start-menu shortcut; docs/desktop.md → Her face as the app's icon). /api/session says which
// picture it is and a tag that changes when it changes; the app's quick-ask page draws it (with the
// sign-in) and hands the PNG to the app. 'builtin' = Sara with her own default look: the app keeps
// its built-in icon.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AVATAR_TYPES } from './http.ts';

export type AppFaceKind = 'builtin' | 'look' | 'custom' | 'initial';
export interface AppFace {
  kind: AppFaceKind;
  /** Where the page loads it (same origin, signed in). */
  src: string;
  /** Changes whenever the picture does (a new look, an uploaded picture, a rename). */
  tag: string;
}

interface FaceSource {
  dataDir: string;
  companionId?: string;
  persona: { name: string };
  look?: { custom: boolean; fileOrDefault(rel: string): string | undefined };
}

const stamp = (f: string): string => {
  try {
    const s = statSync(f);
    return `${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}`;
  } catch {
    return '0';
  }
};

/** The owner's own uploaded picture for her (data dir), if any. */
export function uploadedAvatar(dataDir: string): string | undefined {
  for (const ext of Object.keys(AVATAR_TYPES)) {
    const f = join(dataDir, `avatar.${ext}`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

/** Which face the apps show for this companion now (the same picture the page's header shows). */
export function appFaceOf(app: FaceSource): AppFace {
  const uploaded = uploadedAvatar(app.dataDir);
  if (uploaded) return { kind: 'custom', src: '/api/sara/avatar', tag: `c${stamp(uploaded)}` };
  // A custom look, or the he/they default look that matches the pronouns (or was picked).
  const look = app.look?.fileOrDefault('sara-avatar.jpg');
  if (look) return { kind: 'look', src: '/sara-avatar.jpg', tag: `l${app.look?.custom ? 'c' : ''}${stamp(look)}` };
  // Another companion without a look of her own: her initial (src/server.ts serves it there).
  if (app.companionId && app.companionId !== 'main' && !app.look?.custom) return { kind: 'initial', src: '/sara-avatar.jpg', tag: `i${encodeURIComponent(app.persona.name).slice(0, 60)}` };
  return { kind: 'builtin', src: '/sara-avatar.jpg', tag: 'b' };
}
