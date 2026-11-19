// V3.5 (docs/RECEPTION.md): the website receptionist's loader. A website adds
//   <script src="https://<sara>/reception.js" data-sara="<widget id>" async></script>
// and gets a "Chat with us" button that opens Sara's chat page in an iframe. It never writes HTML into
// the host page, never reads it, and keeps no cookies: everything the visitor types goes to the iframe.
// Optional: data-label="Ask us", data-theme="light|dark|auto", data-side="left|right"; colors through
// the host page's CSS variables --sara-reception-bg / --sara-reception-fg.
(function () {
  var me = document.currentScript;
  if (!me) return;
  var id = me.getAttribute('data-sara') || '';
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(id) || document.getElementById('sara-reception-' + id)) return;
  var base = new URL(me.src, location.href).origin;
  var lang = String(navigator.language || 'en').toLowerCase();
  var LABELS = { es: 'Chatea con nosotros', fr: 'Discuter avec nous', de: 'Mit uns chatten', pt: 'Fale conosco', it: 'Chatta con noi' };
  var CLOSE = { es: 'Cerrar el chat', fr: 'Fermer le chat', de: 'Chat schließen', pt: 'Fechar o chat', it: 'Chiudi la chat' };
  var label = me.getAttribute('data-label') || LABELS[lang.slice(0, 2)] || 'Chat with us';
  var closeLabel = CLOSE[lang.slice(0, 2)] || 'Close the chat';
  var theme = me.getAttribute('data-theme') || 'auto';
  var side = me.getAttribute('data-side') === 'left' ? 'left' : 'right';

  var wrap = document.createElement('div');
  wrap.id = 'sara-reception-' + id;
  var ws = wrap.style;
  ws.position = 'fixed';
  ws.bottom = '20px';
  ws[side] = '20px';
  ws.zIndex = '2147483000';
  ws.display = 'flex';
  ws.flexDirection = 'column';
  ws.alignItems = side === 'left' ? 'flex-start' : 'flex-end';
  ws.gap = '10px';

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.setAttribute('aria-expanded', 'false');
  var bs = btn.style;
  bs.font = '600 15px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif';
  bs.padding = '12px 18px';
  bs.border = '0';
  bs.borderRadius = '999px';
  bs.cursor = 'pointer';
  bs.background = 'var(--sara-reception-bg, #2f6fdf)';
  bs.color = 'var(--sara-reception-fg, #fff)';
  bs.boxShadow = '0 6px 24px rgba(0, 0, 0, 0.25)';

  var frame;
  function open() {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.src = base + '/reception/' + encodeURIComponent(id) + '?theme=' + encodeURIComponent(theme);
      frame.title = label;
      frame.setAttribute('referrerpolicy', 'no-referrer');
      var fs = frame.style;
      fs.width = 'min(380px, calc(100vw - 24px))';
      fs.height = 'min(600px, calc(100vh - 110px))';
      fs.border = '0';
      fs.borderRadius = '16px';
      fs.boxShadow = '0 12px 40px rgba(0, 0, 0, 0.3)';
      fs.background = 'transparent';
      wrap.insertBefore(frame, btn);
    }
    frame.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    btn.textContent = '✕';
    btn.setAttribute('aria-label', closeLabel);
  }
  function close() {
    if (frame) frame.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = label;
    btn.removeAttribute('aria-label');
  }
  btn.addEventListener('click', function () {
    if (btn.getAttribute('aria-expanded') === 'true') close();
    else open();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && btn.getAttribute('aria-expanded') === 'true') close();
  });
  wrap.appendChild(btn);
  (document.body || document.documentElement).appendChild(wrap);
})();
