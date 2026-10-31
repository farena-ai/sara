// Phase 49: previews of the web apps she builds and a real browser to test them.
// preview_start / preview_stop: a link to an app one of her background jobs runs (src/preview.ts).
// browser_*: open a preview (or, with web access, a public page), click, type, read, check and
// take screenshots she can see; screenshots also go on her message as proof for the owner.
// There is deliberately no "run this JavaScript" tool: checks are fixed, script-free assertions.
import { createServer } from 'node:net';
import type { AppContext } from '../chat.ts';
import { browserAddress, CHECK_TYPES, type Check, VIEWPORTS, type Viewport } from '../browser.ts';
import { PreviewError, previewUrl } from '../preview.ts';
import { str, ToolError, type Tool, type ToolContext } from './types.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

function convOf(app: AppContext, ctx: ToolContext) {
  const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
  if (!conv) throw new ToolError('No conversation for this.');
  return conv;
}

/** desktop | phone | a width in px (320–1920). */
export function viewportFor(v: unknown): Viewport {
  if (v === undefined || v === null || v === '' || v === 'desktop') return { ...VIEWPORTS.desktop };
  if (v === 'phone' || v === 'mobile') return { ...VIEWPORTS.phone };
  const n = Number(String(v).replace(/px$/i, ''));
  if (!Number.isFinite(n) || n < 320 || n > 1920) throw new ToolError('width: "desktop", "phone", or a number of pixels from 320 to 1920.');
  const w = Math.round(n);
  return w < 700 ? { width: w, height: 844, mobile: true } : { width: w, height: 800, mobile: false };
}

/** A port nothing on this computer listens on right now (nice-looking ones first), for hints. */
export async function freePort(candidates = [5173, 8137, 8765, 4173, 3000, 8080, 8000]): Promise<number | undefined> {
  const tryPort = (port: number) =>
    new Promise<number | undefined>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(undefined));
      srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        const got = (srv.address() as { port: number } | null)?.port;
        srv.close(() => resolve(got));
      });
    });
  for (const p of candidates) {
    const ok = await tryPort(p);
    if (ok) return ok;
  }
  return tryPort(0);
}

const errorsLine = (errors: string[]) => (errors.length ? `\nPage problems so far: ${errors.slice(0, 6).join(' | ')}${errors.length > 6 ? ` (+${errors.length - 6} more)` : ''}` : '');

export function createBrowserTools(app: AppContext): Tool[] {
  const previewsOn = () => Boolean(app.previews && app.jobs);
  const browserOn = () => Boolean(app.browsers && app.previews && app.browsers.status().found);
  const session = async (ctx: ToolContext) => {
    if (!app.browsers) throw new ToolError('The testing browser is not available here.');
    try {
      return await app.browsers.session(convOf(app, ctx).id, ctx.webAllowed === true);
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
  };
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError((err as Error).message);
    }
  };

  const previewStart: Tool = {
    defaultPermission: 'auto',
    // Without a sandbox (Windows) this asks first, like her other command tools.
    runsCommands: true,
    spec: {
      name: 'preview_start',
      description:
        "Show a web app you're running to the owner: gives a private preview link through Sara that opens in a pane beside the chat. First start the app as a background job (start_job) listening on 127.0.0.1 and a port (e.g. `npx vite --host 127.0.0.1 --port 5173 --base ./` or `python3 -m http.server 8000 --bind 127.0.0.1`). The app is served under a sub-path, so use relative asset paths. Hot reload is off: reload the preview after changes. When the owner's computer is connected for computer use, pc_browser_open with app_port is better for debugging: a real address with storage, hot reload and their view.",
      parameters: obj({ port: { type: 'integer', description: 'The port the app listens on (left out: found in your jobs\u2019 output)' }, path: { type: 'string', description: 'Page to open first, e.g. "/" or "/about.html"' } }),
    },
    isAvailable: previewsOn,
    summarize: (a) => `preview the app on port ${a.port ?? '(from the job)'}${a.path ? ` at ${String(a.path)}` : ''}`,
    async run(args, ctx) {
      const conv = convOf(app, ctx);
      const port = args.port === undefined || args.port === null || args.port === '' ? undefined : Number(args.port);
      try {
        const p = await app.previews!.start({ conversationId: conv.id, workspace: conv.workspace, ...(port !== undefined ? { port } : {}), path: str(args, 'path', false) || '/', jobs: app.jobs });
        const url = previewUrl(p);
        app.events?.publish({ type: 'preview', conversationId: conv.id, preview: { url, port: p.port, workspace: p.workspace, jobId: p.jobId } });
        return `Preview ready: ${url}\nThe owner sees a Preview card in the chat that opens it beside the chat. It shows the app from background job #${p.jobId} on port ${p.port} and stays open while that job runs (up to 12 hours). Test it yourself with browser_open("${url}").`;
      } catch (err) {
        if (err instanceof PreviewError) {
          // H2: point at a port that is free right now, so she doesn't fight a busy one.
          const free = /isn't|is opened|Nothing is running|couldn't find a port/.test(err.message) ? await freePort().catch(() => undefined) : undefined;
          throw new ToolError(free ? `${err.message} A port that is free right now: ${free}.` : err.message);
        }
        throw err;
      }
    },
  };

  const previewStop: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'preview_stop', description: 'Close preview links in this workspace (one port, or all). The app itself keeps running; stop its job with stop_job.', parameters: obj({ port: { type: 'integer' } }) },
    isAvailable: previewsOn,
    summarize: (a) => `close the preview${a.port ? ` of port ${String(a.port)}` : 's'}`,
    async run(args, ctx) {
      const conv = convOf(app, ctx);
      const n = app.previews!.stopWhere(conv.workspace, args.port === undefined || args.port === null || args.port === '' ? undefined : Number(args.port));
      if (n) app.events?.publish({ type: 'preview', conversationId: conv.id, preview: null });
      return n ? `Closed ${n} preview link${n === 1 ? '' : 's'}.` : 'No preview was open here.';
    },
  };

  const open: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'browser_open',
      description: 'Open a page in your testing browser (a real headless browser): a preview link from preview_start, or a public web address when web access is allowed. Returns the title and any page errors. Then use browser_read, browser_click, browser_type, browser_check and browser_screenshot.',
      parameters: obj({ url: { type: 'string', description: 'A preview link (/preview/…) or https://…' } }, ['url']),
    },
    isAvailable: browserOn,
    summarize: (a) => `open ${String(a.url ?? '').replace(/\/preview\/([0-9a-f]{6})[0-9a-f]{26}/, '/preview/$1…').slice(0, 120)} in the testing browser`,
    async run(args, ctx) {
      const conv = convOf(app, ctx);
      const target = browserAddress(str(args, 'url'));
      if (!target) throw new ToolError('Give a preview link (/preview/…) or an http(s) address.');
      if (target.kind === 'preview') {
        const p = app.previews!.get(target.token);
        if (!p || p.workspace !== conv.workspace) throw new ToolError('That preview link has ended (or belongs to another workspace). Start one with preview_start.');
      } else if (!ctx.webAllowed) throw new ToolError("Web access is off here (private conversation, or web tools are switched off), so the testing browser only opens your app's preview links.");
      const s = await session(ctx);
      const r = await wrap(() => s.open(target.address));
      if (r.error) throw new ToolError(`The page didn't open: ${r.error}${s.guard.refused.length ? ` (blocked: ${s.guard.refused.slice(-3).join(', ')})` : ''}`);
      const shown = r.url.replace(/^http:\/\/sara-preview\.test/, '');
      return `Opened ${shown}${r.status ? ` (HTTP ${r.status})` : ''}. Title: ${r.title || '(none)'}. Window: ${s.viewport.width}×${s.viewport.height}.${errorsLine(s.errors)}`;
    },
  };

  const screenshot: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'browser_screenshot',
      description: "Take a screenshot of the page in your testing browser at desktop or phone width (or a width in pixels). You see the picture (if your model can see images), and it's attached to your reply so the owner sees it too. Use it to check layout: cut-off buttons, overflow on phones, broken styles.",
      parameters: obj({ width: { type: 'string', description: '"desktop" (1280), "phone" (390) or pixels, e.g. "768"' }, full_page: { type: 'boolean', description: 'The whole page, not just the window' } }),
    },
    isAvailable: browserOn,
    summarize: (a) => `screenshot at ${String(a.width ?? 'desktop')} width${a.full_page ? ' (whole page)' : ''}`,
    async run(args, ctx) {
      if (!app.uploads) throw new ToolError('Screenshots are not saved in this conversation (off the record).');
      if (!app.browsers?.has(convOf(app, ctx).id)) throw new ToolError('Open a page first with browser_open.');
      const v = viewportFor(args.width);
      const s = await session(ctx);
      const shot = await wrap(() => s.screenshot(v, args.full_page === true));
      const up = app.uploads.save(`data:${shot.mime};base64,${shot.data}`);
      ctx.attachProof?.(up.id);
      const what = `Screenshot at ${v.mobile ? 'phone' : 'desktop'} width (${shot.width}×${shot.height}).`;
      if (ctx.canSee !== false && ctx.showModel) {
        ctx.showModel(up.id);
        return `${what} It's attached below for you to look at, and on your reply for the owner.${errorsLine(s.errors)}`;
      }
      const described = await ctx.describeImage?.({ mime: shot.mime, data: shot.data }).catch(() => undefined);
      if (described) return `${what} Your model can't see pictures, so the picture model described it:\n${described}\nIt's attached to your reply for the owner.${errorsLine(s.errors)}`;
      return `${what} Your model can't see pictures and no picture model is set (Settings → Which model does what → Vision), so you can't check how it looks; say so honestly. It's attached to your reply for the owner. Use browser_read and browser_check to test it in words.${errorsLine(s.errors)}`;
    },
  };

  const click: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'browser_click',
      description: 'Click something in the testing browser: a CSS selector, or the visible text of a button or link (real mouse click).',
      parameters: obj({ selector: { type: 'string' }, text: { type: 'string', description: 'Visible text, e.g. "Add to cart"' } }),
    },
    isAvailable: browserOn,
    summarize: (a) => `click ${a.text ? `"${String(a.text).slice(0, 60)}"` : String(a.selector ?? '').slice(0, 80)}`,
    async run(args, ctx) {
      const selector = str(args, 'selector', false);
      const text = str(args, 'text', false);
      if (!selector && !text) throw new ToolError('Give a selector or the visible text to click.');
      if (!app.browsers?.has(convOf(app, ctx).id)) throw new ToolError('Open a page first with browser_open.');
      const s = await session(ctx);
      const r = await wrap(() => s.click({ ...(selector ? { selector } : {}), ...(text ? { text } : {}) }));
      const now = await wrap(() => s.read(undefined, 200));
      return `${r} Now on ${now.url} (${now.title || 'no title'}).${errorsLine(s.errors)}`;
    },
  };

  const type: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'browser_type',
      description: 'Type into a field in the testing browser (CSS selector, or the field\u2019s label or placeholder). For a drop-down list, the text picks the option. submit presses Enter afterwards.',
      parameters: obj({ selector: { type: 'string', description: 'CSS selector or the label/placeholder text' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['selector', 'text']),
    },
    isAvailable: browserOn,
    summarize: (a) => `type into ${String(a.selector ?? '').slice(0, 60)}${a.submit ? ' and press Enter' : ''}`,
    async run(args, ctx) {
      const target = str(args, 'selector');
      const value = typeof args.text === 'string' ? args.text : String(args.text ?? '');
      if (value.length > 5000) throw new ToolError('Up to 5000 characters at a time.');
      if (!app.browsers?.has(convOf(app, ctx).id)) throw new ToolError('Open a page first with browser_open.');
      const s = await session(ctx);
      // A selector-looking target is tried as one first, then as label text.
      const looksCss = /^[#.[]|^[a-z]+([#.[:]|$)/i.test(target) && !/\s{2,}/.test(target);
      const r = await wrap(() => s.type(looksCss ? { selector: target, text: target } : { text: target }, value, args.submit === true));
      return `${r}${errorsLine(s.errors)}`;
    },
  };

  const read: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'browser_read',
      description: 'Read the page in the testing browser: its text (or one part, by CSS selector) and a short list of the buttons, links and fields on it, plus page errors.',
      parameters: obj({ selector: { type: 'string' } }),
    },
    isAvailable: browserOn,
    summarize: (a) => `read the page${a.selector ? ` (${String(a.selector).slice(0, 60)})` : ''}`,
    async run(args, ctx) {
      if (!app.browsers?.has(convOf(app, ctx).id)) throw new ToolError('Open a page first with browser_open.');
      const s = await session(ctx);
      const r = await wrap(() => s.read(str(args, 'selector', false)));
      if (r.error) throw new ToolError(r.error);
      const overflow = r.scrollWidth > r.width + 1 ? `\nNote: the page is ${r.scrollWidth}px wide in a ${r.width}px window (sideways scrolling).` : '';
      return `${r.title || '(no title)'} — ${r.url}\n\n${r.text || '(no text)'}${r.more ? '\n[… more text not shown]' : ''}\n\nOn the page:\n${r.controls.length ? r.controls.map((c) => `- ${c}`).join('\n') : '(no buttons, links or fields)'}${overflow}${errorsLine(s.errors)}`;
    },
  };

  const check: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'browser_check',
      description: `Check facts about the page in the testing browser, without running any code: ${CHECK_TYPES.join(', ')}. Each check passes or fails; use them to prove your app works (e.g. after clicking "Add", text_visible "1 item"). no_horizontal_scroll at phone width catches layouts that don't fit.`,
      parameters: obj(
        {
          checks: {
            type: 'array',
            items: obj({ type: { type: 'string', enum: [...CHECK_TYPES] }, text: { type: 'string' }, selector: { type: 'string' }, count: { type: 'integer' } }, ['type']),
          },
        },
        ['checks'],
      ),
    },
    isAvailable: browserOn,
    summarize: (a) => `check the page (${Array.isArray(a.checks) ? (a.checks as { type?: string }[]).map((c) => c.type).join(', ').slice(0, 100) : ''})`,
    async run(args, ctx) {
      const list = Array.isArray(args.checks) ? (args.checks as Record<string, unknown>[]) : [];
      if (!list.length || list.length > 20) throw new ToolError('Give 1 to 20 checks.');
      const checks: Check[] = list.map((c) => {
        const t = String(c.type ?? '') as Check['type'];
        if (!CHECK_TYPES.includes(t)) throw new ToolError(`Unknown check "${t}". Use one of: ${CHECK_TYPES.join(', ')}.`);
        if (['element_exists', 'element_visible', 'element_hidden', 'count_at_least', 'input_value'].includes(t) && !c.selector) throw new ToolError(`${t} needs a selector.`);
        if (['text_visible', 'text_absent', 'title_contains', 'url_contains'].includes(t) && !c.text) throw new ToolError(`${t} needs a text.`);
        return { type: t, ...(c.text !== undefined ? { text: String(c.text).slice(0, 500) } : {}), ...(c.selector !== undefined ? { selector: String(c.selector).slice(0, 300) } : {}), ...(c.count !== undefined ? { count: Number(c.count) } : {}) };
      });
      if (!app.browsers?.has(convOf(app, ctx).id)) throw new ToolError('Open a page first with browser_open.');
      const s = await session(ctx);
      const results = await wrap(() => s.check(checks));
      const lines = checks.map((c, i) => `${results[i]?.ok ? 'PASS' : 'FAIL'} ${c.type}${c.text ? ` "${c.text}"` : ''}${c.selector ? ` ${c.selector}` : ''}${c.count !== undefined ? ` ≥${c.count}` : ''}${results[i]?.detail ? ` (${results[i].detail})` : ''}`);
      const failed = results.filter((r) => !r?.ok).length;
      return `${failed ? `${failed} of ${checks.length} checks failed` : `All ${checks.length} checks passed`} (window ${s.viewport.width}px):\n${lines.join('\n')}`;
    },
  };

  return [previewStart, previewStop, open, screenshot, click, type, read, check];
}

/** Tool names whose receipts back "I tested it in the browser". */
export const BROWSER_TOOLS = new Set(['browser_open', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_read', 'browser_check']);
