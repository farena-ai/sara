// 2.8 polish pass (docs/design/NEW_LOOK.md → "Polish pass"): one hand-made line-icon set for the app's
// chrome (sidebar places, the bottom bar, header buttons, the composer, the command bar, Today's tile
// headers, step lines, result cards and approval cards), instead of emoji. Every icon is drawn on a
// 24 x 24 grid with 1.75 px round strokes in currentColor, so it takes the text colour of its button in
// Night and Day. Emoji stay in what you and she write, and where they mean something to people.
//
//   icon('mic')                 → a new <svg class="ic"> (aria-hidden; the button keeps its own label)
//   setIcon(button, 'speaker')  → puts that icon first in an element, replacing an earlier one
//   paintIcons(document)        → fills every <i data-icon="name"> of the page (index.html uses these)
//
// No DOM work at import time, so the map and the helpers can be checked in Node.

const NS = 'http://www.w3.org/2000/svg';

/** name → the SVG's inner markup (paths, circles, rects on a 24 x 24 grid; no colours, no fills). */
export const ICONS = {
  // Places
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  planner: '<rect x="4" y="4.5" width="16" height="16" rx="2.5"/><path d="M8 2.5v4M16 2.5v4M8.5 12.5l2.2 2.2 4.8-4.8"/>',
  memory: '<path d="M12 20.5s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.5c0 5.8-7.5 10.4-7.5 10.4z"/><path d="M9.5 12h5M12 9.5v5"/>',
  library: '<path d="M4.5 19V5.5a2 2 0 0 1 2-2h3.5v17.5H6.5a2 2 0 0 1-2-2z"/><path d="M10 3.5h4v17.5h-4z"/><path d="M15.6 4.4l3.7-.9 2.8 15.9-3.7.9z"/>',
  scrapbook: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10.5" r="1.8"/><path d="M20.5 16.5l-4.8-4.8-8.2 8.3"/>',
  moments: '<rect x="6.5" y="3.5" width="14" height="12.5" rx="2"/><path d="M3.5 7.5v11.5a2 2 0 0 0 2 2h11.5"/><path d="M6.5 13l3.8-3.8 3 3 2-2 5.2 5.2"/><circle cx="16" cy="7.6" r="1.2"/>',
  story: '<path d="M6 3.5v17"/><circle cx="6" cy="7" r="2"/><circle cx="6" cy="17" r="2"/><path d="M10.5 7h9.5M10.5 17h7M10.5 12h5"/>',
  team: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.4"/><path d="M3.5 20c0-3.2 2.5-5.8 5.5-5.8s5.5 2.6 5.5 5.8M15.2 14.6c.5-.2 1.1-.3 1.8-.3 2.6 0 3.8 1.9 3.8 4.7"/>',
  more: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  chat: '<path d="M20 11.6a8 8 0 0 1-11.6 7.2L4 20l1.1-4.2A8 8 0 1 1 20 11.6z"/>',
  her: '<circle cx="12" cy="9" r="4"/><path d="M4.5 20.5c.8-3.6 3.9-6 7.5-6s6.7 2.4 7.5 6"/>',
  // Header and sidebar buttons
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.8M12 17.2v.1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.2 14.8a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1h-.1a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M14.5 4.5v15"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
  'chevron-down': '<path d="M6 9.5l6 6 6-6"/>',
  back: '<path d="M19 12H5.5M11 5.5L4.5 12l6.5 6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pin: '<path d="M9 3.5h6l-1 5.5 4 4H6l4-4-1-5.5zM12 13v7.5"/>',
  switch: '<path d="M4 8h14.5M15 4.5L18.5 8 15 11.5M20 16H5.5M9 12.5L5.5 16 9 19.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2"/>',
  server: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7 7.25h.01M7 16.75h.01M11 7.25h6M11 16.75h6"/>',
  project: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11.5v5M9.5 14h5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  offrecord: '<path d="M3 12s3.3-6 9-6c1.6 0 3 .5 4.2 1.1M21 12s-3.3 6-9 6c-1.6 0-3-.5-4.2-1.1"/><path d="M9.9 14.1a3 3 0 0 1 4.2-4.2"/><path d="M4 20L20 4"/>',
  group: '<circle cx="8.5" cy="8.5" r="3"/><circle cx="16.5" cy="8.5" r="3"/><path d="M2.5 19.5c.5-3 3-5 6-5s5.5 2 6 5M13.4 14.9c.9-.3 1.9-.4 3.1-.4 3 0 5.5 2 6 5"/>',
  edit: '<path d="M4 20h4L19.3 8.7a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 7.5l2.9 2.9"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.2A8 8 0 1 1 9.8 4a6.5 6.5 0 0 0 10.2 10.2z"/>',
  heart: '<path d="M12 20.5s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.5c0 5.8-7.5 10.4-7.5 10.4z"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  // The composer and calls
  send: '<path d="M12 19V5.5M5.5 11.5L12 5l6.5 6.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  'mic-off': '<path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11c0 .8-.1 1.5-.4 2.2M12 17.5V21M8.5 21h7M4 4l16 16"/>',
  phone: '<path d="M8.6 3.5H5.8a1.8 1.8 0 0 0-1.8 2c.6 7.8 6.7 13.9 14.5 14.5a1.8 1.8 0 0 0 2-1.8v-2.8l-4.1-1.7-2 2a12 12 0 0 1-5.6-5.6l2-2z"/>',
  'phone-end': '<path d="M3.2 13.6l-.2-1.9c-.1-1.1.6-2.1 1.7-2.4 4.7-1.3 9.9-1.3 14.6 0 1.1.3 1.8 1.3 1.7 2.4l-.2 1.9-4.3.8-.6-2.7a12 12 0 0 0-7.8 0l-.6 2.7z"/>',
  video: '<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="M15.5 10.5l5.5-3.2v9.4l-5.5-3.2z"/>',
  camera: '<path d="M4 8.5a2 2 0 0 1 2-2h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>',
  'speaker-on': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>',
  'speaker-off': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  captions: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M10.5 10.3a2.2 2.2 0 1 0 0 3.4M17 10.3a2.2 2.2 0 1 0 0 3.4"/>',
  minimize: '<path d="M14 10l6.5-6.5M14 10V5M14 10h5M10 14l-6.5 6.5M10 14v5M10 14H5"/>',
  attach: '<path d="M20 11.5l-7.7 7.7a5 5 0 0 1-7.1-7.1l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-4.5-4.5-9 8"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01"/>',
  // What she does (step lines, result cards, approvals)
  weather: '<path d="M7.5 7.8a3.6 3.6 0 0 1 6.4-1.6M10.7 2.8v1.3M4.6 5.3l.9.9M3.2 10h1.3"/><path d="M7.5 20h9.5a3.6 3.6 0 0 0 .6-7.1 5.2 5.2 0 0 0-10-.7A3.9 3.9 0 0 0 7.5 20z"/>',
  reminder: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.8M4.5 4.5l2.5-2M19.5 4.5l-2.5-2"/>',
  todo: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.5 12.2l2.4 2.4 4.8-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  note: '<path d="M6 3.5h8.5l3.5 3.5v13.5H6z"/><path d="M14 3.5V7.5h4M9 12h6M9 15.5h6"/>',
  recall: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4.5h4.5M12 8v4.3l3 1.7"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M4 10h16M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>',
  file: '<path d="M6 3.5h8.5l3.5 3.5v13.5H6z"/><path d="M14 3.5V7.5h4"/>',
  'file-edit': '<path d="M13.5 20.5H6v-17h8.5L18 7v4"/><path d="M14 3.5V7.5h4M14.5 20.5v-2.2l4.6-4.6a1.6 1.6 0 0 1 2.2 2.2l-4.6 4.6z"/>',
  files: '<path d="M8 6.5V5a1.5 1.5 0 0 1 1.5-1.5h6L20 8v9.5a1.5 1.5 0 0 1-1.5 1.5H17"/><path d="M4 8a1.5 1.5 0 0 1 1.5-1.5h6L16 11v8.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 19.5z"/>',
  home: '<path d="M3.5 11L12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5M10 20v-5.5h4V20"/>',
  photo: '<path d="M4 8.5a2 2 0 0 1 2-2h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  job: '<path d="M7 3.5h10M7 20.5h10M8 3.5c0 4 8 4.5 8 8.5s-8 4.5-8 8.5M16 3.5c0 2-1.4 3.2-3 4.3M8 20.5c0-1.6 1.6-2.6 4-3.1 2.4.5 4 1.5 4 3.1"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  branch: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="8" r="2"/><path d="M6.5 7.5v9M17.5 10c0 4-5 3.5-9.5 7"/>',
  book: '<path d="M4.5 5.5c2.5-1.3 5-1.3 7.5 0v14c-2.5-1.3-5-1.3-7.5 0zM12 5.5c2.5-1.3 5-1.3 7.5 0v14c-2.5-1.3-5-1.3-7.5 0z"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>',
  flask: '<path d="M9.5 3.5h5M10 3.5v6L4.8 18a1.7 1.7 0 0 0 1.5 2.5h11.4a1.7 1.7 0 0 0 1.5-2.5L14 9.5v-6"/><path d="M7.5 14.5h9"/>',
  update: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5v4h-4M12 16.5v-8M8.8 11.5L12 8.3l3.2 3.2"/>',
  package: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9M8 5.2l8 4.6"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L20 11a4.5 4.5 0 0 1-5.6 5.6L7.5 21.5a2.1 2.1 0 0 1-3-3l4.9-6.9A4.5 4.5 0 0 1 15 6z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  // Phase 81: the security pass and findings (a shield with a check).
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12.2l2.3 2.3 4.3-4.6"/>',
  // Phase 79: budgets (a half-dial with its needle).
  sandbox: '<rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3 2.5"/><path d="M12 7.5l4.5 2.5v5L12 17.5 7.5 15v-5z"/><path d="M7.5 10l4.5 2.5 4.5-2.5M12 12.5v5"/>',
  gauge: '<path d="M4 16.5a8 8 0 0 1 16 0"/><path d="M12 16.5l4-5"/><path d="M4 19.5h16"/>',
  shirt: '<path d="M8.5 3.5L4 6l1.5 4.5 2-.8V20.5h9V9.7l2 .8L20 6l-4.5-2.5c-.4 1.5-1.8 2.5-3.5 2.5S8.9 5 8.5 3.5z"/>',
  puzzle: '<path d="M10 4.5a2 2 0 0 1 4 0V6h4.5v4.5H17a2 2 0 0 0 0 4h1.5V19H14v-1.5a2 2 0 0 0-4 0V19H5.5v-4.5H7a2 2 0 0 0 0-4H5.5V6H10z"/>',
  pointer: '<path d="M5 4l13.5 6-5.8 1.8L11 17.5z"/><path d="M13 12l5 5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  memo: '<path d="M5.5 4.5h13v15h-13z"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  promise: '<path d="M3.5 12.5l4-4 3 1.5 3-3 3 1L20.5 12"/><path d="M7.5 8.5l5.5 5.5a1.5 1.5 0 0 1-2.1 2.1L8.5 13.7M10.5 16.5l1 1a1.5 1.5 0 0 0 2.1-2.1"/>',
  warn: '<path d="M10.3 4.3L2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.2v.1"/>',
  tool: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2L18 18M6 18l1.8-1.8M16.2 7.8L18 6"/>',
  dot: '<circle cx="12" cy="12" r="2.5"/>',
};

/** A new icon element, or null for a name that isn't in the set. */
export function icon(name, cls = '') {
  const inner = ICONS[name];
  if (inner === undefined || typeof document === 'undefined' || typeof DOMParser === 'undefined') return null;
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.75');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('class', `ic${cls ? ` ${cls}` : ''}`);
  s.dataset.icon = name;
  // The markup is our own constant above (never data), parsed as SVG.
  const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${inner}</svg>`, 'image/svg+xml');
  s.append(...[...doc.documentElement.childNodes].map((n) => document.importNode(n, true)));
  return s;
}

/** Puts the icon first in `node` (a button, a span), replacing the icon it had. */
export function setIcon(node, name) {
  if (!node) return;
  const old = node.querySelector(':scope > svg.ic, :scope > i[data-icon]');
  const svg = icon(name);
  if (!svg) return;
  if (old) old.replaceWith(svg);
  else node.prepend(svg);
}

/** Fills every <i data-icon="name"> placeholder under `root` with its icon (index.html's buttons). */
export function paintIcons(root = document) {
  for (const i of root.querySelectorAll('i[data-icon]')) {
    const svg = icon(i.dataset.icon, i.className.replace(/(^|\s)ic(\s|$)/, ' ').trim());
    if (svg) i.replaceWith(svg);
  }
}

/** The icon name for one of her tools (approval cards, the Tools list, old tool rows). */
export const TOOL_ICONS = {
  remind: 'reminder', todo: 'todo', note: 'note', recall: 'recall', web_search: 'search', web_fetch: 'globe',
  calendar: 'calendar', calendar_add: 'calendar', calendar_events: 'calendar', email: 'mail', gmail_search: 'mail',
  gmail_thread: 'mail', gmail_needs_answer: 'mail', gmail_organize: 'archive', gmail_undo: 'undo', gmail_labels: 'mail', gmail_senders: 'mail', gmail_unsubscribe_info: 'mail', home_control: 'home', home_status: 'home', ssh_servers: 'server',
  ssh_connect: 'server', ssh_run: 'server', ssh_forget_password: 'server', ssh_revoke_key: 'server', ssh_remove_server: 'server',
  take_photo: 'photo', share_photo: 'photo', change_outfit: 'shirt', scrapbook: 'scrapbook', shared_list: 'dice',
  settings_guide: 'help', tune_personality: 'sliders', team_task: 'team', work_on_issue: 'team', start_job: 'job',
  project_note: 'note', preview_start: 'monitor', preview_stop: 'monitor', browser_open: 'compass', browser_screenshot: 'camera',
  browser_click: 'pointer', browser_type: 'keyboard', browser_read: 'compass', browser_check: 'check', moments: 'moments',
  pc_devices: 'monitor', pc_browser_open: 'monitor', pc_browser_navigate: 'monitor', pc_browser_look: 'eye', pc_look: 'eye', pc_windows: 'monitor', pc_click: 'monitor', pc_type: 'monitor', pc_keys: 'monitor', pc_scroll: 'monitor', pc_drag: 'monitor', pc_open_app: 'monitor', pc_browser_read: 'monitor', pc_browser_tabs: 'monitor', pc_browser_logs: 'monitor', pc_browser_request: 'monitor',
  read_file: 'file', write_file: 'file-edit', edit_file: 'file-edit', list_dir: 'folder', search: 'search', shell: 'terminal',
  docs: 'book', library_search: 'book',
  board_list: 'todo', card_add: 'todo', card_move: 'todo', card_comment: 'note', card_ask: 'todo', card_assign: 'team',
};
