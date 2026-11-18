// V0.8: provider presets (web/sso-presets.js) shared by Settings and business company sign-in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SSO_PRESET_IDS as SERVER_IDS } from '../src/home-sso.ts';
import { issuerAllowed } from '../src/business/oidc.ts';
import { ROOT } from './helpers.ts';

const web = await import(new URL('../web/sso-presets.js', import.meta.url).href) as {
  SSO_PRESET_IDS: string[]; SSO_ISSUERS: Record<string, string>; ssoPresetName: (id: string, t: (s: string) => string) => string; ssoSteps: (id: string, t: (s: string) => string) => [string, string?][];
};
const t = (s: string) => s;

test('V0.8 presets: every provider has a name, an https issuer pattern and 3-5 steps naming the redirect URL', () => {
  assert.deepEqual([...web.SSO_PRESET_IDS].sort(), [...SERVER_IDS].sort(), 'web and server know the same presets');
  for (const id of ['entra', 'okta', 'google', 'authentik', 'keycloak', 'pocketid', 'authelia', 'generic']) assert.ok(web.SSO_PRESET_IDS.includes(id), id);
  for (const id of web.SSO_PRESET_IDS) {
    const steps = web.ssoSteps(id, t);
    assert.ok(steps.length >= 3 && steps.length <= 5, `${id}: ${steps.length} steps`);
    assert.ok(steps.some(([s]) => /redirect URL above/.test(s)), `${id} says where the redirect URL goes`);
    assert.ok(steps.some(([, code]) => code === web.SSO_ISSUERS[id]), `${id} shows its issuer pattern`);
    assert.ok(issuerAllowed(web.SSO_ISSUERS[id].replace(/[A-Z-]{3,}/g, 'x'), false), `${id} pattern is an allowed issuer shape`);
    assert.ok(web.ssoPresetName(id, t));
  }
});

test('V0.8 business company sign-in offers the self-hosted presets too', () => {
  const ui = readFileSync(`${ROOT}/web/business-sso.js`, 'utf8');
  assert.match(ui, /from '\.\/sso-presets\.js'/);
  assert.match(readFileSync(`${ROOT}/src/business/static.ts`, 'utf8'), /'sso-presets\.js'/);
  const src = readFileSync(`${ROOT}/src/business/sso.ts`, 'utf8');
  for (const id of ['authentik', 'keycloak', 'pocketid', 'authelia']) assert.match(src, new RegExp(`'${id}'`));
});
