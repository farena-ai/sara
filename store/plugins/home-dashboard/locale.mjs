import { readFileSync } from 'node:fs';
const labels = JSON.parse(readFileSync(new URL('./labels.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('./sara-plugin.json', import.meta.url), 'utf8'));
let active = null;
export function initLocale(lang) {
  const l = String(lang).toLowerCase();
  const key = l === 'pt' || l.startsWith('pt-') ? 'pt-BR' : l.split('-')[0];
  active = labels[key] ?? null;
}
export const currentLanguage = () => active ? Object.keys(labels).find(k => labels[k] === active) : 'en';
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
export function readyDescription(original) { return active ? `${active.description} ${active.contract} ${active.bounds}` : original; }
export function nativeCard() { return { title: active?.title ?? manifest.name, lines: [active?.description ?? manifest.description, active?.card ?? 'Supplied data; review the result. No external actions.'] }; }
// Only known generated fields are translated. Never walk/replace arbitrary strings: source text,
// IDs, schema keys, enum values, CSV cells, model replies and receipts must remain byte-exact.
export function localize(v, args = {}) {
  if (!active) return v;
  const l = active, id = manifest.id;
  if (id === 'inbox-triage') {
    v.warning = l.warning;
    v.items.forEach((item, i) => { item.reason = l.reason; item.draftStatus = l.draftStatus; item.draftReply = fill(l.reply, { subject: args.messages[i].subject.slice(0, 70) }); });
  }
  if (id === 'content-studio') {
    v.outline = v.channel === 'social' ? [l.hook, l.core, l.invitation] : [l.headline, l.context, l.core, l.next];
    v.assumptions = [l.assumption, fill(l.tone, {tone:v.tone})];
    if (args.useModel !== true) {
      const headline = args.brief.split(/[\n.!?]/)[0].slice(0, 90);
      v.draft = `# ${headline}\n\n${fill(l.forAudience, {audience:v.audience})}\n\n${args.brief}\n\n${l.review}`;
      v.export.text = v.draft;
    }
  }
  if (id === 'image-workshop' && v.prompt !== undefined) {
    v.prompt = `${l[v.style]}. ${v.brief}. ${l.aspect} ${v.aspect}.${v.avoid ? ` ${l.avoid}: ${v.avoid}.` : ''}`;
    v.prerequisite = l.prerequisite;
  }
  if (id === 'spreadsheet-assistant') v.warning = l.warning;
  if (id === 'travel-planner') { v.priceStatus = l.priceStatus; v.unknowns = [l.routing, l.dates, l.preferences]; }
  if (id === 'home-dashboard') { v.devices.forEach(d => d.freshness = l.freshness); v.prerequisite = l.prerequisite; v.limitation = l.limitation; }
  return v;
}

export function localizedError(error) {
  if (!active) return error;
  const message = String(error?.message ?? error);
  const key = /Stored preset is corrupt/.test(message) ? 'corrupt' : /Persistence|readback/.test(message) ? 'persistence' : /model|Model/.test(message) ? 'modelError' : /Result exceeds/.test(message) ? 'oversize' : 'error';
  return new Error(active[key]);
}
