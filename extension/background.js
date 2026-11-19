// U4.25 (docs/EXTENSION.md): the background worker. Only the right-click menu lives here: "Ask Sara
// about the selected text" and "Save this page to Sara's Library". A click keeps what was asked for
// in session storage and opens the popup (or a small window where a browser can't open the popup
// from a menu); the popup does the work. Nothing runs on pages until you click.
import { B, isOff, loadConf, t } from './lib/common.js';
import './lib/teach.js';

function menus() {
  if (!B.contextMenus) return; // Firefox for Android has no right-click menus
  B.contextMenus.removeAll(() => {
    B.contextMenus.create({ id: 'sara-ask-selection', title: t('menuAskSel'), contexts: ['selection'] });
    B.contextMenus.create({ id: 'sara-save-page', title: t('menuSave'), contexts: ['page'] });
  });
}
B.runtime.onInstalled.addListener(menus);
B.runtime.onStartup?.addListener(menus);

// D1 (docs/design/D1TEACH.md): Watch me do this. The recorder in the page sends each step here; they are
// kept in session storage (gone when the browser closes) for the one tab being watched, and the badge
// says REC. After a page load in that tab the recorder is put back, when the browser allows it.
const store = () => B.storage.session ?? B.storage.local;
let queue = Promise.resolve();
const withTeach = (fn) => (queue = queue.then(async () => {
  const { teach } = await store().get('teach');
  const next = await fn(teach);
  if (next !== undefined) await store().set({ teach: next });
}).catch(() => {}));

B.runtime.onMessage.addListener((msg, sender) => {
  if (!msg?.saraTeach || !sender.tab?.id) return;
  void withTeach(async (teach) => {
    if (!teach?.recording || teach.tabId !== sender.tab.id) return undefined;
    if (isOff((await loadConf()).offSites, sender.url || sender.tab.url)) return undefined; // off on this site: nothing kept
    globalThis.SaraTeach.addStep(teach.steps, msg.saraTeach);
    void B.action.setBadgeText({ text: 'REC', tabId: teach.tabId }).catch(() => {});
    return teach;
  });
});

B.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  void withTeach(async (teach) => {
    if (!teach?.recording || teach.tabId !== tabId) return undefined;
    void B.action.setBadgeText({ text: 'REC', tabId }).catch(() => {});
    try {
      await B.scripting.executeScript({ target: { tabId }, files: ['lib/fields.js', 'lib/teach.js'] });
      await B.scripting.executeScript({ target: { tabId }, func: () => globalThis.SaraTeach.start(document, (s) => (globalThis.browser ?? globalThis.chrome).runtime.sendMessage({ saraTeach: s })) });
      return { ...teach, paused: false };
    } catch {
      return { ...teach, paused: true }; // the browser didn't allow it here: the popup says so
    }
  });
});
B.tabs.onRemoved?.addListener((tabId) => void withTeach((teach) => (teach?.recording && teach.tabId === tabId ? { ...teach, recording: false } : undefined)));

B.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const conf = await loadConf();
  if (isOff(conf.offSites, tab.url)) return; // switched off on this site: the menu does nothing here
  const pending = { mode: info.menuItemId === 'sara-save-page' ? 'save' : 'ask', selection: String(info.selectionText ?? '').slice(0, 4000), tabId: tab.id, at: Date.now() };
  await (B.storage.session ?? B.storage.local).set({ pending });
  try {
    await B.action.openPopup();
  } catch {
    await B.windows.create({ url: B.runtime.getURL(`popup.html?tab=${tab.id}`), type: 'popup', width: 420, height: 640 });
  }
});
