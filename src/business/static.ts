import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

const assets = new Map<string, string[]>([
  ['/', ['business.html', 'text/html']], ['/business.html', ['business.html', 'text/html']],
  ...['business-app.js', 'business-auth.js', 'business-i18n.js', 'business-state.js', 'business-admin.js', 'business-sso.js'].map(file => ['/' + file, [file, 'text/javascript']] as [string, string[]]),
  ...['business.css', 'theme.css'].map(file => ['/' + file, [file, 'text/css']] as [string, string[]]),
  ...['en', 'es', 'fr', 'de', 'pt-BR', 'it'].map(lang => ['/i18n/' + lang + '.json', ['i18n/' + lang + '.json', 'application/json']] as [string, string[]]),
]);

/** Public sign-in shell only: no path-derived filesystem access or personal app assets. */
export async function serveBusinessStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const asset = assets.get(path);
  if (!asset || !['GET', 'HEAD'].includes(req.method ?? '')) return false;
  const bytes = await readFile(new URL('../../web/' + asset[0], import.meta.url));
  res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.writeHead(200, { 'content-type': asset[1] + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : bytes); return true;
}
