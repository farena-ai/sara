// V2.3 (docs/design/V2HOME.md): Settings → Home Assistant: Find it for me (mDNS), Test token (nothing
// saved) and Say it to start (scenes and scripts as voice routines). No imports: app.js lends
// { t, api, $ } through wireHomeVoice, so tests can load this file on its own.
let ctx;

/** The words a found server shows in the picker. */
export function foundLabel(f) {
  return `${f.name || 'Home Assistant'} · ${f.url}${f.version ? ` · ${f.version}` : ''}`;
}

/** One line for a Test token answer (English keys; the caller translates through t). */
export function testLine(r, t = (s, p) => (p ? s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? '')) : s)) {
  if (!r?.ok) return r?.error ? t(r.error) : t('It did not answer.');
  return t('Token works: {name} (Home Assistant {version}), {scenes} scenes and {scripts} scripts. Press Save and test to keep it.', { name: r.name || t('your home'), version: r.version || '?', scenes: r.scenes ?? 0, scripts: r.scripts ?? 0 });
}

function draw(items) {
  const { t, $ } = ctx;
  const list = $('#ha-voice-list');
  list.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = t('Home Assistant has no scenes or scripts yet.');
    list.append(li);
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'ha-voice-item';
    li.dataset.id = it.id;
    const box = document.createElement('label');
    box.className = 'row';
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = it.on;
    on.disabled = !it.pickable;
    on.setAttribute('aria-label', t('Start {name} by voice', { name: it.name }));
    const name = document.createElement('span');
    name.textContent = `${it.name} `;
    const kind = document.createElement('small');
    kind.className = 'muted';
    kind.textContent = it.id.startsWith('script.') ? t('a script') : t('a scene');
    name.append(kind);
    box.append(on, name);
    const say = document.createElement('input');
    say.type = 'text';
    say.maxLength = 60;
    say.value = it.say;
    say.disabled = !it.pickable;
    say.setAttribute('aria-label', t('Words to say for {name}', { name: it.name }));
    li.append(box, say);
    if (!it.pickable) {
      const why = document.createElement('small');
      why.className = 'muted ha-voice-why';
      why.textContent = t('Always asks you: locks, doors and alarms can’t start by voice.');
      li.append(why);
    }
    list.append(li);
  }
}

export async function loadHomeVoice() {
  if (!ctx) return;
  const { api, $ } = ctx;
  const h = await api('/home').catch(() => ({}));
  const connected = Boolean(h.url && h.hasToken);
  $('#ha-voice-off').hidden = connected;
  $('#ha-voice').hidden = !connected;
  if (!connected) return;
  try {
    draw((await api('/home/voice')).items ?? []);
    $('#ha-voice-status').textContent = '';
  } catch (err) {
    $('#ha-voice-status').textContent = err.message;
  }
}

export function wireHomeVoice(c) {
  ctx = c;
  const { t, api, $ } = c;
  $('#ha-find')?.addEventListener('click', async () => {
    const pick = $('#ha-found');
    $('#ha-status').textContent = t('Looking on your home network…');
    pick.hidden = true;
    let found = [];
    try {
      found = (await api('/home/discover')).found ?? [];
    } catch (err) {
      $('#ha-status').textContent = err.message;
      return;
    }
    if (!found.length) {
      $('#ha-status').textContent = t('No Home Assistant answered on this network. Type its address instead (it may be on another network, or mDNS is blocked).');
      return;
    }
    $('#ha-url').value = found[0].url;
    pick.replaceChildren(...found.map((f) => new Option(foundLabel(f), f.url)));
    pick.hidden = found.length < 2;
    $('#ha-status').textContent = t('Found {name}. Paste a token, then press Test token.', { name: found[0].name || 'Home Assistant' });
    $('#ha-token').focus();
  });
  $('#ha-found')?.addEventListener('change', (e) => {
    $('#ha-url').value = e.target.value;
  });
  $('#ha-test')?.addEventListener('click', async () => {
    $('#ha-status').textContent = t('Checking…');
    try {
      const r = await api('/home/test', { method: 'POST', body: { url: $('#ha-url').value.trim(), token: $('#ha-token').value.trim() } });
      $('#ha-status').textContent = testLine(r, t);
    } catch (err) {
      $('#ha-status').textContent = err.message;
    }
  });
  $('#ha-voice-save')?.addEventListener('click', async () => {
    const items = [...$('#ha-voice-list').querySelectorAll('.ha-voice-item')]
      .filter((li) => li.querySelector('input[type=checkbox]')?.checked)
      .map((li) => ({ id: li.dataset.id, say: li.querySelector('input[type=text]').value.trim() }));
    $('#ha-voice-status').textContent = t('Saving…');
    try {
      draw((await api('/home/voice', { method: 'PUT', body: { items } })).items ?? []);
      $('#ha-voice-status').textContent = items.length ? t('Saved. Say the words in Talk with Sara, car mode or a call.') : t('Saved. None start by voice.');
    } catch (err) {
      $('#ha-voice-status').textContent = err.message;
    }
  });
}
