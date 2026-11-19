// D3 Live canvas in chat (docs/design/LIVE_CANVAS.md): her tools for small live views in a chat.
// canvas_post puts a checklist, table, chart or small page in this chat (a `canvas` card); it stays
// current with its source (her own data, Planner to-dos, a kept My app's data). canvas_update
// changes one she posted; canvas_list lists them. Views run sandboxed, without the Sara session.
import type { AppContext } from '../chat.ts';
import { CanvasError, canvasFor, type CanvasPost, type CanvasView } from '../canvas.ts';
import { ToolError, type Tool } from './types.ts';

const guard = async <T>(f: () => Promise<T> | T): Promise<T> => {
  try {
    return await f();
  } catch (err) {
    if (err instanceof CanvasError) throw new ToolError(err.message);
    throw err;
  }
};
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const from = (v: CanvasView): string =>
  v.source.type === 'tasks' ? `the Planner to-dos${v.source.project ? ` in "${v.source.project}"` : ''}` : v.source.type === 'app' ? `the app "${v.source.app}" (its "${v.source.key}" data)` : 'its own data';

const ITEMS = { type: 'array', description: 'Checklist rows: text, or {text, done}.', items: {} };
const ROWS = { type: 'array', description: 'Table rows: arrays of cells or objects (keys become columns). For a chart: {label, value} rows.', items: {} };
const SOURCE = {
  type: 'object',
  description: 'Where its data lives (default own). own: the data you give here (canvas_update changes it; they can tick checklist rows). tasks: Planner to-dos (optional project); ticking a row completes the task. app: one data name of a kept My app (app = its name, key = the data name); it shows what the app saves.',
  properties: { type: { type: 'string', enum: ['own', 'tasks', 'app'] }, project: { type: 'string' }, app: { type: 'string' }, key: { type: 'string' } },
};

export function createCanvasTools(getApp: () => AppContext): Tool[] {
  const store = () => canvasFor(getApp());
  return [
    {
      defaultPermission: 'auto',
      spec: {
        name: 'canvas_post',
        description:
          'Post a small live view in this chat: a checklist they can tick, a table, a bar or line chart, or a small html page you write. It stays current by itself with its source, so use it for things that change (a packing list, this week\'s to-dos, numbers a kept app saves). It runs sandboxed in the chat, without the Sara session; an html page is static, can\'t reach the internet and gets `saraCanvas.onData(fn)` (the data, again whenever it changes) and `await saraCanvas.save(data)` (own source only).',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['checklist', 'table', 'chart', 'html'] },
            title: { type: 'string', description: 'A short title, e.g. "Packing for Lisbon".' },
            items: ITEMS,
            columns: { type: 'array', items: { type: 'string' }, description: 'Table columns (optional when rows are objects).' },
            rows: ROWS,
            chart: { type: 'object', description: 'For a chart from an app\'s rows: which field is the label and which the value; type bar or line.', properties: { label: { type: 'string' }, value: { type: 'string' }, type: { type: 'string', enum: ['bar', 'line'] } } },
            html: { type: 'string', description: 'For kind html: the whole page (static, up to 200 KB).' },
            data: { description: 'For kind html with its own data: the starting data (any JSON).' },
            source: SOURCE,
          },
          required: ['kind', 'title'],
        },
      },
      summarize: (a) => `Post the live view "${String(a.title ?? '')}"`,
      run: async (a, ctx) =>
        guard(() => {
          const v = store().post({
            kind: String(a.kind ?? '') as CanvasPost['kind'],
            title: a.title,
            items: arr(a.items),
            columns: arr(a.columns),
            rows: arr(a.rows),
            bars: arr(a.bars),
            ...(a.chart && typeof a.chart === 'object' ? { chart: a.chart as CanvasPost['chart'] } : {}),
            html: a.html,
            data: a.data,
            ...(a.source && typeof a.source === 'object' ? { source: a.source as CanvasPost['source'] } : {}),
            conversationId: ctx?.conversationId ?? null,
          });
          return `Posted the live ${v.kind} "${v.title}" in this chat (live view #${v.id}). It updates by itself from ${from(v)}. Change it with canvas_update (canvas ${v.id}).`;
        }),
    },
    {
      defaultPermission: 'auto',
      spec: {
        name: 'canvas_update',
        description: 'Change a live view you posted (by number or title): a new title; checklist rows to add, check, uncheck or remove (by text); new table rows or chart bars; an html view\'s page or data. Views over Planner to-dos or an app follow their source: change the tasks or the app instead.',
        parameters: {
          type: 'object',
          properties: {
            canvas: { type: 'string', description: 'The live view number or title.' },
            title: { type: 'string' },
            items: { ...ITEMS, description: 'Replace all checklist rows.' },
            add: { ...ITEMS, description: 'Checklist rows to add.' },
            check: { type: 'array', items: { type: 'string' } },
            uncheck: { type: 'array', items: { type: 'string' } },
            remove: { type: 'array', items: { type: 'string' } },
            columns: { type: 'array', items: { type: 'string' } },
            rows: ROWS,
            html: { type: 'string' },
            data: {},
          },
          required: ['canvas'],
        },
      },
      summarize: (a) => `Change the live view "${String(a.canvas ?? '')}"`,
      run: async (a) =>
        guard(() => {
          const v = store().update(a.canvas, {
            ...(a.title !== undefined ? { title: a.title } : {}),
            ...(arr(a.items) ? { items: arr(a.items) } : {}),
            ...(arr(a.add) ? { add: arr(a.add) } : {}),
            ...(arr(a.check) ? { check: arr(a.check) } : {}),
            ...(arr(a.uncheck) ? { uncheck: arr(a.uncheck) } : {}),
            ...(arr(a.remove) ? { remove: arr(a.remove) } : {}),
            ...(arr(a.columns) ? { columns: arr(a.columns) } : {}),
            ...(arr(a.rows) ? { rows: arr(a.rows) } : {}),
            ...(arr(a.bars) ? { bars: arr(a.bars) } : {}),
            ...(a.html !== undefined ? { html: a.html } : {}),
            ...(a.data !== undefined ? { data: a.data } : {}),
          });
          return `Changed the live ${v.kind} "${v.title}" (live view #${v.id}); it is updated in the chat within a few seconds.`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'canvas_list', description: 'List the live views posted in chats (number, kind, title, where the data comes from).', parameters: { type: 'object', properties: {} } },
      summarize: () => 'Live views',
      run: async () =>
        guard(() => {
          const list = store().list();
          if (!list.length) return 'No live views yet. Post one with canvas_post.';
          return list.map((v) => `#${v.id} ${v.kind} "${v.title}": from ${from(v)}, changed ${v.updatedAt.slice(0, 10)}`).join('\n');
        }),
    },
  ];
}
