let dictionary = {};
export const t = (text, values = {}) => (dictionary[text] || text).replace(/\{(\w+)\}/g, (match, key) => String(values[key] ?? match));
export async function initializeLanguage() {
  const language = sessionStorage.getItem('business-language') || 'en';
  if (language !== 'en') { const response = await fetch(`/i18n/${encodeURIComponent(language)}.json`); if (response.ok) dictionary = await response.json(); }
  document.documentElement.lang = language;
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest('[data-raw],script,style,code,pre,#language')) continue;
    const key = node.textContent.replace(/\s+/g, ' ').trim();
    if (key) node.textContent = node.textContent.replace(node.textContent.trim(), t(key));
  }
  for (const element of document.querySelectorAll('[aria-label],[placeholder]')) for (const attr of ['aria-label', 'placeholder']) if (element.hasAttribute(attr)) element.setAttribute(attr, t(element.getAttribute(attr)));
  document.querySelector('#language').value = language;
  document.querySelector('#language').onchange = event => { sessionStorage.setItem('business-language', event.target.value); location.reload(); };
  attachTips(document);
}
export function attachTips(root) {
  for (const control of root.querySelectorAll('[data-tip]')) {
    const label = control.closest('label'); if (!label || label.querySelector('.tip')) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tip'; button.textContent = '?'; button.setAttribute('aria-label', t('Help')); button.setAttribute('aria-expanded', 'false');
    const text = document.createElement('span'); text.className = 'tip-text'; text.textContent = t(control.dataset.tip); text.hidden = true; text.id = `${control.id}-tip`;
    button.setAttribute('aria-controls', text.id); control.setAttribute('aria-describedby', text.id);
    button.onclick = event => { event.preventDefault(); text.hidden = !text.hidden; button.setAttribute('aria-expanded', String(!text.hidden)); };
    label.append(button, text);
  }
}
