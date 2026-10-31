// The hot-reload client: the dev server says "reload <file>" when a file changes.
(function () {
  var el = document.getElementById('hot');
  var ws = new WebSocket('ws://' + location.host + '/__hot');
  ws.onmessage = function (m) {
    var t = String(m.data);
    if (t === 'connected') el.textContent = 'Hot reload: connected';
    if (t.indexOf('reload') === 0) {
      sessionStorage.setItem('hot-reloaded', t);
      location.reload();
    }
  };
  ws.onerror = function () { el.textContent = 'Hot reload: failed'; };
  var last = sessionStorage.getItem('hot-reloaded');
  if (last) console.info('[hot] reloaded after ' + last);
})();
