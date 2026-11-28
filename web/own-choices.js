// T62: while a second companion is open, the pages for models, thinking, edit checks and tool rules
// say whether these choices are hers alone or the main companion's she follows, with one button to
// follow the main companion's again (DELETE /api/companions/current/own?keys=…, owner only).

/** The settings each page edits (src/companions.ts INHERIT_KEYS). */
export const OWN_PAGES = {
  'models-default': ['defaultProviderId', 'defaultModel', 'modelAutoSwitch', 'thinking', 'lookFirst'],
  'models-routes': ['routes', 'autoJobs', 'defaultFallbacks', 'fallbackAfterSec'],
  'ab-tools': ['toolPermissions', 'mcpPolicy'],
  'ab-precise': ['precise'],
};

/**
 * Paints the line on `page` (nothing for the main companion). `reload` reads the page again after
 * her own choices are cleared.
 */
export async function paintOwnChoices(page, { api, t, reload }) {
  const keys = OWN_PAGES[page];
  const line = document.querySelector(`.settings-page[data-page="${page}"] [data-own-choices]`);
  if (!keys || !line) return;
  const d = await api('/companions/current/own').catch(() => null);
  if (!d || d.main) return void (line.hidden = true);
  const mine = keys.filter((k) => d.own.includes(k));
  const words = document.createElement('span');
  words.textContent = mine.length ? t('These choices are for {name} only.', { name: d.name }) : t("{name} uses your main companion's choices here.", { name: d.name });
  const parts = [words];
  if (mine.length && d.owner) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost small';
    b.textContent = t("Use {main}'s choices", { main: d.mainName });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/companions/current/own?keys=${mine.join(',')}`, { method: 'DELETE' });
        await reload?.();
        await paintOwnChoices(page, { api, t, reload });
      } catch (err) {
        b.disabled = false;
        words.textContent = err.message;
      }
    });
    parts.push(document.createTextNode(' '), b);
  }
  line.replaceChildren(...parts);
  line.hidden = false;
}
