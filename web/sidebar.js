// The responsive drawer uses the same breakpoint as style.css. Hidden controls must not
// remain in the keyboard/accessibility tree merely because CSS slid them off screen.
export function initSidebar({ main, sidebar, toggle, close, scrim, document: doc = document, media = window.matchMedia('(max-width: 760px)') }) {
  let opener = toggle;
  const sync = () => {
    sidebar.inert = media.matches && !main.classList.contains('show-sidebar');
    toggle.setAttribute('aria-expanded', String(media.matches && !sidebar.inert));
  };
  const shut = ({ restoreFocus = true } = {}) => {
    main.classList.remove('show-sidebar');
    if (media.matches && restoreFocus && !doc.querySelector('dialog[open]:not(#today)')) (opener?.isConnected === false ? toggle : opener).focus();
    sync();
  };
  const open = ({ focus = true } = {}) => {
    opener = doc.activeElement && !sidebar.contains(doc.activeElement) ? doc.activeElement : toggle;
    main.classList.add('show-sidebar');
    sync();
    if (media.matches && focus) close.focus();
  };
  toggle.addEventListener('click', () => main.classList.contains('show-sidebar') ? shut() : open());
  close.addEventListener('click', () => shut());
  scrim.addEventListener('click', () => shut());
  sidebar.addEventListener('click', (e) => {
    if (media.matches && e.target.closest?.('.side-go, #brand-today, #new-chat, #new-offrecord, #new-project, #new-group, #open-sara, #open-help, #open-settings, #side-update')) shut({ restoreFocus: false });
  }, true);
  doc.addEventListener('keydown', (e) => {
    if (!media.matches || !main.classList.contains('show-sidebar') || doc.querySelector('dialog[open]:not(#today)')) return;
    if (e.key === 'Tab') {
      const items = [...sidebar.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
      const first = items[0] ?? close;
      const last = items.at(-1) ?? close;
      if (e.shiftKey && (doc.activeElement === first || !sidebar.contains(doc.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (doc.activeElement === last || !sidebar.contains(doc.activeElement))) {
        e.preventDefault(); first.focus();
      }
    }
    if (e.key === 'Escape') {
      if (doc.querySelector('#side-more-menu:not([hidden])')) return;
      e.preventDefault();
      shut();
    }
  });
  media.addEventListener('change', () => {
    // Crossing back to mobile always starts closed, avoiding stale drawer state.
    main.classList.remove('show-sidebar');
    if (media.matches && sidebar.contains(doc.activeElement)) toggle.focus();
    sync();
  });
  sync();
  return { open, close: shut };
}
