// S10 (docs/CHOICES.md): a pick-an-answer card under her question. One button per option (her
// recommended one first and marked), "Other, type it out" last (focuses the composer), and for
// multi-select toggle buttons (aria-pressed) with Send. A pick is sent as the person's own message
// (ctx.send). A closed card (answered, or a later message) keeps its buttons disabled with the pick
// marked. No imports: ctx brings t(), send() and other() (and `doc` in tests).

/** c: { question, options[{label, detail?}], multi, recommended?, answered? }; ctx: { open, t, send, other, doc? } */
export function choiceCard(c, ctx) {
  const doc = ctx.doc ?? document;
  const t = ctx.t;
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const card = el('div', `choice-card${c.multi ? ' multi' : ''}`);
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', c.question);
  const list = el('div', 'choice-opts');
  const picked = new Set();
  const answered = typeof c.answered === 'string' && !c.typed ? c.answered : '';
  const wasPicked = (label) => answered === label || (c.multi && answered.split(', ').includes(label));
  const buttons = [];
  let sendBtn = null;
  const finish = (text, chosen) => {
    for (const b of buttons) b.disabled = true;
    for (const b of chosen) b.classList.add('picked');
    card.classList.add('closed');
    ctx.send(text);
  };
  c.options.forEach((o, i) => {
    const b = el('button', `choice-opt${c.recommended === i ? ' rec' : ''}`);
    b.type = 'button';
    b.append(el('span', 'choice-label', `${o.label}${c.recommended === i ? ` ${t('(recommended)')}` : ''}`));
    if (o.detail) b.append(el('span', 'choice-detail', o.detail));
    if (c.multi) b.setAttribute('aria-pressed', 'false');
    if (wasPicked(o.label)) b.classList.add('picked');
    b.addEventListener('click', () => {
      if (!c.multi) return finish(o.label, [b]);
      if (picked.has(i)) picked.delete(i);
      else picked.add(i);
      b.setAttribute('aria-pressed', String(picked.has(i)));
      b.classList.toggle('on', picked.has(i));
      if (sendBtn) sendBtn.disabled = !picked.size;
    });
    buttons.push(b);
    list.append(b);
  });
  const other = el('button', 'choice-other ghost', t('Other, type it out'));
  other.type = 'button';
  other.addEventListener('click', () => ctx.other());
  buttons.push(other);
  list.append(other);
  card.append(list);
  if (c.multi) {
    sendBtn = el('button', 'choice-send', t('Send'));
    sendBtn.type = 'button';
    sendBtn.disabled = true;
    sendBtn.addEventListener('click', () => {
      const order = [...picked].sort((a, b) => a - b);
      finish(order.map((i) => c.options[i].label).join(', '), order.map((i) => buttons[i]));
    });
    buttons.push(sendBtn);
    card.append(sendBtn);
  }
  if (!ctx.open) {
    for (const b of buttons) b.disabled = true;
    card.classList.add('closed');
  }
  return card;
}
