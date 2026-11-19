// W2.5 (docs/HELP_SEARCH.md): short how-to clips for the top "How do I…?" answers, made from a scripted
// run on a throwaway in-process server (test/helpers.ts makeApp, fake model, no accounts): Playwright
// screenshots of each step (the page, the answer opened, Show me pulsing the control) stitched into a
// small WebM with ffmpeg. Writes docs/media/howto/<page>-<q>.webm and docs/media/clips.json, then run
// node scripts/gen-guide.ts (links them in docs/HOW_DO_I.md) and node scripts/help-index.ts.
//   PLAYWRIGHT=<path to playwright/index.mjs> FFMPEG=<ffmpeg.exe> [CHROME=<chrome.exe>] [PORT=8655] [ONLY=<page/q>]
//   node scripts/howto-clips.ts
// Without ffmpeg it keeps the frames as an animated sequence of PNGs under docs/media/howto/<name>/.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The top 10 answers (the first things people ask), in the order of the guide. */
export const TOP_CLIPS = ['models-default/pick', 'her-character/rename', 'her-voice/pick', 'ab-search/on', 'ab-google/connect', 'co-phone/install', 'co-phone/push', 'co-telegram/connect', 'dh-devices/add', 'dh-backups/now'];

const main = async () => {
  const PW = process.env.PLAYWRIGHT ?? '';
  const FFMPEG = process.env.FFMPEG ?? '';
  const PORT = Number(process.env.PORT ?? 8655);
  const ONLY = process.env.ONLY ?? '';
  const W = 960;
  const H = 600;
  const { makeApp, tempDir } = await import(pathToFileURL(join(ROOT, 'test/helpers.ts')).href);
  const { OwnerAuth } = await import(pathToFileURL(join(ROOT, 'src/auth.ts')).href);
  const { createSaraServer } = await import(pathToFileURL(join(ROOT, 'src/server.ts')).href);
  // Playwright is not a dependency of Sara: point PLAYWRIGHT at any installed copy (or have it on the path).
  const { chromium } = await import(PW ? pathToFileURL(PW).href : 'playwright');
  const howto = JSON.parse(readFileSync(join(ROOT, 'web/howto.json'), 'utf8')) as Record<string, { id: string; q: string; steps: string[]; show?: string }[]>;
  if (await fetch(`http://127.0.0.1:${PORT}/api/health`).then(() => true, () => false)) throw new Error(`port ${PORT} is busy`);
  const outDir = join(ROOT, 'docs/media/howto');
  mkdirSync(outDir, { recursive: true });
  const clipsFile = join(ROOT, 'docs/media/clips.json');
  const clips: Record<string, { file: string; seconds: number; bytes: number }> = existsSync(clipsFile) ? JSON.parse(readFileSync(clipsFile, 'utf8')) : {};
  const work = join(process.env.TMPDIR ?? tmpdir(), `howto-clips-${process.pid}`);
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { get now() { return new Date(); } } as never);
  app.settings.update({ providers: [{ id: 'fake', kind: 'openai-compatible', label: 'Fake', baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'fake-model' }], defaultProviderId: 'fake', defaultModel: 'fake-model', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: new Date().toISOString(), setupDone: true } as never);
  app.providerFactory = ((config: unknown) => ({ config, async listModels() { return ['fake-model']; }, async *stream() { yield { type: 'text', text: 'OK' }; } })) as never;
  const auth = new OwnerAuth(dir);
  const token = auth.newToken;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${PORT}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
  const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark', timezoneId: 'America/Chicago' });
    await ctx.addInitScript(() => { try { localStorage.setItem('sara.tour.first', 'seen'); } catch { /* sandboxed */ } });
    await ctx.route('**/*', (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => {
      const u = route.request().url();
      return !u.startsWith(origin) || /\/api\/update/.test(u) ? route.abort() : route.continue();
    });
    await ctx.request.post(`${origin}/api/login`, { data: { token }, headers: { Origin: origin } });
    for (const key of TOP_CLIPS) {
      if (ONLY && key !== ONLY) continue;
      const [pageId, qId] = key.split('/');
      const q = howto[pageId]?.find((x) => x.id === qId);
      if (!q) throw new Error(`${key} is not in web/howto.json`);
      const name = `${pageId}-${qId}`;
      const frames = join(work, name);
      rmSync(frames, { recursive: true, force: true });
      mkdirSync(frames, { recursive: true });
      const page = await ctx.newPage();
      page.on('pageerror', (e: Error) => errors.push(`${key}: ${e.message}`));
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await page.waitForTimeout(2500);
      // Open the page the way a help search link does (W2.5 &howto= in openViewFromHash).
      await page.evaluate((p: string) => {
        for (const d of document.querySelectorAll('dialog[open]')) if (d.id !== 'settings') (d as HTMLDialogElement).close();
        location.hash = `#view=settings:${p}`;
      }, pageId);
      await page.waitForTimeout(1800);
      await page.evaluate(() => {
        for (const d of document.querySelectorAll('dialog[open]')) if (d.id !== 'settings') (d as HTMLDialogElement).close();
        const st = document.querySelector('#settings') as HTMLDialogElement;
        if (!st.open) { st.classList.add('page-open'); st.showModal(); }
      });
      // A caption bar with the question and the step, drawn by the page (CSSOM styles pass the CSP).
      const caption = (text: string) => page.evaluate((t: string) => {
        let c = document.getElementById('clip-cap');
        if (!c) {
          c = document.createElement('div');
          c.id = 'clip-cap';
          Object.assign(c.style, { position: 'fixed', inset: 'auto 0 0 0', margin: '0', width: '100%', maxWidth: '100%', boxSizing: 'border-box', border: '0', padding: '10px 18px', font: '600 17px system-ui, sans-serif', background: 'rgba(15,13,23,.88)', color: '#fff', zIndex: '2147483647', textAlign: 'center' });
          // Above the modal Settings dialog: the top layer needs a popover.
          c.setAttribute('popover', 'manual');
          document.body.append(c);
        }
        c.textContent = t;
        // The bare fixture's "Not available" notes (routes it has no engine for) are not part of the answer.
        const err = document.querySelector('#settings-error');
        if (err) err.textContent = '';
        if (c.matches(':popover-open')) c.hidePopover();
        c.showPopover();
      }, text);
      let n = 0;
      const list: { file: string; d: number }[] = [];
      const snap = async (d: number) => {
        const file = join(frames, `f-${++n}.png`);
        await page.screenshot({ path: file });
        list.push({ file, d });
      };
      await caption(q.q);
      await snap(1.8);
      await page.evaluate(() => { const b = document.querySelector('#settings-howto details.howto') as HTMLDetailsElement | null; if (b) { b.open = true; b.scrollIntoView({ block: 'start' }); } });
      await page.waitForTimeout(300);
      await snap(1.2);
      await page.evaluate((id: string) => { const d = document.querySelector(`#settings-howto details.howto-q[data-q="${id}"]`) as HTMLDetailsElement | null; if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); } }, qId);
      await page.waitForTimeout(300);
      for (let i = 0; i < q.steps.length; i++) {
        await caption(`${i + 1}. ${q.steps[i]}`);
        await snap(Math.min(4, 1.6 + q.steps[i].length / 40));
      }
      if (q.show) {
        await caption(`Show me → ${q.q.replace(/^How do I /, '').replace(/\?$/, '')}`);
        await page.evaluate((id: string) => (document.querySelector(`#settings-howto details.howto-q[data-q="${id}"] .howto-show`) as HTMLButtonElement | null)?.click(), qId);
        for (let i = 0; i < 4; i++) {
          await page.waitForTimeout(250);
          await snap(0.3);
        }
        await page.waitForTimeout(600);
        await snap(1.8);
      }
      await page.close();
      const seconds = Math.round(list.reduce((s, f) => s + f.d, 0));
      if (FFMPEG && existsSync(FFMPEG)) {
        const concat = join(frames, 'list.txt');
        writeFileSync(concat, `${list.map((f) => `file '${f.file.replace(/\\/g, '/')}'\nduration ${f.d}`).join('\n')}\nfile '${list.at(-1)!.file.replace(/\\/g, '/')}'\n`);
        const out = join(outDir, `${name}.webm`);
        execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-vf', `fps=8,scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-row-mt', '1', '-an', out]);
        clips[key] = { file: `howto/${name}.webm`, seconds, bytes: statSync(out).size };
      } else {
        // No ffmpeg: the frames themselves, played as a sequence by anyone who opens the folder.
        const seq = join(outDir, name);
        mkdirSync(seq, { recursive: true });
        list.forEach((f, i) => copyFileSync(f.file, join(seq, `${String(i + 1).padStart(2, '0')}.png`)));
        console.log(`${key}: no ffmpeg, kept ${list.length} frames in docs/media/howto/${name}/`);
      }
      console.log(`${key}: ${list.length} frames, ${seconds} s${clips[key] ? `, ${Math.round(clips[key].bytes / 1024)} KB` : ''}`);
    }
    const sorted = Object.fromEntries(TOP_CLIPS.filter((k) => clips[k]).map((k) => [k, clips[k]]));
    writeFileSync(clipsFile, `${JSON.stringify(sorted, null, 1)}\n`);
    if (errors.length) console.log(`Page errors:\n${errors.join('\n')}`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    app.store.close();
    cleanup();
    rmSync(work, { recursive: true, force: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
