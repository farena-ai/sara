// V3.1 My apps (docs/design/MY_APPS.md): her tools for keeping the small web apps she builds.
// app_keep stores a new app (static files only), app_edit makes a new version, app_undo goes back
// one version, app_read shows the files, app_list lists them. Everything stays in the person's own
// space; the person opens, shares or deletes apps on Library → My apps.
import type { AppContext } from '../chat.ts';
import { MyAppsError, myAppsFor, type AppFileInput, type AppView } from '../my-apps.ts';
import { ToolError, type Tool } from './types.ts';

const guard = async <T>(f: () => Promise<T> | T): Promise<T> => {
  try {
    return await f();
  } catch (err) {
    if (err instanceof MyAppsError) throw new ToolError(err.message);
    throw err;
  }
};
const filesOf = (v: unknown): AppFileInput[] =>
  Array.isArray(v) ? v.filter((f) => f && typeof f === 'object').map((f) => ({ path: String((f as AppFileInput).path ?? ''), content: String((f as AppFileInput).content ?? ''), base64: (f as AppFileInput).base64 === true })) : [];
const ref = (v: unknown): string | number => (typeof v === 'number' ? v : String(v ?? '').trim());
const where = (a: AppView) => `Open it on Library → My apps (address ${a.openPath} on this server; it runs sandboxed, without the Sara session).`;

const FILES_PARAM = {
  type: 'array',
  description: 'The files. Paths are relative (index.html, app.js, style.css, img/logo.png). Only pages, styles, scripts, pictures, fonts and data; no server code.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string', description: 'The text of the file (or base64 for pictures/fonts).' },
      base64: { type: 'boolean', description: 'True when content is base64.' },
    },
    required: ['path', 'content'],
  },
};
const HOW =
  'The app is static: it runs in the browser only, in a sandbox, and can save small JSON data with the helper every page gets: `await appData.get(name, fallback)`, `await appData.set(name, value)`, `appData.remove(name)`, `appData.keys()` (`appData.readOnly` is true on a share link). Names: letters, digits, . _ - . It cannot reach the internet, other sites or Sara.';

export function createMyAppsTools(getApp: () => AppContext): Tool[] {
  const apps = () => myAppsFor(getApp());
  return [
    {
      defaultPermission: 'auto',
      spec: {
        name: 'app_keep',
        description: `Keep a small web app you built for them (a tracker, calculator, list, game, page) so it stays on their own server with versions and Undo: Library → My apps. Needs an index.html. ${HOW}`,
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'A short name, e.g. "Plant waterer".' }, files: FILES_PARAM, note: { type: 'string', description: 'What this version is (optional).' } },
          required: ['name', 'files'],
        },
      },
      summarize: (a) => `Keep the app "${String(a.name ?? '')}"`,
      run: async (a) =>
        guard(() => {
          const kept = apps().keep({ name: a.name, files: filesOf(a.files), ...(typeof a.note === 'string' ? { note: a.note } : {}) });
          return `Kept "${kept.name}" (version 1). ${where(kept)} To change it later use app_edit; app_undo goes back a version.`;
        }),
    },
    {
      defaultPermission: 'auto',
      spec: {
        name: 'app_edit',
        description: `Change a kept app: a new version built on the one shown now (files you give are added or replaced, others stay; remove lists paths to delete). The person can Undo it. Read the files first with app_read. ${HOW}`,
        parameters: {
          type: 'object',
          properties: { app: { type: 'string', description: 'The app name or number.' }, files: FILES_PARAM, remove: { type: 'array', items: { type: 'string' } }, note: { type: 'string', description: 'What changed.' } },
          required: ['app'],
        },
      },
      summarize: (a) => `Change the app "${String(a.app ?? '')}"`,
      run: async (a) =>
        guard(() => {
          const v = apps().edit(ref(a.app), { files: filesOf(a.files), ...(Array.isArray(a.remove) ? { remove: a.remove.map(String) } : {}), ...(typeof a.note === 'string' ? { note: a.note } : {}) });
          return `"${v.name}" is now version ${v.version}. Undo: app_undo or Library → My apps. ${where(v)}`;
        }),
    },
    {
      defaultPermission: 'auto',
      spec: {
        name: 'app_undo',
        description: 'Undo the last change to a kept app: back to the version before the one shown now (its saved data stays).',
        parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
      },
      summarize: (a) => `Undo the last change to "${String(a.app ?? '')}"`,
      run: async (a) =>
        guard(() => {
          const v = apps().undo(ref(a.app));
          return `"${v.name}" is back to version ${v.version} (of ${v.versions} kept). Its saved data was not changed.`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: {
        name: 'app_read',
        description: 'Read a kept app: without path, its files and versions; with path, that file of the version shown now.',
        parameters: { type: 'object', properties: { app: { type: 'string' }, path: { type: 'string' } }, required: ['app'] },
      },
      summarize: (a) => `Read the app "${String(a.app ?? '')}"`,
      run: async (a) =>
        guard(() => {
          const s = apps();
          const v = s.get(ref(a.app));
          if (!v) throw new MyAppsError(`There is no app "${String(a.app)}". app_list shows the kept apps.`);
          const files = s.files(v.id);
          if (typeof a.path === 'string' && a.path.trim()) {
            const p = a.path.trim().replace(/^\.?\//, '');
            if (files[p] === undefined) throw new MyAppsError(`"${v.name}" has no file "${p}". Its files: ${Object.keys(files).join(', ')}.`);
            return files[p].slice(0, 60_000);
          }
          const vs = s.versions(v.id).slice(0, 10).map((x) => `- version ${x.n}${x.current ? ' (shown)' : ''}: ${x.note} (${x.at.slice(0, 10)})`);
          return `"${v.name}", version ${v.version} of ${v.versions}. Files: ${Object.keys(files).join(', ')}.\nSaved data names: ${s.dataKeys(v.id).join(', ') || 'none'}.\nVersions:\n${vs.join('\n')}`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'app_list', description: 'List the apps kept on Library → My apps.', parameters: { type: 'object', properties: {} } },
      summarize: () => 'My apps',
      run: async () =>
        guard(() => {
          const list = apps().list();
          if (!list.length) return 'No apps kept yet. Build one and keep it with app_keep.';
          return list.map((x) => `#${x.id} ${x.name}: version ${x.version} of ${x.versions}${x.sharePath ? ', shared by link' : ''}${x.dataKeys ? `, ${x.dataKeys} saved data names` : ''}`).join('\n');
        }),
    },
  ];
}
