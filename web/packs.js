// Phase 127 (2.60.0, docs/design/PACKS.md §6, §8, §9, §13): companion packs in the app. *Share her*
// (exactly what leaves, with memories, chats, people, keys and his name locked), the pack card (*Add
// her* makes a NEW companion; nobody he has changes), the update card (a diff he picks from), *From a
// file* on Settings → Her → Companions, and the Companions shelf card for Get more. Everything comes
// from /api/packs on Sara's own server; every text from a pack is set with textContent.
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
async function api(path, opts = {}) {
  const raw = opts.raw !== undefined;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: raw ? { 'content-type': 'application/octet-stream' } : opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: raw ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => onClick(b));
  return b;
};
const tipBtn = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
const enc = encodeURIComponent;
const p = { back: [], current: null, done: null };
const say = (text) => {
  $('#pkp-status').textContent = text ?? '';
};
const kb = (n) => (n < 1048576 ? t('{n} KB', { n: Math.max(1, Math.round(n / 1024)) }) : t('{n} MB', { n: (n / 1048576).toFixed(1) }));
const word = (pronouns) => (pronouns === 'he' ? t('Add him') : pronouns === 'they' ? t('Add them') : t('Add her'));
export const addWord = word;

/** The one panel (Share her, the pack card, the update card); ← back between steps, one ✕. */
function panel(title, nodes, o = {}) {
  const d = $('#pack-panel');
  if (o.push && d.open && p.current) p.back.push(p.current);
  if (!o.push) p.back = [];
  p.current = o.redo ?? null;
  $('#pkp-title').textContent = title;
  $('#pkp-back').hidden = !p.back.length;
  d.classList.toggle('wide', Boolean(o.wide));
  $('#pkp-body').replaceChildren(...nodes);
  say('');
  if (!d.open) d.showModal();
  $('#pkp-body').scrollTop = 0;
}
const section = (head, tip, ...nodes) => {
  const s = el('section', 'pkp-sec');
  if (head) {
    const h = el('h4', '', head);
    if (tip) h.append(' ', tipBtn(tip));
    s.append(h);
  }
  s.append(...nodes);
  return s;
};
const check = (label, tip, on, o = {}) => {
  const l = el('label', `pkp-check${o.locked ? ' locked' : ''}`);
  const i = el('input');
  i.type = 'checkbox';
  i.checked = Boolean(on);
  i.disabled = Boolean(o.locked || o.off);
  l.append(i, el('span', '', label));
  if (o.size) l.append(el('span', 'muted small pkp-size', o.size));
  if (tip) l.append(tipBtn(tip));
  return { row: l, input: i };
};
const select = (options, value) => {
  const s = el('select');
  for (const [v, label] of options) s.append(new Option(label, v, false, v === value));
  return s;
};

// ---------------------------------------------------------------------------------------------
// Share her (§6.2)
// ---------------------------------------------------------------------------------------------

export async function openShare(companion) {
  let m;
  try {
    m = await api(`/packs/build/${enc(companion)}`);
  } catch (err) {
    return void alert(err.message);
  }
  const sec = Object.fromEntries(m.sections.map((s) => [s.id, s]));
  const ticks = {};
  const goes = el('div', 'pkp-list');
  const add = (id, label, tip, on, o) => {
    const c = check(label, tip, on, o);
    ticks[id] = c.input;
    goes.append(c.row);
  };
  add('character', t('Her character: name, age, personality, how she talks'), t('Her name, age, personality, background, how she talks and her boundaries. Your name becomes “you” so it fits whoever adds her. Your own notes about the two of you and your hard limits stay here.'), true, { locked: true, size: sec.character.size });
  add('dials', sec.dials.count === 1 ? t('Her personality dials (1 set)') : t('Her personality dials ({n} set)', { n: sec.dials.count }), t('Her personality sliders (warmth, teasing and the rest) go as numbers, so she feels the same to someone else.'), sec.dials.count > 0, { off: !sec.dials.count });
  add('look', sec.look.custom ? t('Her look: {n} pictures', { n: sec.look.count }) : t('Her look: the default pictures (not shared)'), t('The pictures the app shows of her: her face, her expressions and the frames that make her blink and talk. Pictures she sent you are never included.'), sec.look.custom, { off: !sec.look.custom, size: sec.look.custom ? sec.look.size : '' });
  const closetBox = el('div', 'pkp-sub');
  for (const l of sec.closet.looks.slice(0, 30)) {
    const c = check(l.adult ? t('{name} (adults only)', { name: l.name }) : l.name, '', false);
    c.input.dataset.look = l.id;
    closetBox.append(c.row);
  }
  const closetHead = check(sec.closet.count === 1 ? t('Her closet: 1 saved look') : t('Her closet: {n} saved looks', { n: sec.closet.count }), t('Looks you saved for her. Adults-only looks are only worn when the new owner turns Adult mode on for her.'), false, { off: !sec.closet.count });
  closetHead.input.addEventListener('change', () => {
    for (const i of closetBox.querySelectorAll('input')) i.checked = closetHead.input.checked && [...closetBox.querySelectorAll('input:checked')].length < 6;
  });
  goes.append(closetHead.row, closetBox);
  add('reference', t('A reference picture for her face'), t('A picture of her face that keeps her looking like herself in new pictures (Face lock). Never a photo of a real person in a store pack.'), false, { off: !sec.reference.available });
  add('voice', t('Her voice: {voice}', { voice: sec.voice.words }), t('Which voice she uses and how fast, never any keys. A voice you cloned stays with your account.'), true);
  add('greeting', sec.greeting.count === 1 ? t('Her first message') : t('Her first message and {n} others', { n: sec.greeting.count - 1 }), t('The first thing she says to someone new, plus a few others to choose from.'), true);
  const skillBox = el('div', 'pkp-sub');
  for (const s of sec.skills.skills) {
    const c = check(s.store ? t('{name} (from the Sara Store)', { name: s.name }) : t('{name} (hers)', { name: s.name }), '', true);
    c.input.dataset.skill = s.ref;
    skillBox.append(c.row);
  }
  goes.append(section(t('Skills'), t('Skills from the Sara Store go as a name; the new owner installs them through the usual review. Skills you made go inside the pack and are reviewed too.'), skillBox.childNodes.length ? skillBox : el('p', 'muted small', t('She has no skills of her own yet.'))));
  const routines = el('input');
  routines.id = 'pkp-routines';
  routines.placeholder = 'bedtime, weekly-review';
  routines.autocomplete = 'off';
  const rl = el('label', 'pkp-field');
  const rh = el('span', '', t('Routines she suggests'));
  rh.append(' ', tipBtn(t('Routines she’ll suggest after she’s added, like a bedtime nudge. Nothing is switched on until the new owner says so.')));
  rl.append(rh, routines);
  goes.append(rl);
  const L = m.locked;
  const locks = el('ul', 'pkp-locks');
  const lock = (text) => locks.append(el('li', 'muted small', `🔒 ${text}`));
  lock(L.memories === 1 ? t('Her memories (1)') : t('Her memories ({n})', { n: L.memories }));
  lock(L.chats === 1 ? t('Your chats (1)') : t('Your chats ({n})', { n: L.chats }));
  lock(L.people === 1 ? t('People you’ve told her about (1)') : t('People you’ve told her about ({n})', { n: L.people }));
  lock(t('Keys and the vault'));
  if (L.name) lock(L.name.count === 1 ? t('Your name: “{name}” becomes “you” (1 place)', { name: L.name.name }) : t('Your name: “{name}” becomes “you” ({n} places)', { name: L.name.name, n: L.name.count }));
  lock(t('Your hard limits and notes'));
  lock(t('Pictures she sent you'));
  if (L.cloned) lock(t('Her cloned voice (stays with your account)'));
  const lockSec = section(t('Never in a pack (always stays here)'), t('Her memories, your chats, people, keys, your name and the vault never leave this server, in any pack, ever.'), locks);
  const rating = select([['general', t('For everyone')], ['mature', t('Mature themes')], ['explicit', t('Explicit (18+)')]], m.explicitLevel ? 'explicit' : 'general');
  const romance = check(t('She’s romantic or flirty with you'), t('Tick if she flirts or is romantic with you. It is shown on her card so nobody is surprised.'), Boolean(m.intimacy && m.intimacy !== 'none'));
  const license = select([['CC-BY-4.0', t('Share with credit (CC BY 4.0)')], ['CC-BY-SA-4.0', t('Share alike (CC BY-SA 4.0)')], ['CC-BY-NC-4.0', t('Not for money (CC BY-NC 4.0)')], ['CC-BY-NC-SA-4.0', t('Not for money, share alike (CC BY-NC-SA 4.0)')], ['CC0-1.0', t('No rights kept (CC0)')], ['MIT', 'MIT']], 'CC-BY-4.0');
  const remix = select([['yes', t('Yes')], ['ask', t('Ask me')], ['no', t('No')]], 'yes');
  const author = el('input');
  author.maxLength = 60;
  author.autocomplete = 'off';
  const from = select([['words', t('Made with Grok Imagine from words')], ['my-drawing', t('I drew them')], ['a-photo-with-consent', t('From a photo, with that person’s yes')]], 'words');
  const field = (label, tip, input) => {
    const l = el('label', 'pkp-field');
    const h = el('span', '', label);
    h.append(' ', tipBtn(tip));
    l.append(h, input);
    return l;
  };
  const made = check(t('I made her, or I have the right to share everything in this pack.'), '', false);
  const consent = check(t('She isn’t a real person, or that person said yes.'), '', false);
  const about = section(
    t('About the pack'),
    '',
    field(t('Rating'), t('Pick the highest that fits. Explicit packs only work fully when the new owner turns on Adult mode for her. Nothing about minors is ever allowed.'), rating),
    romance.row,
    field(t('Licence'), t('What others may do with her: share with credit, share alike, or not for money. The Sara Store asks for one of these.'), license),
    field(t('Re-sharing changed copies'), t('Whether you’re happy for people to share copies they changed. Shown on her card; Sara never stops anyone editing their own companion.'), remix),
    field(t('Your name on it'), t('Shown to people who add her. It can be a nickname. Your email is never in the pack.'), author),
    field(t('Where her pictures came from'), t('Say how each picture was made. Pictures Sara built say so by themselves. A photo of a real person needs their yes, and never goes to the store.'), from),
    made.row,
    consent.row,
  );
  const out = el('div', 'pkp-out');
  const acts = el('div', 'pkp-acts');
  let built = null;
  const body = () => ({
    include: {
      dials: ticks.dials.checked,
      look: ticks.look.checked,
      closet: [...closetBox.querySelectorAll('input:checked')].map((i) => i.dataset.look),
      reference: ticks.reference.checked,
      voice: ticks.voice.checked,
      greeting: ticks.greeting.checked,
      skills: [...skillBox.querySelectorAll('input:checked')].map((i) => i.dataset.skill),
      routines: routines.value.split(/[\s,]+/).filter(Boolean).slice(0, 5),
    },
    rating: rating.value,
    romance: romance.input.checked,
    license: license.value,
    remix: remix.value,
    author: author.value.trim(),
    rights: { from: from.value },
    made: made.input.checked,
    consent: consent.input.checked,
  });
  const saveB = btn(t('Save the file'), '', () => {
    if (!built?.report?.ready) return;
    const a = el('a');
    a.href = `/api/packs/build/${enc(built.token)}/file`;
    a.download = `${built.manifest.id}.sara-companion.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    built = null;
    saveB.disabled = true;
    sendB.disabled = true;
    say(t('Saved. Check it again to save another copy.'));
  });
  const sendB = btn(t('Send to the Sara Store'), 'ghost', async (b) => {
    if (!built?.report?.ready) return;
    b.disabled = true;
    try {
      const r = await api(`/packs/build/${enc(built.token)}/store`, { method: 'POST', body: {} });
      if (!r.report.ready) {
        out.replaceChildren(reportEl(r.report));
        say(t('The Sara Store asks for a little more: see the report.'));
        return;
      }
      $('#pack-panel').close();
      document.dispatchEvent(new CustomEvent('sara:submit-pack', { detail: r }));
    } catch (err) {
      say(err.message);
    } finally {
      b.disabled = false;
    }
  });
  saveB.disabled = true;
  sendB.disabled = true;
  const checkB = btn(t('Check it'), '', async (b) => {
    if (!made.input.checked) return say(t('Tick “I made her, or I have the right to share everything in this pack” first.'));
    b.disabled = true;
    say(t('Checking…'));
    try {
      built = await api(`/packs/build/${enc(companion)}`, { method: 'POST', body: body() });
      out.replaceChildren(reportEl(built.report), ...built.notes.map((n) => el('p', 'muted small', n)), el('p', 'muted small', t('Pack size: {size}', { size: kb(built.size) })));
      saveB.disabled = !built.report.ready;
      sendB.disabled = !built.report.ready;
      say(built.report.ready ? t('All checks passed.') : t('Fix the ✗ lines, then check it again.'));
    } catch (err) {
      say(err.message);
    } finally {
      b.disabled = false;
    }
  });
  acts.append(checkB, saveB, sendB);
  panel(t('Share {name}', { name: m.name }), [section(t('What goes in the pack'), '', goes), lockSec, about, out, acts], { redo: () => openShare(companion) });
}

const MARK = (r) => (r.ok ? (r.warnings?.length ? '⚠' : '✓') : '✗');
export function reportEl(report) {
  const ul = el('ul', 'pkp-report');
  for (const r of report.results ?? []) {
    const li = el('li', r.ok ? 'ok' : 'bad');
    li.append(el('strong', '', `${MARK(r)} ${r.id}`));
    for (const x of [...(r.problems ?? []), ...(r.warnings ?? [])]) li.append(el('span', 'small', x));
    ul.append(li);
  }
  return ul;
}

// ---------------------------------------------------------------------------------------------
// The pack card (§8.2)
// ---------------------------------------------------------------------------------------------

const SECTION_WORDS = { Summary: () => t('Summary'), Background: () => t('Background'), Personality: () => t('Personality'), 'How she talks': () => t('How she talks'), Boundaries: () => t('Boundaries'), 'Her life': () => t('Her life'), 'Intimacy, her side': () => t('Intimacy, her side') };
const TRUST = { 'first-party': () => t('Made by the Sara team'), reviewed: () => t('Reviewed by the Sara team'), community: () => t('Not reviewed by people yet'), file: () => t('From a file you chose · not checked by the Sara team') };
const RATING = { general: () => t('For everyone'), mature: () => t('Mature themes'), explicit: () => t('Explicit (18+)') };

export function openCard(card, o = {}) {
  p.done = o.done ?? null;
  const head = el('div', 'pkp-head');
  if (card.face) {
    const img = el('img', 'pkp-face');
    img.src = card.face;
    img.alt = '';
    head.append(img);
  } else head.append(el('span', 'pkp-face pkp-glyph', '☺'));
  const who = el('div', 'pkp-who');
  who.append(el('strong', '', `${card.name} · ${card.pronouns === 'he' ? 'he/him' : card.pronouns === 'they' ? 'they/them' : 'she/her'} · ${card.age}`), el('p', '', card.summary), el('p', 'muted small', card.romance ? t('Romantic') : t('Not romantic')));
  head.append(who);
  const strip = el('p', `pkp-strip small trust-${card.trust}`, card.origin === 'card' ? t('From a character card ({source}) · made by {creator} · not checked by the Sara team', { source: card.source ?? '', creator: card.creator || t('someone') }) : `${TRUST[card.trust]?.() ?? card.trust} · ${t('Made by {author}', { author: card.author })} · ${RATING[card.rating]?.() ?? card.rating}`);
  const nodes = [strip, head];
  nodes.push(el('p', '', card.others.length ? t('She’ll be a new companion next to {names}. Nobody you have now changes.', { names: card.others.join(', ') }) : t('She’ll be a new companion. Nobody you have now changes.')));
  if (card.adult) nodes.push(el('p', 'pkp-adult small', t('This pack has adult parts. {n} explicit lines of her character wait until you turn Adult mode on for her, adults-only looks are kept but not worn, and her intimacy works as Suggestive until then (Settings → You → Adult mode, in a web browser).', { n: card.adult.held })));
  if (card.dials.length) {
    const d = el('details', 'pkp-fold');
    d.append(el('summary', '', t('Her personality')));
    const ul = el('ul', 'pkp-dials');
    for (const x of card.dials) {
      const li = el('li');
      const meter = el('meter');
      meter.min = 0;
      meter.max = 10;
      meter.value = x.value;
      li.append(el('span', '', t(x.label)), meter, el('span', 'muted small', `${t(x.low)} ↔ ${t(x.high)}`));
      ul.append(li);
    }
    d.append(ul);
    nodes.push(d);
  }
  const all = el('details', 'pkp-fold');
  all.append(el('summary', '', card.sheetLines === 1 ? t('Read all of her (1 line)') : t('Read all of her ({n} lines)', { n: card.sheetLines })));
  for (const s of card.sheet) {
    all.append(el('h5', '', SECTION_WORDS[s.section]?.() ?? s.section));
    const ul = el('ul', 'pkp-lines');
    for (const l of s.lines) ul.append(el('li', '', l));
    all.append(ul);
  }
  nodes.push(all);
  const facts = el('dl', 'pkp-facts');
  const fact = (k, v) => facts.append(el('dt', '', k), el('dd', '', v));
  fact(t('Her look'), card.look.kind === 'full' ? t('{n} pictures, {rights}', { n: card.look.count, rights: card.look.rights }) : card.look.kind === 'portrait' ? t('A portrait, {rights}', { rights: card.look.rights }) : card.look.needsPictures ? t('Words only: Make her look builds it with your image key') : t('The default look'));
  if (card.voice) fact(t('Her voice'), `${card.voice.words} · ${t('speed {n}', { n: card.voice.speed })}${card.voice.note ? ` · ${card.voice.note}` : ''}`);
  if (card.greeting) fact(t('Her hello'), `“${card.greeting.first}”`);
  nodes.push(facts);
  const skillTicks = [];
  if (card.skills.length) {
    const box = el('div', 'pkp-list');
    for (const s of card.skills) {
      const c = check(s.from === 'store' ? t('{name} (Sara Store, reviewed)', { name: s.name }) : t('{name} (in the pack)', { name: s.name }), '', true);
      c.input.dataset.key = s.key;
      skillTicks.push(c.input);
      box.append(c.row);
    }
    nodes.push(section(t('Skills'), t('Untick any you don’t want. Each one you keep shows its own review card next.'), box));
  }
  if (card.routines.length) nodes.push(el('p', 'small', t('Routines she’ll suggest after: {list}', { list: card.routines.map((r) => r.title).join(', ') })));
  if (card.suggests.length) nodes.push(el('p', 'small', t('She suggests (links only): {list}', { list: card.suggests.map((s) => s.store).join(', ') })));
  nodes.push(el('p', 'muted small', t('Never in a pack: memories, chats, people, keys. She starts knowing nothing about you. Her safety rules and the AI notice always apply, whatever the pack says.')));
  for (const n of [...card.notes, ...card.warnings]) nodes.push(el('p', 'muted small', n));
  const name = el('input');
  name.value = card.nameHere;
  name.maxLength = 40;
  name.autocomplete = 'off';
  const nl = el('label', 'pkp-field');
  const nh = el('span', '', t('Her name here'));
  nh.append(' ', tipBtn(t('You can call her something else. If you already have a companion with this name, pick another.')));
  nl.append(nh, name);
  nodes.push(nl);
  if (card.nameTaken) nodes.push(el('p', 'small', t('You already have a {name}. Pick another name for this one.', { name: card.name })));
  nodes.push(el('p', 'muted small', `${t('Licence: {licence} · re-sharing: {remix}', { licence: card.licenseWords, remix: card.remix === 'yes' ? t('Yes') : card.remix === 'no' ? t('No') : t('Ask me') })} · ${t('Fingerprint {fp}', { fp: `${card.fingerprint.slice(0, 4)}…${card.fingerprint.slice(-2)}` })} · ${kb(card.size)}`));
  const acts = el('div', 'pkp-acts');
  const cancel = btn(t('Cancel'), 'ghost', async () => {
    await api(`/packs/${enc(card.token)}`, { method: 'DELETE' }).catch(() => undefined);
    $('#pack-panel').close();
  });
  const addB = btn(word(card.pronouns), '', async (b) => {
    b.disabled = true;
    say(t('Adding…'));
    try {
      const r = await api(`/packs/${enc(card.token)}/install`, { method: 'POST', body: { name: name.value.trim(), skills: skillTicks.filter((i) => i.checked).map((i) => i.dataset.key) } });
      followUps(r);
      p.done?.(r);
    } catch (err) {
      say(err.message);
      b.disabled = false;
    }
  });
  if (card.capReached) {
    addB.disabled = true;
    nodes.push(el('p', 'small', t('Up to 8 companions on one server. Retire one in Settings → Her → Companions first.')));
  }
  acts.append(cancel, addB);
  nodes.push(acts);
  panel(t('Add {name} as a new companion?', { name: card.name }), nodes, { wide: true });
}

/** After Add her: each ticked skill's review, then the routines she suggests, then links. */
function followUps(r) {
  const nodes = [el('p', '', r.held ? t('{name} is here. {n} explicit lines wait until you turn on Adult mode for her.', { name: r.name, n: r.held }) : t('{name} is here. Switch to her with ⇄ at the top of the sidebar.', { name: r.name }))];
  for (const f of r.followUps) {
    if (f.kind === 'skill' && f.missing) nodes.push(el('p', 'muted small', f.line));
    else if (f.kind === 'skill' && f.review) {
      const box = el('div', 'pkp-card');
      box.append(el('strong', '', t('Skill: {name}', { name: f.name })), el('p', 'muted small', (f.review.skills ?? []).map((s) => `${s.name}: ${s.description ?? ''}`).join(' · ')));
      const ok = btn(t('Add it'), '', async (b) => {
        b.disabled = true;
        try {
          await api(`/packs/${enc(r.companion)}/skills/${enc(f.review.id)}/accept`, { method: 'POST', body: {} });
          box.replaceChildren(el('p', 'small', t('Added {name}.', { name: f.name })));
        } catch (err) {
          say(err.message);
          b.disabled = false;
        }
      });
      box.append(ok, btn(t('Skip'), 'ghost', () => box.remove()));
      nodes.push(box);
    } else if (f.kind === 'routine') {
      const box = el('div', 'pkp-card');
      box.append(el('strong', '', f.title), el('p', 'muted small', f.why ?? f.pitch ?? ''), el('p', 'muted small', t('Nothing is switched on: turn it on in Settings → Abilities → Routines when you like.')));
      nodes.push(box);
    } else if (f.kind === 'suggest') nodes.push(el('p', 'small', t('She suggests {name} from the Sara Store.', { name: f.store })));
  }
  nodes.push(btn(t('Done'), '', () => $('#pack-panel').close()));
  panel(t('Added {name}', { name: r.name }), nodes);
}

// ---------------------------------------------------------------------------------------------
// The update card (§9.2)
// ---------------------------------------------------------------------------------------------

export function openUpdate(m, o = {}) {
  const picks = {};
  const nodes = [el('p', 'muted small', m.summary.decide === 1 ? t('{p} changes picked, 1 to decide', { p: m.summary.picked }) : t('{p} changes picked, {d} to decide', { p: m.summary.picked, d: m.summary.decide }))];
  if (m.changes) nodes.push(el('p', '', t('What the author says: “{text}”', { text: m.changes })));
  const SECTIONS = [['rating', t('Her rating')], ['identity', t('Who she is')], ['personality', t('Her personality')], ['dials', t('Her dials')], ['look', t('Her look')], ['voice', t('Her voice')], ['skills', t('Skills')]];
  for (const [id, label] of SECTIONS) {
    const rows = m.rows.filter((r) => r.section === id);
    if (!rows.length) continue;
    const ul = el('ul', 'pkp-diff');
    for (const r of rows) {
      const li = el('li', r.red ? 'red' : r.kind);
      const what = r.kind === 'added' ? `+ ${r.after}` : r.kind === 'removed' ? `− ${r.before}` : r.kind === 'line' ? r.text : `${r.text ? `${r.text}: ` : ''}${r.before ?? ''} → ${r.after ?? ''}`;
      li.append(el('span', '', what));
      if (r.kind === 'conflict' && r.yours) li.append(el('span', 'muted small', t('You changed this to: {text}', { text: r.yours })));
      if (r.kind !== 'line') {
        const both = r.kind === 'conflict';
        const a = both ? t('Yours') : t('Keep');
        const b = both ? t('Theirs') : r.section === 'skills' ? t('Add') : t('Take');
        const g = el('span', 'pkp-pick');
        const set = (v) => {
          picks[r.id] = v;
          for (const x of g.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.v === v));
        };
        const ba = btn(a, 'ghost small', () => set(both ? 'yours' : 'keep'));
        ba.dataset.v = both ? 'yours' : 'keep';
        const bb = btn(b, 'ghost small', () => set(both ? 'theirs' : 'take'));
        bb.dataset.v = both ? 'theirs' : 'take';
        g.append(ba, bb);
        if (r.pick) set(r.pick);
        li.append(g);
      }
      ul.append(li);
    }
    nodes.push(section(label, id === 'personality' || id === 'dials' ? (rows.some((r) => r.kind === 'conflict') ? t('You changed this part yourself, and so did the author. Pick which one she keeps.') : t('Take uses the author’s new version of that part. Keep leaves her as she is now. Her memories and your chats are never part of an update.')) : '', ul));
  }
  nodes.push(el('p', 'muted small', t('Never touched by an update: her memories, your chats, people, her closet additions, her pictures for you, Adult mode, and anything you changed unless you pick “Theirs”.')));
  const acts = el('div', 'pkp-acts');
  acts.append(
    btn(t('Cancel'), 'ghost', () => $('#pack-panel').close()),
    btn(t('Update with what I picked'), '', async (b) => {
      b.disabled = true;
      try {
        const r = await api(`/packs/${enc(m.companion)}/update/apply`, { method: 'POST', body: { token: m.token, picks } });
        say(t('Updated to {v}.', { v: r.version }));
        o.done?.(r);
        setTimeout(() => $('#pack-panel').close(), 600);
      } catch (err) {
        say(err.message);
        b.disabled = false;
      }
    }),
  );
  nodes.push(acts);
  panel(t('Update to {v}?', { v: m.to }), nodes, { wide: true });
}

// ---------------------------------------------------------------------------------------------
// Settings → Her → Companions: From a file, the row's pack line and ⋯ menu
// ---------------------------------------------------------------------------------------------

async function previewFile(file, o = {}) {
  const raw = await file.arrayBuffer();
  const r = await api(`/packs/preview${o.update ? `?update=${enc(o.update)}` : ''}`, { method: 'POST', raw });
  if (r.update) return openUpdate(r.update, o);
  openCard(r.card, o);
}

/** The pack line and the ⋯ menu on each companion row (rows carry data-id). */
export async function decorateCompanionRows(list, o = {}) {
  let rows = [];
  try {
    rows = (await api('/packs/installed')).installs;
  } catch {
    rows = [];
  }
  for (const li of list.querySelectorAll('li[data-id]')) {
    const id = li.dataset.id;
    const row = rows.find((x) => x.companion_id === id);
    if (row) {
      const line = el('span', 'muted small pkp-from', t('From a pack · {name} {v} · {author}', { name: row.pack_id, v: row.version, author: row.author }));
      li.append(line);
      if (row.update) li.append(el('span', 'pkp-chip small', t('Update')));
      if (row.paused) li.append(el('span', 'pkp-paused small', t('{name} was pulled from the Sara Store: {reason}', { name: row.name ?? '', reason: row.paused.reason })));
    }
    // Phase 128 (PL2b, N16): Share her is a button on the row, not inside ⋯.
    if (!o.member) li.append(' ', btn(t('Share her'), 'ghost small pkp-share', () => void openShare(id)));
    if (!row) continue;
    const menu = el('details', 'share-menu pkp-menu');
    const sum = el('summary', 'button ghost small', '⋯');
    sum.setAttribute('aria-label', t('More for this companion'));
    const items = el('span', 'share-menu-items');
    {
      const pick = el('input');
      pick.type = 'file';
      pick.accept = '.zip,application/zip';
      pick.hidden = true;
      pick.addEventListener('change', async () => {
        const f = pick.files?.[0];
        if (f) await previewFile(f, { update: id, done: o.refresh }).catch((err) => alert(err.message));
        pick.value = '';
      });
      items.append(pick, btn(t('Update from a file'), 'ghost small', () => pick.click()));
      if (row.held) items.append(btn(t('Add the held lines'), 'ghost small', async () => alert((await api(`/packs/${enc(id)}/held`, { method: 'POST', body: {} }).catch((err) => ({ error: err.message }))).error ?? t('Added.'))));
      items.append(btn(t('Go back to the version before'), 'ghost small', async () => alert((await api(`/packs/${enc(id)}/goback`, { method: 'POST', body: {} }).catch((err) => ({ error: err.message }))).error ?? t('Done.'))));
      if (row.paused) {
        items.append(btn(t('Remove what the pack added'), 'ghost small', async () => {
          await api(`/packs/${enc(id)}/strip`, { method: 'POST', body: {} }).catch((err) => alert(err.message));
          o.refresh?.();
        }));
        if (!row.paused.minors) items.append(btn(t('Keep her anyway'), 'ghost small', async () => {
          if (!confirm(t('The Sara team pulled her. Keep her anyway?'))) return;
          await api(`/packs/${enc(id)}/keep`, { method: 'POST', body: { confirm: true } }).catch((err) => alert(err.message));
          o.refresh?.();
        }));
      }
    }
    menu.append(sum, items);
    li.append(' ', menu);
  }
}

export function initPacks(o = {}) {
  $('#pkp-close')?.addEventListener('click', async () => {
    $('#pack-panel').close();
  });
  $('#pkp-back')?.addEventListener('click', () => {
    const prev = p.back.pop();
    if (prev) void prev();
  });
  $('#pack-panel')?.addEventListener('close', () => {
    p.back = [];
    o.refresh?.();
  });
  const input = $('#cmp-file');
  $('#cmp-from-file')?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    $('#cmp-status').textContent = t('Reading it…');
    try {
      await previewFile(f, { done: o.refresh });
      $('#cmp-status').textContent = '';
    } catch (err) {
      $('#cmp-status').textContent = err.message;
    }
  });
  $('#card-share-pack')?.addEventListener('click', () => {
    $('#card-share')?.removeAttribute('open');
    void openShare(o.current?.() ?? 'main');
  });
}
