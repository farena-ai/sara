// U4.25 (docs/EXTENSION.md): the background worker. Only the right-click menu lives here: "Ask Sara
// about the selected text" and "Save this page to Sara's Library". A click keeps what was asked for
// in session storage and opens the popup (or a small window where a browser can't open the popup
// from a menu); the popup does the work. Nothing runs on pages until you click.
import { B, isOff, loadConf, t } from './lib/common.js';

function menus() {
  B.contextMenus.removeAll(() => {
    B.contextMenus.create({ id: 'sara-ask-selection', title: t('menuAskSel'), contexts: ['selection'] });
    B.contextMenus.create({ id: 'sara-save-page', title: t('menuSave'), contexts: ['page'] });
  });
}
B.runtime.onInstalled.addListener(menus);
B.runtime.onStartup?.addListener(menus);

B.contextMenus.onClicked.addListener(async (info, tab) => {
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
