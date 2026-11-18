// U2.9 (docs/ANDROID.md): saving files inside the Android app. Its web view ignores <a download>, so
// links with a download attribute (Messages attachments, exports, backups) go to the app's bridge:
// this server's addresses to SaraPhone.saveFile (the app downloads them with its sign-in), blob: and
// data: exports to SaraPhone.saveData (read here, handed over as base64). Both land in Downloads/Sara.
// Other sites and plain links are left alone. Browsers and the iPhone app never load the hook.

export const BLOB_MAX = 25 * 1024 * 1024;

/** A safe file name: the last part only, no control or reserved characters. */
export function fileName(s) {
  const n = String(s ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*]+/g, '')
    .trim()
    .slice(0, 120);
  return n && n !== '.' && n !== '..' ? n : 'Sara file';
}

/** {href, download (null = no attribute)} → {kind: 'url' | 'blob', url, name} or null (not ours). */
export function saveTarget(a, origin) {
  if (a?.download == null) return null;
  const href = String(a.href ?? '');
  let u;
  try {
    u = new URL(href, origin);
  } catch {
    return null;
  }
  if (u.protocol === 'blob:' || u.protocol === 'data:') return { kind: 'blob', url: href, name: fileName(a.download) };
  if (!/^https?:$/.test(u.protocol) || u.origin !== origin) return null;
  let last = u.pathname.split('/').pop() ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {
    /* keep it as it is */
  }
  return { kind: 'url', url: u.href, name: fileName(a.download || last) };
}

const asBase64 = (blob) =>
  new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });

/** Wires the hook when the Android app's bridge is there; returns whether it did. */
export function installPhoneSave() {
  const phone = window.SaraPhone?.saveFile && window.SaraPhone.saveData ? window.SaraPhone : null;
  if (!phone) return false;
  const send = async (t) => {
    try {
      const blob = await (await fetch(t.url)).blob();
      if (blob.size > BLOB_MAX) return void phone.saveData('', t.name, 'too-big');
      phone.saveData(await asBase64(blob), t.name, blob.type || 'application/octet-stream');
    } catch {
      phone.saveData('', t.name, 'failed');
    }
  };
  const take = (a) => {
    const t = saveTarget({ href: a.getAttribute('href') === null ? '' : a.href, download: a.hasAttribute('download') ? a.getAttribute('download') : null }, location.origin);
    if (!t) return false;
    if (t.kind === 'url') phone.saveFile(t.url, t.name);
    else void send(t); // fetch starts now, before the page revokes the blob address
    return true;
  };
  // Clicks on links in the page (bubble phase: a handler that already took it, like the picture viewer, wins).
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[download]') : null;
    if (a && !e.defaultPrevented && take(a)) e.preventDefault();
  });
  // Exports that click a link that is not in the page (a.click() on a new element).
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.isConnected && this.hasAttribute('download') && take(this)) return;
    return click.call(this);
  };
  return true;
}
