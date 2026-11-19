// V3.5 (docs/RECEPTION.md): the website receptionist's chat page (inside the iframe on the owner's site).
// Replies are drawn as text nodes only (never HTML); the visitor's words go only to this server.
// W3.5: replies come in the visitor's language; payment links the owner pasted show under the reply.
const root = document.querySelector('main.rc');
if (root) {
  const id = root.dataset.id;
  const token = root.dataset.t;
  const L = JSON.parse(root.dataset.strings || '{}');
  const theme = new URLSearchParams(location.search).get('theme');
  document.documentElement.dataset.theme = theme === 'light' || theme === 'dark' ? theme : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const log = root.querySelector('.rc-log');
  const ask = root.querySelector('.rc-ask');
  const q = ask.querySelector('textarea');
  const slotsBox = root.querySelector('.rc-slots');
  const bookForm = root.querySelector('.rc-book');
  const history = [];
  let slot = '';

  const say = (who, text, cls = '') => {
    const li = document.createElement('li');
    li.className = `rc-msg ${who === 'visitor' ? 'rc-you' : 'rc-her'} ${cls}`.trim();
    li.textContent = text;
    log.append(li);
    li.scrollIntoView({ block: 'end' });
    return li;
  };
  const post = async (path, body) => {
    const r = await fetch(`/reception/${encodeURIComponent(id)}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, t: token }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || L.error);
    return d;
  };
  const showSlots = (slots) => {
    slotsBox.replaceChildren();
    if (!slots?.length) {
      slotsBox.hidden = true;
      return;
    }
    const head = document.createElement('p');
    head.className = 'rc-sub';
    head.textContent = L.pick;
    slotsBox.append(head);
    for (const s of slots) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rc-slot';
      b.textContent = s.label;
      b.addEventListener('click', () => {
        slot = s.iso;
        for (const x of slotsBox.querySelectorAll('.rc-slot')) x.setAttribute('aria-pressed', String(x === b));
        bookForm.querySelector('.rc-when').textContent = s.label;
        bookForm.hidden = false;
        bookForm.scrollIntoView({ block: 'nearest' });
        bookForm.querySelector('input[name=name]').focus({ preventScroll: true });
      });
      slotsBox.append(b);
    }
    slotsBox.hidden = false;
    slotsBox.scrollIntoView({ block: 'start' });
  };

  // W3.5: the owner's payment links (https only), drawn as text links that open in a new tab.
  const showLinks = (li, links) => {
    const ul = document.createElement('ul');
    ul.className = 'rc-links';
    for (const l of links) {
      if (!/^https:\/\//.test(String(l.url))) continue;
      const a = document.createElement('a');
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l.label;
      const item = document.createElement('li');
      item.append(a);
      ul.append(item);
    }
    if (ul.children.length) li.append(ul);
    li.scrollIntoView({ block: 'end' });
  };

  ask.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text) return;
    q.value = '';
    say('visitor', text);
    const wait = say('her', L.wait, 'rc-wait');
    ask.querySelector('button[type=submit]').disabled = true;
    try {
      const d = await post('ask', { text, history: history.slice(-8) });
      wait.remove();
      const li = say('her', d.reply);
      history.push({ role: 'visitor', text }, { role: 'reply', text: d.reply });
      if (d.links?.length) showLinks(li, d.links);
      if (d.slots) showSlots(d.slots);
    } catch (err) {
      wait.remove();
      say('her', err.message, 'rc-err');
    } finally {
      ask.querySelector('button[type=submit]').disabled = false;
      q.focus();
    }
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask.requestSubmit();
    }
  });
  root.querySelector('.rc-book-open')?.addEventListener('click', async () => {
    try {
      const r = await fetch(`/reception/${encodeURIComponent(id)}/slots`);
      const d = await r.json();
      if (!d.slots?.length) return say('her', L.error);
      showSlots(d.slots);
    } catch {
      say('her', L.error, 'rc-err');
    }
  });
  bookForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(bookForm);
    const name = String(f.get('name') || '').trim();
    const email = String(f.get('email') || '').trim();
    if (!slot || !name || !email) return say('her', L.fill, 'rc-err');
    bookForm.querySelector('button[type=submit]').disabled = true;
    try {
      const d = await post('book', { slot, name, email, note: String(f.get('note') || ''), website: String(f.get('website') || '') });
      say('her', d.message, 'rc-ok');
      bookForm.hidden = true;
      bookForm.reset();
      slotsBox.hidden = true;
      slot = '';
    } catch (err) {
      say('her', err.message, 'rc-err');
    } finally {
      bookForm.querySelector('button[type=submit]').disabled = false;
    }
  });
}
