// fill_document (docs/DOCUMENTS.md): editing an Office file in place. A part is parsed with the
// Library's own forgiving XML reader, changed as a tree, and written back; every part she didn't
// change is copied byte for byte, so styles, pictures, macros-free extras and everything else in the
// person's file stay exactly as they were. No dependency: the zip reader and writer are Sara's own.
import { type Zip } from '../library/zip.ts';
import { localName, type XmlChild, type XmlElement } from '../library/xml.ts';
import { zipStored } from '../zip-write.ts';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** Characters XML 1.0 can't hold (control characters other than tab, newline and return). */
export const xmlSafe = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
const escText = (s: string) => xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

function write(el: XmlChild, out: string[]): void {
  if (typeof el === 'string') {
    out.push(escText(el));
    return;
  }
  out.push('<', el.name);
  for (const [k, v] of Object.entries(el.attrs)) out.push(' ', k, '="', escAttr(v), '"');
  if (!el.children.length) {
    out.push('/>');
    return;
  }
  out.push('>');
  for (const c of el.children) write(c, out);
  out.push('</', el.name, '>');
}

/** A parsed part (from parseXml) as UTF-8 XML text with its declaration. */
export function serializeXml(root: XmlElement): string {
  const out: string[] = [DECL];
  const kids = root.local === '#document' ? root.children : [root];
  // Whitespace before the root element isn't needed after the declaration.
  let started = false;
  for (const c of kids) {
    if (!started && typeof c === 'string' && !c.trim()) continue;
    started = true;
    write(c, out);
  }
  return out.join('');
}

/** A new element with the same namespace prefix as `like`. */
export function element(like: XmlElement | string, local: string, attrs: Record<string, string> = {}, children: XmlChild[] = []): XmlElement {
  const name = typeof like === 'string' ? like : like.name;
  const i = name.indexOf(':');
  return { name: i < 0 ? local : `${name.slice(0, i + 1)}${local}`, local, attrs, children };
}

/** A deep copy of an element. */
export function cloneEl(el: XmlElement): XmlElement {
  return { name: el.name, local: el.local, attrs: { ...el.attrs }, children: el.children.map((c) => (typeof c === 'string' ? c : cloneEl(c))) };
}

/** Sets an attribute by local name, keeping whatever prefix it already has. */
export function setAttr(el: XmlElement, local: string, value: string, prefixed?: string): void {
  for (const k of Object.keys(el.attrs)) if (localName(k) === local) {
    el.attrs[k] = value;
    return;
  }
  el.attrs[prefixed ?? local] = value;
}

export function removeAttr(el: XmlElement, local: string): void {
  for (const k of Object.keys(el.attrs)) if (localName(k) === local) delete el.attrs[k];
}

/** The same zip with some parts replaced (all others copied unchanged, in their original order). */
export function repack(zip: Zip, changed: Map<string, string | Buffer>): Buffer {
  const files: { path: string; data: Uint8Array }[] = [];
  const seen = new Set<string>();
  for (const e of zip.all) {
    if (e.name.endsWith('/') || seen.has(e.name)) continue;
    seen.add(e.name);
    const c = changed.get(e.name);
    files.push({ path: e.name, data: c === undefined ? zip.read(e.name) : typeof c === 'string' ? Buffer.from(c, 'utf8') : c });
  }
  for (const [path, c] of changed) if (!seen.has(path)) files.push({ path, data: typeof c === 'string' ? Buffer.from(c, 'utf8') : c });
  return zipStored(files, { deflate: true });
}
