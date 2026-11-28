import { fail } from '../util/errors.js';

/**
 * R37 to R39: splits body rows into pages.
 * frame(first) returns { before: string[], after: string[] } for a page; rowRule is the line
 * placed between two rows (or null); rows is an array of line arrays.
 */
export function paginate({ rows, frame, rowRule, pageHeight }) {
  const pages = [];
  let page = null;
  const open = () => {
    if (page) pages.push(page);
    const f = frame(pages.length === 0);
    const room = pageHeight === undefined ? Infinity : pageHeight - f.before.length - f.after.length;
    if (room < 1) fail('the page is too small for the table frame');
    page = { frame: f, body: [], used: 0, rows: 0, room };
  };
  open();
  const ruleCost = rowRule === null ? 0 : 1;
  for (const lines of rows) {
    let rest = lines;
    if (page.rows > 0 && page.used + ruleCost + rest.length > page.room) open();
    for (;;) {
      if (page.rows > 0 && rowRule !== null) {
        page.body.push(rowRule);
        page.used++;
      }
      const room = page.room - page.used;
      if (rest.length <= room) {
        page.body.push(...rest);
        page.used += rest.length;
        page.rows++;
        break;
      }
      page.body.push(...rest.slice(0, room));
      page.used += room;
      page.rows++;
      rest = rest.slice(room);
      open();
    }
  }
  pages.push(page);
  return pages.map((p) => [...p.frame.before, ...p.body, ...p.frame.after]);
}
