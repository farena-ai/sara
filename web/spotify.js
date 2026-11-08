// C14 (docs/ops/C14_DESIGN.md): Settings → Connections → Spotify. The owner's own Spotify app
// (Client ID only, PKCE), what she may do (playlists, playback), Connect, status and Disconnect.
import { t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
let api = async () => null;

export async function loadSpotify() {
  const s = await api('/spotify').catch(() => null);
  if (!s || !$('#spo-status')) return;
  $('#spo-redirect').textContent = s.redirect;
  $('#spo-redirect-warn').hidden = s.redirectOk !== false;
  $('#spo-client-id').value = s.clientId ?? '';
  $('#spo-playlists').checked = s.options?.playlists === true;
  $('#spo-playback').checked = s.options?.playback === true;
  $('#spo-connected').hidden = !s.connected;
  $('#spo-forget').hidden = !s.configured;
  $('#spo-connect').disabled = !s.configured;
  $('#spo-connect').textContent = s.connected ? t('Connect again') : t('Connect Spotify');
  $('#spo-reconnect').hidden = !s.needsReconnect;
  if (s.connected) $('#spo-setup').open = false;
  const may = [t('search and look'), ...(s.canPlaylists ? [t('playlists (asks first)')] : []), ...(s.canPlayback ? [t('playback')] : [])].join(', ');
  $('#spo-status').textContent = s.connected
    ? s.name
      ? t('Connected as {name}. She may: {what}.', { name: s.name, what: may })
      : t('Connected. She may: {what}.', { what: may })
    : s.configured
      ? t('Your Spotify app is saved. Press "Connect Spotify".')
      : t('Not set up.');
}

async function saveOptions() {
  const body = { playlists: $('#spo-playlists').checked, playback: $('#spo-playback').checked };
  try {
    const clientId = $('#spo-client-id').value.trim();
    // Before an app is saved, the ticks are saved together with the Client ID.
    if (!$('#spo-forget').hidden) await api('/spotify/options', { method: 'PUT', body });
    else if (clientId) await api('/spotify/client', { method: 'PUT', body: { clientId, ...body } });
  } catch (err) {
    $('#spo-status').textContent = err.message;
    return;
  }
  loadSpotify();
}

export function initSpotify(apiFn) {
  api = apiFn;
  if (!$('#spo-status')) return;
  $('#spo-copy').addEventListener('click', () => navigator.clipboard?.writeText($('#spo-redirect').textContent));
  $('#spo-save').addEventListener('click', async () => {
    try {
      await api('/spotify/client', { method: 'PUT', body: { clientId: $('#spo-client-id').value.trim(), playlists: $('#spo-playlists').checked, playback: $('#spo-playback').checked } });
    } catch (err) {
      $('#spo-status').textContent = err.message;
      return;
    }
    loadSpotify();
  });
  $('#spo-playlists').addEventListener('change', saveOptions);
  $('#spo-playback').addEventListener('change', saveOptions);
  $('#spo-connect').addEventListener('click', async () => {
    try {
      const { url } = await api('/spotify/connect', { method: 'POST', body: {} });
      location.href = url;
    } catch (err) {
      $('#spo-status').textContent = err.message;
    }
  });
  $('#spo-disconnect').addEventListener('click', async () => {
    await api('/spotify', { method: 'DELETE' });
    loadSpotify();
  });
  $('#spo-forget').addEventListener('click', async () => {
    if (!confirm(t('Remove your Spotify app details from Sara? (You can add them again.)'))) return;
    await api('/spotify/client', { method: 'DELETE' });
    loadSpotify();
  });
  // Coming back from Spotify's sign-in page.
  const m = /^#spotify=(\w+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname);
    const msg = { connected: t('Spotify is connected. Try: "what am I listening to?"'), refused: t('Spotify sign-in was cancelled.'), failed: t("Spotify sign-in didn't work. Check the steps in Settings → Connections → Spotify and try again.") }[m[1]];
    if (msg) setTimeout(() => alert(msg), 600);
  }
}
