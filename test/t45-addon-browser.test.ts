// T45 E5: the reply check knows a browser add-on (MCP) as a browser. "I tested it in the browser"
// after a Playwright add-on call is no longer flagged "Not checked"; a claim nothing backs still is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaims, isBrowserCall, judgedClaim, shotList } from '../src/receipts.ts';

const call = (name: string, args: Record<string, unknown> = {}, status: 'ok' | 'error' = 'ok') => ({ name, status, args, output: status === 'ok' ? 'done' : 'failed' });
const kinds = (reply: string, receipts: ReturnType<typeof call>[]) => checkClaims(reply, receipts).map((c) => c.kind);

test('T45 add-on browser: which tool names are a browser', () => {
  for (const n of ['browser_open', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_take_screenshot', 'mcp_chrome-devtools_take_screenshot', 'mcp_puppeteer_puppeteer_click']) assert.equal(isBrowserCall(n), true, n);
  for (const n of ['mcp_fetch_fetch', 'mcp_github_create_issue', 'web_fetch', 'shell']) assert.equal(isBrowserCall(n), false, n);
});

test('T45 add-on browser: a claim backed by add-on browser calls is not flagged', () => {
  const opened = [call('mcp_playwright_browser_navigate', { url: 'http://localhost:3000' }), call('mcp_playwright_browser_click', { ref: 'e5' })];
  assert.deepEqual(kinds('I tested it in the browser and clicked through the whole form. It works.', opened), []);
  assert.equal(judgedClaim('I opened the page in the browser.', 'browser', opened), undefined);
  // The same words with no browser call at all, or only a failed one, are still flagged.
  assert.deepEqual(kinds('I tested it in the browser and clicked through the whole form. It works.', []), ['browser']);
  assert.deepEqual(kinds('I opened it in the browser.', [call('mcp_playwright_browser_navigate', {}, 'error')]), ['browser']);
  // Another add-on is not a browser.
  assert.deepEqual(kinds('I tested it in the browser and it works.', [call('mcp_fetch_fetch', { url: 'http://localhost:3000' })]), ['browser']);
});

test('T45 add-on browser: a screenshot claim needs the add-on screenshot, at the width it names', () => {
  const nav = call('mcp_playwright_browser_navigate');
  const shot = call('mcp_playwright_browser_take_screenshot');
  assert.deepEqual(kinds('I took a screenshot of the page.', [nav]), ['browser'], 'opening a page is not a screenshot');
  assert.deepEqual(kinds('I took a screenshot of the page.', [nav, shot]), []);
  // No resize: the add-on's window is desktop wide, so a phone claim is not backed.
  assert.deepEqual(kinds('I took a screenshot at phone width.', [nav, shot]), ['browser']);
  const phone = [nav, call('mcp_playwright_browser_resize', { width: 390, height: 844 }), shot];
  assert.deepEqual(kinds('I took a screenshot at phone width.', phone), []);
  assert.deepEqual(shotList(phone).map((x) => x.width), ['phone']);
  assert.deepEqual(shotList([shot, ...phone]).map((x) => x.width), ['desktop', 'phone'], 'each screenshot has the width of its moment');
  assert.deepEqual(shotList([call('mcp_playwright_browser_take_screenshot', {}, 'error')]), [], 'a failed one is no screenshot');
});

test('T45 add-on browser: "it looks right now" needs a look after the last edit, add-on or not', () => {
  const edit = call('edit_file', { path: 'index.html' });
  const nav = call('mcp_playwright_browser_navigate');
  const shot = call('mcp_playwright_browser_take_screenshot');
  const said = 'The header is fixed now.';
  const before = checkClaims(said, [nav, shot, edit]).map((c) => c.kind);
  const after = checkClaims(said, [nav, edit, shot]).map((c) => c.kind);
  assert.deepEqual(after, [], 'looked again after the edit');
  assert.ok(before.includes('browser'), 'the screenshot was taken before the edit');
});
