#!/usr/bin/env node
// Sara move-in collector, Node edition (docs/design/MOVE_IN.md section 4). The same collector as
// sara-movein.py, for computers that have Node but no Python (OpenClaw runs on Node): it finds your old
// agent (Hermes Agent or OpenClaw), packs what Sara can bring over into ONE .saramove file, and can send
// it straight to your Sara. Same bundle for the same input (test/movein-node.test.ts checks it).
//
// What it does, in plain words:
//   * It only READS. Files are opened read-only, SQLite databases read-only (node:sqlite, Node 22.5+);
//     the only file it creates is the bundle (a temporary name beside it, then renamed).
//   * It never opens secrets (.env, auth.json, credentials/, keys, browser profiles...): skipped by name.
//   * Config values that look secret are replaced; secret-shaped text is replaced by «secret removed».
//   * It looks only at the folders that hold the companion; program files, caches, installs and
//     environments are named in the plan, never walked. Links and junctions are never followed.
//   * No network, except `send` / --send-to (an upload to YOUR Sara).
//
//   node sara-movein.mjs [collect] [options]   find the agent, show the plan, write the bundle
//   node sara-movein.mjs collect --plan-only    only show the plan (writes nothing)
//   node sara-movein.mjs verify FILE            re-check every hash in a bundle
//   node sara-movein.mjs send FILE --to https://your-sara --code "six words from the page"
//
// Node 18 or newer, no installs. Databases need Node 22.5+ (node:sqlite).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '3.6.2';
const FORMAT = 'saramove';
const FORMAT_VERSION = 1;
const MiB = 1024 * 1024;
const MAX_TEXT_FILE = 1 * MiB;
const MAX_CODE_FILE = 512 * 1024;
const MAX_CELL_TEXT = 256 * 1024;
const ROWS_PART_BYTES = 64 * MiB;
const SAMPLE_ROWS = 5;
const DATED_HISTORY_KEEP = 3;
let SECTION_FILES = 20000;
const SECTION_SECONDS = 30;
const PEEK_ENTRIES = 400;

const WORDS = { "title": ["Sara move-in collector {v}  (read-only: nothing here will be changed)", "Recolector de mudanza de Sara {v}  (solo lectura: aquí no se cambia nada)", "Collecteur de déménagement de Sara {v}  (lecture seule : rien ne sera modifié ici)", "Sara-Umzugssammler {v}  (nur lesen: hier wird nichts verändert)", "Coletor de mudança da Sara {v}  (só leitura: nada aqui será alterado)", "Raccoglitore per il trasloco di Sara {v}  (sola lettura: qui non verrà cambiato nulla)"], "found": ["Found", "Encontrado", "Trouvé", "Gefunden", "Encontrado", "Trovato"], "personality": ["Personality", "Personalidad", "Personnalité", "Persönlichkeit", "Personalidade", "Personalità"], "memories": ["Memories", "Recuerdos", "Souvenirs", "Erinnerungen", "Memórias", "Ricordi"], "sessions": ["Sessions", "Sesiones", "Sessions", "Sitzungen", "Sessões", "Sessioni"], "skills": ["Skills", "Habilidades", "Compétences", "Fähigkeiten", "Habilidades", "Abilità"], "schedules": ["Schedules", "Programaciones", "Planifications", "Zeitpläne", "Agendamentos", "Programmazioni"], "board": ["Board", "Tablero", "Tableau", "Board", "Quadro", "Bacheca"], "code": ["Hooks/plugins", "Hooks/plugins", "Hooks/plugins", "Hooks/Plugins", "Hooks/plugins", "Hook/plugin"], "stores": ["Plugin stores", "Almacenes de plugins", "Bases des plugins", "Plugin-Datenbanken", "Bancos de plugins", "Archivi dei plugin"], "config": ["Config", "Configuración", "Configuration", "Einstellungen", "Configuração", "Configurazione"], "skipped": ["Skipped", "Omitido", "Ignoré", "Übersprungen", "Ignorado", "Saltato"], "secrets": ["Secrets", "Secretos", "Secrets", "Geheimnisse", "Segredos", "Segreti"], "logs": ["Logs", "Registros", "Journaux", "Protokolle", "Logs", "Log"], "media": ["Media/models", "Multimedia/modelos", "Médias/modèles", "Medien/Modelle", "Mídia/modelos", "Media/modelli"], "backups": ["Backups", "Copias", "Sauvegardes", "Sicherungen", "Backups", "Backup"], "codeenv": ["Code/envs", "Código/entornos", "Code/environnements", "Code/Umgebungen", "Código/ambientes", "Codice/ambienti"], "telemetry": ["Telemetry", "Telemetría", "Télémétrie", "Telemetrie", "Telemetria", "Telemetria"], "other": ["Not understood", "No entendido", "Non compris", "Nicht verstanden", "Não entendido", "Non capito"], "never_opened": ["never opened", "nunca abiertos", "jamais ouverts", "nie geöffnet", "nunca abertos", "mai aperti"], "pack": ["pack", "empaquetar", "emballer", "einpacken", "empacotar", "impacchettare"], "skip": ["skip", "omitir", "ignorer", "überspringen", "ignorar", "saltare"], "sensitive": ["Sensitive (off until you say yes)", "Sensible (desactivado hasta que digas que sí)", "Sensible (désactivé tant que vous ne dites pas oui)", "Sensibel (aus, bis du Ja sagst)", "Sensível (desligado até você dizer sim)", "Sensibile (spento finché non dici di sì)"], "medical": ["Health/medical", "Salud/medicina", "Santé/médical", "Gesundheit/Medizin", "Saúde/médico", "Salute/medicina"], "intimate": ["Intimate", "Íntimo", "Intime", "Intim", "Íntimo", "Intimo"], "finances": ["Finances", "Finanzas", "Finances", "Finanzen", "Finanças", "Finanze"], "none_found": ["none found", "nada encontrado", "rien trouvé", "nichts gefunden", "nada encontrado", "niente trovato"], "include_q": ["Include {what} items? [y/N] ", "¿Incluir elementos de {what}? [s/N] ", "Inclure les éléments {what} ? [o/N] ", "{what}-Elemente einpacken? [j/N] ", "Incluir itens de {what}? [s/N] ", "Includere gli elementi {what}? [s/N] "], "continue_q": ["Continue? [Y/n] ", "¿Continuar? [S/n] ", "Continuer ? [O/n] ", "Weiter? [J/n] ", "Continuar? [S/n] ", "Continuare? [S/n] "], "bundle": ["Bundle", "Paquete", "Paquet", "Paket", "Pacote", "Pacchetto"], "diary": ["This file is as private as your diary: delete it after the move-in.", "Este archivo es tan privado como tu diario: bórralo después de la mudanza.", "Ce fichier est aussi privé que votre journal : supprimez-le après le déménagement.", "Diese Datei ist so privat wie dein Tagebuch: lösche sie nach dem Umzug.", "Este arquivo é tão privado quanto seu diário: apague-o depois da mudança.", "Questo file è privato come il tuo diario: cancellalo dopo il trasloco."], "plan_only": ["Plan only: no bundle written.", "Solo el plan: no se escribió ningún paquete.", "Plan seulement : aucun paquet écrit.", "Nur der Plan: kein Paket geschrieben.", "Só o plano: nenhum pacote gravado.", "Solo il piano: nessun pacchetto scritto."], "written": ["Written", "Escrito", "Écrit", "Geschrieben", "Gravado", "Scritto"], "nothing": ["No Hermes Agent home or OpenClaw state folder was found. Point at it with --hermes-home PATH or --openclaw-state PATH.", "No se encontró ninguna carpeta de Hermes Agent ni de OpenClaw. Indícala con --hermes-home RUTA o --openclaw-state RUTA.", "Aucun dossier Hermes Agent ou OpenClaw trouvé. Indiquez-le avec --hermes-home CHEMIN ou --openclaw-state CHEMIN.", "Kein Hermes-Agent- oder OpenClaw-Ordner gefunden. Gib ihn mit --hermes-home PFAD oder --openclaw-state PFAD an.", "Nenhuma pasta do Hermes Agent ou do OpenClaw encontrada. Indique-a com --hermes-home CAMINHO ou --openclaw-state CAMINHO.", "Nessuna cartella di Hermes Agent o OpenClaw trovata. Indicala con --hermes-home PERCORSO o --openclaw-state PERCORSO."] };
const LANGS = ['en', 'es', 'fr', 'de', 'pt-BR', 'it'];
let LANG = 0;
const w = (key, kw) => {
  const s = WORDS[key][LANG];
  return kw ? s.replace(/\{(\w+)\}/g, (_, k) => String(kw[k])) : s;
};
function pickLang(arg) {
  let raw = arg || process.env.LC_ALL || process.env.LANG || '';
  if (!raw) {
    try {
      raw = Intl.DateTimeFormat().resolvedOptions().locale || '';
    } catch {
      raw = '';
    }
  }
  raw = raw.replace('_', '-').split('.')[0].toLowerCase();
  if (raw.startsWith('pt')) return LANGS.indexOf('pt-BR');
  const i = LANGS.findIndex((l) => raw.startsWith(l.toLowerCase().slice(0, 2)));
  return i < 0 ? 0 : i;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
export function human(n) {
  n = Number(n || 0);
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (n < 1024 || unit === 'TB') return unit === 'B' ? `${Math.trunc(n)} ${unit}` : `${n.toFixed(1)} ${unit}`;
    n /= 1024;
  }
  return '';
}
export const num = (n) => String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const posix = (rel) => rel.split(path.sep).join('/').replace(/\\/g, '/');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs) => [...xs].sort(cmp);
function readBytes(p, limit) {
  const fd = fs.openSync(p, 'r');
  try {
    const chunks = [];
    let left = limit ?? -1;
    for (;;) {
      const want = left < 0 ? MiB : Math.min(MiB, left);
      if (want === 0) break;
      const b = Buffer.alloc(want);
      const n = fs.readSync(fd, b, 0, want, null);
      if (!n) break;
      chunks.push(b.subarray(0, n));
      if (left > 0) left -= n;
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}
const readText = (p, limit) => new TextDecoder('utf-8').decode(readBytes(p, limit));
function isSqlite(p) {
  try {
    return readBytes(p, 16).equals(Buffer.from('SQLite format 3\0', 'latin1'));
  } catch {
    return false;
  }
}
export const isoUtc = (t) => new Date(Math.floor((t ?? Date.now() / 1000)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const exists = (p) => lstat(p) !== null || fs.existsSync(p);
/** A link or a Windows junction (lstat says isSymbolicLink for both on Node). */
const isLink = (p) => Boolean(lstat(p)?.isSymbolicLink());

// ---------------------------------------------------------------------------------------------
// Secrets (section 4.4)
// ---------------------------------------------------------------------------------------------
const NEVER_FILES = ['.env', '*.env', '.env.*', 'auth.json', 'auth-profiles.json', '*.secrets.json', 'secrets.json', 'oauth.json', '.anthropic_oauth.json', '*.key', '*.pem', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*', '*.p12', '*.pfx', '*.keystore', '*.jks', 'bws_cache*.json', 'Cookies', 'Cookies-journal', 'cookies.sqlite', 'Login Data', 'keychain*', '*.keychain', '*.keychain-db', '.netrc', '.pgpass', '.npmrc', '.pypirc'];
const NEVER_DIRS = ['credentials', 'auth', 'mcp-tokens', 'pairing', 'vault', 'codex-home', 'browser-profile', '.ssh', '.gnupg', 'keychains'];
const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|credential|auth|cookie|private[_-]?key|client[_-]?secret|bearer|session[_-]?key|^env$)/i;
const HARMLESS_KEY = /^(max|min)_?(new_|output_|input_)?tokens?$|_tokens$|^tokens?_(limit|budget|count|used)$|^author$|^auth_?mode$/i;
const SECRET_TABLE = /(^|_)(auth|oauth|credential|credentials|secret|secrets|tokens?(?!_(usage|counts?|budgets?|stats|spend|costs?|logs?|metrics?|limits?)(_|$))|api_?keys?|password|passwords|cookie|cookies|vault|keychain)(_|s|$)/i;
const SHAPES = [
  '-----BEGIN [A-Z ]*PRIVATE' + ' KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
  '\\bsk-(?:ant-|proj-)?[A-Za-z0-9_\\-]{20,}',
  '\\bxai-[A-Za-z0-9]{20,}',
  '\\bgh[pousr]_[A-Za-z0-9]{30,}',
  '\\bgithub_pat_[A-Za-z0-9_]{30,}',
  '\\bglpat-[A-Za-z0-9_\\-]{20,}',
  '\\bxox[abposr]-[A-Za-z0-9\\-]{10,}',
  '\\bAKIA[0-9A-Z]{16}\\b',
  '\\bAIza[0-9A-Za-z_\\-]{35}\\b',
  '\\bhf_[A-Za-z0-9]{30,}',
  '\\beyJ[A-Za-z0-9_\\-]{10,}\\.eyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}',
  '\\b\\d{8,10}:[A-Za-z0-9_\\-]{35}\\b',
  '\\b(?:Bearer|Basic)\\s+[A-Za-z0-9._~+/=\\-]{20,}',
];
const SHAPE_SRC = SHAPES.map((s) => `(?:${s})`).join('|');
const SHAPE_G = new RegExp(SHAPE_SRC, 'g');
const SHAPE_1 = new RegExp(SHAPE_SRC);
const LONG_HEX = /^[0-9a-fA-F]{40,}$/;
const LONG_B64 = /^[A-Za-z0-9+/_\-]{40,}={0,2}$/;
const REMOVED = '\u00absecret removed\u00bb';
const REDACT = { text: 0, config: 0 };

export function scrubText(s) {
  if (!s) return s;
  let n = 0;
  const out = s.replace(SHAPE_G, () => {
    n++;
    return REMOVED;
  });
  REDACT.text += n;
  return out;
}
function secretValue(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (SHAPE_1.test(t)) return true;
  return !t.includes(' ') && (LONG_HEX.test(t) || (LONG_B64.test(t) && /\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t)));
}
const pyStr = (v) => (v === true ? 'True' : v === false ? 'False' : v === null || v === undefined ? 'None' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function redactTree(v, key = '') {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.includes('source') && keys.every((k) => ['source', 'provider', 'id'].includes(k))) return Object.fromEntries(keys.filter((k) => typeof v[k] === 'string').map((k) => [k, v[k]]));
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.toLowerCase() === 'env' && x && typeof x === 'object' && !Array.isArray(x)) {
        out[k] = Object.fromEntries(Object.entries(x).map(([kk, vv]) => [kk, vv !== null && vv !== '' ? { $redacted: 'env', len: pyStr(vv).length } : vv]));
        REDACT.config += Object.values(x).filter((vv) => vv !== null && vv !== '').length;
        continue;
      }
      out[k] = redactTree(x, k);
    }
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => redactTree(x, key));
  if (v === null || typeof v === 'boolean' || typeof v === 'number') {
    if (SECRET_KEY.test(key || '') && !HARMLESS_KEY.test(key || '') && typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 100000) {
      REDACT.config += 1;
      return { $redacted: 'key', len: String(v).length };
    }
    return v;
  }
  const s = String(v);
  if (s === '') return s;
  if (key && SECRET_KEY.test(key) && !HARMLESS_KEY.test(key)) {
    REDACT.config += 1;
    return { $redacted: 'key', len: s.length };
  }
  if (secretValue(s)) {
    REDACT.config += 1;
    return { $redacted: 'shape', len: s.length };
  }
  return scrubText(s);
}
const keySkeletonLines = (text) => text.split(/\r\n|\r|\n/).map((l) => /^(\s*)(?:- )?["']?([A-Za-z0-9_.$\-]+)["']?\s*:/.exec(l)).filter(Boolean).map((m) => m[1] + m[2]);

// ---------------------------------------------------------------------------------------------
// A small JSON5 reader and a restricted YAML reader (the same subset as the Python collector)
// ---------------------------------------------------------------------------------------------
class NotUnderstood extends Error {}
export function json5Loads(s) {
  let i = 0;
  const n = s.length;
  const ws = () => {
    while (i < n) {
      const c = s[i];
      if (' \t\r\n\ufeff\u00a0\u2028\u2029'.includes(c)) i++;
      else if (s.startsWith('//', i)) {
        const j = s.indexOf('\n', i);
        i = j < 0 ? n : j + 1;
      } else if (s.startsWith('/*', i)) {
        const j = s.indexOf('*/', i + 2);
        if (j < 0) throw new NotUnderstood('unclosed comment');
        i = j + 2;
      } else break;
    }
  };
  const string = () => {
    const q = s[i++];
    let out = '';
    while (i < n) {
      const c = s[i];
      if (c === q) {
        i++;
        return out;
      }
      if (c === '\\') {
        i++;
        const e = i < n ? s[i] : '';
        if (e === 'u') {
          out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
          i += 5;
          continue;
        }
        if (e === 'x') {
          out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16));
          i += 3;
          continue;
        }
        if (e === '\r' || e === '\n') {
          i++;
          if (e === '\r' && s[i] === '\n') i++;
          continue;
        }
        out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[e] ?? e;
        i++;
        continue;
      }
      out += c;
      i++;
    }
    throw new NotUnderstood('unclosed string');
  };
  const ident = () => {
    const m = /[A-Za-z_$][A-Za-z0-9_$]*/y;
    m.lastIndex = i;
    const r = m.exec(s);
    if (!r) throw new NotUnderstood(`unexpected ${JSON.stringify(s.slice(i, i + 10))} at ${i}`);
    i = m.lastIndex;
    return r[0];
  };
  const number = () => {
    const m = /[+-]?(0[xX][0-9a-fA-F]+|Infinity|NaN|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/y;
    m.lastIndex = i;
    const r = m.exec(s);
    if (!r) throw new NotUnderstood(`bad number at ${i}`);
    i = m.lastIndex;
    const t = r[0];
    if (/x/i.test(t)) return parseInt(t, 16);
    if (/Infinity|NaN/.test(t)) return null;
    return Number(t);
  };
  const value = (depth = 0) => {
    if (depth > 200) throw new NotUnderstood('too deep');
    ws();
    if (i >= n) throw new NotUnderstood('unexpected end');
    const c = s[i];
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (s[i] === '}') {
          i++;
          return obj;
        }
        const k = s[i] === '"' || s[i] === "'" ? string() : ident();
        ws();
        if (s[i] !== ':') throw new NotUnderstood(`expected : at ${i}`);
        i++;
        obj[k] = value(depth + 1);
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        ws();
        if (s[i] === '}') {
          i++;
          return obj;
        }
        throw new NotUnderstood(`expected , or } at ${i}`);
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (s[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value(depth + 1));
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        ws();
        if (s[i] === ']') {
          i++;
          return arr;
        }
        throw new NotUnderstood(`expected , or ] at ${i}`);
      }
    }
    if (c === '"' || c === "'") return string();
    if ('+-.0123456789'.includes(c) || s.startsWith('Infinity', i) || s.startsWith('NaN', i)) return number();
    const word = ident();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    throw new NotUnderstood(`unexpected word ${word}`);
  };
  const v = value();
  ws();
  if (i !== n) throw new NotUnderstood(`extra text at ${i}`);
  return v;
}

const YAML_ESC = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' };
function yamlDq(t) {
  let out = '';
  let i = 1;
  while (i < t.length) {
    const c = t[i];
    if (c === '"') {
      if (t.slice(i + 1).trim()) throw new NotUnderstood('bad quoted string');
      return out;
    }
    if (c === '\\' && i + 1 < t.length) {
      const e = t[i + 1];
      const n = { x: 2, u: 4, U: 8 }[e];
      if (n) {
        const h = t.slice(i + 2, i + 2 + n);
        if (h.length !== n || !/^[0-9A-Fa-f]+$/.test(h)) throw new NotUnderstood('bad quoted string');
        out += String.fromCodePoint(parseInt(h, 16));
        i += 2 + n;
        continue;
      }
      if (!(e in YAML_ESC)) throw new NotUnderstood('bad quoted string');
      out += YAML_ESC[e];
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  throw new NotUnderstood('bad quoted string');
}
function yamlScalar(t) {
  t = t.trim();
  if (t === '' || ['~', 'null', 'Null', 'NULL'].includes(t)) return null;
  if ('&*!'.includes(t[0])) throw new NotUnderstood('anchors, aliases and tags are not read');
  if (t[0] === '"') {
    try {
      // Python's json.loads(strict=False): raw control characters are allowed inside strings.
      return JSON.parse(t.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
    } catch {
      return yamlDq(t);
    }
  }
  if (t[0] === "'") {
    if (!t.endsWith("'") || t.length < 2) throw new NotUnderstood('bad quoted string');
    return t.slice(1, -1).replaceAll("''", "'");
  }
  if (t[0] === '[' || t[0] === '{') {
    try {
      return json5Loads(t);
    } catch (e) {
      if (t[0] === '[' && t.endsWith(']')) return t.slice(1, -1).split(',').filter((x) => x.trim()).map(yamlScalar);
      throw e;
    }
  }
  if (['true', 'True', 'TRUE', 'yes', 'Yes', 'on', 'On'].includes(t)) return true;
  if (['false', 'False', 'FALSE', 'no', 'No', 'off', 'Off'].includes(t)) return false;
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  return t;
}
function stripComment(line) {
  let out = '';
  let q = null;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (k === 0 || line[k - 1] === ' ' || line[k - 1] === '\t')) break;
    out += c;
  }
  return out.replace(/\s+$/, '');
}
export function yamlLoads(text) {
  const raw = text.replaceAll('\r\n', '\n').replaceAll('\t', '    ').split('\n');
  const lines = [];
  for (const l of raw) {
    if ((l.trim() === '---' || l.trim() === '...') && !lines.length) continue;
    lines.push(l);
  }
  let pos = 0;
  const indentOf = (l) => l.length - l.replace(/^ +/, '').length;
  const skipBlank = () => {
    while (pos < lines.length && !stripComment(lines[pos]).trim()) pos++;
  };
  const blockString = (parentIndent, style) => {
    const out = [];
    let ind = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.trim() === '') {
        out.push('');
        pos++;
        continue;
      }
      const li = indentOf(l);
      if (li <= parentIndent) break;
      if (ind === null) ind = li;
      out.push(li >= ind ? l.slice(ind) : l.trim());
      pos++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    if (style.startsWith('>')) return out.filter((x) => x).join(' ') + '\n';
    return out.join('\n') + '\n';
  };
  const quotedRest = (rest) => {
    const q = rest.slice(0, 1);
    if (q !== '"' && q !== "'") return rest;
    const closed = (x) => (q === "'" ? x.slice(1).replaceAll("''", '').endsWith("'") : x.slice(1).replace(/\\[\s\S]/g, '').includes('"'));
    let n = 0;
    while (!closed(rest) && pos < lines.length && n < 500) {
      const nxt = lines[pos].trim();
      rest = rest + (nxt === '' ? '\n' : ' ' + nxt);
      pos++;
      n++;
    }
    return rest;
  };
  const isItem = (l) => l.replace(/^\s+/, '').startsWith('- ') || l.trim() === '-';
  const node = () => {
    skipBlank();
    if (pos >= lines.length) return null;
    const l = stripComment(lines[pos]);
    return isItem(l) ? seq(indentOf(l)) : mapping(indentOf(l));
  };
  const seq = (ind) => {
    const out = [];
    for (;;) {
      skipBlank();
      if (pos >= lines.length) return out;
      const l = stripComment(lines[pos]);
      if (indentOf(l) !== ind || !isItem(l)) {
        if (indentOf(l) > ind) throw new NotUnderstood(`odd indentation at line ${pos + 1}`);
        return out;
      }
      const rest = l.trim().slice(1).trim();
      if (rest === '') {
        pos++;
        out.push(node());
      } else if (/^[^"'[{][^#]*?:(\s|$)/.test(rest) || /^"[^"]*"\s*:(\s|$)/.test(rest)) {
        lines[pos] = ' '.repeat(ind + 2) + rest;
        out.push(mapping(ind + 2));
      } else {
        pos++;
        if (['|', '|-', '>', '>-'].includes(rest)) out.push(blockString(ind, rest));
        else out.push(yamlScalar(quotedRest(rest)));
      }
    }
  };
  const mapping = (ind) => {
    const out = {};
    for (;;) {
      skipBlank();
      if (pos >= lines.length) return out;
      const l = stripComment(lines[pos]);
      const li = indentOf(l);
      if (li < ind) return out;
      if (li > ind) throw new NotUnderstood(`odd indentation at line ${pos + 1}`);
      const m = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:#"'][^#]*?)\s*:(?:\s+(.*))?$/.exec(l);
      if (!m) {
        if (l.replace(/^\s+/, '').startsWith('- ')) return out;
        throw new NotUnderstood(`not a mapping line at ${pos + 1}`);
      }
      let k = m[1];
      if (k[0] === '"' || k[0] === "'") k = String(yamlScalar(k));
      if (k.startsWith('<<') || k.startsWith('?')) throw new NotUnderstood('merge keys are not read');
      let rest = (m[2] ?? '').trim();
      pos++;
      if (rest === '') {
        skipBlank();
        if (pos < lines.length) {
          const nl = stripComment(lines[pos]);
          const ni = indentOf(nl);
          if (ni > ind || (ni === ind && nl.replace(/^\s+/, '').startsWith('- '))) {
            out[k] = node();
            continue;
          }
        }
        out[k] = null;
      } else if (['|', '|-', '|+', '>', '>-', '>+'].includes(rest)) out[k] = blockString(ind, rest);
      else {
        rest = quotedRest(rest);
        while (!['[', '{', '"', "'"].includes(rest.slice(0, 1)) && pos < lines.length && lines[pos].trim() && !lines[pos].replace(/^\s+/, '').startsWith('#') && indentOf(lines[pos]) > ind && !/^\s*(?:- |[^\s#"'][^#]*?:(?:\s|$))/.test(lines[pos])) {
          rest = rest + ' ' + stripComment(lines[pos]).trim();
          pos++;
        }
        out[k] = yamlScalar(rest);
      }
    }
  };
  const v = node();
  skipBlank();
  if (pos < lines.length) throw new NotUnderstood(`extra text at line ${pos + 1}`);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Sensitive categories, by NAMES only (section 4.6)
// ---------------------------------------------------------------------------------------------
const CATEGORY_WORDS = {
  medical: /^(health|healthkit|medical|med|meds|medication|medications|medicine|symptoms?|diagnos\w*|doctors?|therapy|therapist|mood_?log|moodlog|sleep|vitals?|labs?|prescri\w*|period|cycle|weight|glucose|bp|blood|insulin|clinic|patient|allerg\w*)$/i,
  intimate: /^(intimate|intimacy|nsfw|adult|sexual|sex|kinks?|erotic\w*|lewd|spicy|nudes?|nude)$/i,
  finances: /^(finance|finances|financial|bank|banking|budget|budgets|invoices?|taxes|tax|salary|payroll|brokerage|crypto|wallet)$/i,
};
const DEFAULT_CATEGORIES_ON = new Set(['finances']);
function nameWords(name) {
  const words = name.replace(/([a-z])([A-Z])/g, '$1_$2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pairs = [];
  for (let k = 0; k < words.length - 1; k++) pairs.push(`${words[k]}_${words[k + 1]}`);
  return [...words, ...pairs];
}
function categoriesOf(...names) {
  const found = new Set();
  for (const nm of names) for (const wd of nameWords(nm || '')) for (const [cat, rx] of Object.entries(CATEGORY_WORDS)) if (rx.test(wd)) found.add(cat);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Finding the homes (section 4.2)
// ---------------------------------------------------------------------------------------------
const HERMES_MARKERS = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db'];
const DATED = /^(?<base>[A-Za-z0-9_\-]+)\.(?<tag>[^/]+)\.(?<ext>md|yaml|yml|json|json5)$/;
const MEDIA_EXT = new Set('.png .jpg .jpeg .gif .webp .heic .bmp .tif .tiff .svg .ico .mp3 .wav .ogg .opus .m4a .flac .aac .mp4 .mov .webm .mkv .avi .gguf .safetensors .bin .onnx .pt .pth .ckpt .npy .npz .tflite .mlmodel .zip .tar .gz .tgz .7z .rar .xz .zst .dmg .iso .woff .woff2 .ttf .otf .exe .dll .so .dylib'.split(' '));
const TEXT_EXT = new Set('.md .txt .json .json5 .jsonl .yaml .yml .toml .ini .cfg .py .ts .js .mjs .cjs .sh .bash .zsh .ps1 .rb .go .rs .java .kt .swift .lua .sql .csv .tsv .html .css .xml .tmpl .j2 .jinja .env.example'.split(' '));
const CODE_ENV = new Set(['hermes-agent', 'node_modules', '.venv', 'venv', 'env', '.git', '__pycache__', 'site-packages', '.mypy_cache', '.pytest_cache', 'dist', 'build', '.next', '.turbo']);
const BACKUP_DIRS = new Set(['backups', 'backup', 'state-snapshots', 'snapshots', 'checkpoints', 'archive', 'archives', 'trash', '.trash']);
const MEDIA_DIRS = new Set(['media', 'images', 'image_cache', 'audio', 'audio_cache', 'voice', 'voices', 'tts_cache', 'video', 'models', 'downloads', 'uploads', 'attachments', 'cache', '.cache', 'tmp', 'temp']);
const LOG_FILE = /(\.log(\.\d+)?|\.log\.gz)$/i;
const BACKUP_FILE = /(\.bak[^/]*|\.orig|\.migrated|~|\.old|\.prev|\.backup|\.save)$/i;
const OPENCLAW_PERSONA = { 'SOUL.md': 'persona', 'IDENTITY.md': 'identity', 'AGENTS.md': 'rules', 'USER.md': 'profile', 'MEMORY.md': 'memory', 'memory.md': 'memory', 'BOOT.md': 'boot', 'BOOTSTRAP.md': 'bootstrap', 'HEARTBEAT.md': 'heartbeat', 'DREAMS.md': 'dreams', 'TOOLS.md': 'tools' };
const DAILY = /^memory\/(\d{4}-\d{2}-\d{2})(?:[^/]*)\.md$/;
const KEEP_TOP = {
  'hermes-home': new Set(['memories', 'skills', 'hooks', 'cron', 'plugins', 'kanban']),
  'openclaw-state': new Set(['agents', 'cron', 'skills', 'hooks', 'extensions', 'plugins', 'state']),
  'openclaw-workspace': new Set(['memory', 'skills', '.agents', 'hooks']),
};

/** The home folder the way Python's expanduser sees it (USERPROFILE on Windows, HOME elsewhere), read each time. */
const homeDir = () => (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || os.homedir();
export function expand(p, base) {
  p = String(p).replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? m).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => process.env[k] ?? m);
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = homeDir() + p.slice(1);
  if (base && !path.isAbsolute(p)) p = path.join(base, p);
  return path.resolve(p);
}
const tilde = (p) => (p.startsWith(homeDir()) ? '~' + p.slice(homeDir().length) : p);
const isHermesHome = (p) => isDir(p) && HERMES_MARKERS.some((m) => exists(path.join(p, m)));
const isOpenclawState = (p) => isDir(p) && (isFile(path.join(p, 'openclaw.json')) || (isDir(path.join(p, 'agents')) && isDir(path.join(p, 'workspace'))));

function loadOpenclawConfig(state, cfgPath) {
  const cfg = cfgPath || process.env.OPENCLAW_CONFIG_PATH || path.join(state, 'openclaw.json');
  if (!isFile(cfg)) return { tree: null, includes: [], error: null };
  const includes = [];
  const load = (p, depth) => {
    if (depth > 8) throw new NotUnderstood('$include nested too deep');
    const tree = json5Loads(readText(p, 8 * MiB));
    const walk = (v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const out = {};
        const inc = v.$include;
        if (inc) {
          for (const one of Array.isArray(inc) ? inc : [inc]) {
            const ip = expand(one, path.dirname(p));
            includes.push(ip);
            const sub = load(ip, depth + 1);
            if (sub && typeof sub === 'object' && !Array.isArray(sub)) Object.assign(out, sub);
          }
        }
        for (const [k, x] of Object.entries(v)) if (k !== '$include') out[k] = walk(x);
        return out;
      }
      if (Array.isArray(v)) return v.map(walk);
      return v;
    };
    return walk(tree);
  };
  try {
    return { tree: load(cfg, 0), includes, error: null };
  } catch (e) {
    return { tree: null, includes, error: String(e.message ?? e) };
  }
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
function openclawAgents(state, tree) {
  const ids = [];
  const agents = obj(obj(tree)?.agents);
  if (agents) {
    if (obj(agents.entries)) ids.push(...Object.keys(agents.entries).map(String));
    if (Array.isArray(agents.list)) ids.push(...agents.list.filter((x) => obj(x) && x.id).map((x) => String(x.id)));
  }
  const adir = path.join(state, 'agents');
  if (isDir(adir)) for (const d of sorted(fs.readdirSync(adir))) if (isDir(path.join(adir, d)) && !ids.includes(d)) ids.push(d);
  return ids.length ? ids : ['main'];
}
function openclawAgentEntry(tree, agent) {
  const agents = obj(obj(tree)?.agents);
  if (!agents) return [{}, {}];
  const defaults = obj(agents.defaults) ?? {};
  const ent = obj(agents.entries) ?? {};
  let e = obj(ent[agent]) ?? {};
  for (const x of agents.list ?? []) if (obj(x) && String(x.id) === agent) e = x;
  return [e, defaults];
}
function openclawWorkspace(state, tree, agent, many, override) {
  const [e, defaults] = openclawAgentEntry(tree, agent);
  const cands = [];
  if (override) cands.push(expand(override));
  if (e.workspace) cands.push(expand(e.workspace, state));
  if (process.env.OPENCLAW_WORKSPACE_DIR) cands.push(expand(process.env.OPENCLAW_WORKSPACE_DIR));
  if (defaults.workspace) {
    const base = expand(defaults.workspace, state);
    cands.push(many ? path.join(base, agent) : base);
  }
  cands.push(path.join(state, `workspace-${agent}`));
  cands.push(path.join(state, 'workspace'));
  return cands.find(isDir) ?? null;
}

/** Every agent this collector can pack: [{kind, agentId, roots:[[id, role, path]], label}]. */
export function findCandidates(opts = {}) {
  const out = [];
  const seen = new Set();
  const addHermes = (home, profile) => {
    home = path.resolve(home);
    if (seen.has(home) || !isHermesHome(home)) return;
    seen.add(home);
    out.push({ kind: 'hermes', agentId: profile, roots: [['home', 'hermes-home', home]], label: `Hermes Agent  ${tilde(home)}  (profile: ${profile})` });
  };
  const hermesTree = (home) => {
    addHermes(home, 'default');
    const pdir = path.join(home, 'profiles');
    if (isDir(pdir)) for (const d of sorted(fs.readdirSync(pdir))) addHermes(path.join(pdir, d), d);
  };
  const addOpenclaw = (state, wsOverride) => {
    state = path.resolve(state);
    if (seen.has(state) || !isOpenclawState(state)) return;
    seen.add(state);
    const { tree } = loadOpenclawConfig(state);
    const ids = openclawAgents(state, tree);
    for (const aid of ids) {
      const ws = openclawWorkspace(state, tree, aid, ids.length > 1, wsOverride);
      const roots = [['state', 'openclaw-state', state]];
      if (ws) roots.push(['ws', 'openclaw-workspace', ws]);
      out.push({ kind: 'openclaw', agentId: aid, roots, label: `OpenClaw  ${tilde(state)}  (agent: ${aid}${ws ? ', workspace ' + tilde(ws) : ', no workspace found'})` });
    }
  };
  let given = false;
  if (opts.hermes_home) {
    given = true;
    hermesTree(expand(opts.hermes_home));
  }
  if (opts.openclaw_state) {
    given = true;
    addOpenclaw(expand(opts.openclaw_state), opts.workspace);
  }
  if (!given && !opts.scan?.length) {
    if (process.env.HERMES_HOME) hermesTree(expand(process.env.HERMES_HOME));
    if (process.env.OPENCLAW_STATE_DIR) addOpenclaw(expand(process.env.OPENCLAW_STATE_DIR), opts.workspace);
    if (process.env.OPENCLAW_PROFILE) addOpenclaw(expand('~/.openclaw-' + process.env.OPENCLAW_PROFILE), opts.workspace);
    hermesTree(expand('~/.hermes'));
    if (process.env.LOCALAPPDATA) hermesTree(path.join(process.env.LOCALAPPDATA, 'hermes'));
    addOpenclaw(expand('~/.openclaw'), opts.workspace);
    try {
      for (const d of sorted(fs.readdirSync(homeDir()))) if (d.startsWith('.openclaw-')) addOpenclaw(path.join(homeDir(), d), opts.workspace);
    } catch {
      /* no home listing */
    }
    addOpenclaw(expand('~/openclaw'), opts.workspace);
  }
  for (const sp of opts.scan ?? []) {
    const p = expand(sp);
    if (isDir(p) && !seen.has(p)) {
      seen.add(p);
      out.push({ kind: 'custom', agentId: path.basename(p.replace(/[\\/]+$/, '')) || 'custom', roots: [['ext', 'scan', p]], label: `Custom folder  ${tilde(p)}` });
    }
  }
  return out;
}
// ---------------------------------------------------------------------------------------------
// The plan: every file found gets packed, or skipped with a reason code (section 4.3)
// ---------------------------------------------------------------------------------------------
export class Plan {
  constructor(cand, opts) {
    this.cand = cand;
    this.opts = opts;
    this.items = [];
    this.skips = {};
    this.skipList = [];
    this.stores = [];
    this.history = new Map();
    this.notes = [];
    this.layout = [];
    this.display = cand.agentId;
    this.schemaVersion = null;
    this.includes = [];
  }
  skip(p, reason, size = 0, files = 1, why = null) {
    const s = (this.skips[reason] ??= { files: 0, bytes: 0, examples: [] });
    s.files += files;
    s.bytes += size;
    if (s.examples.length < 6) s.examples.push(p);
    const rec = { path: p, reason, bytes: size };
    if (files !== 1) rec.files = files;
    if (why) rec.why = why;
    if (this.skipList.length < 20000 || reason === 'secret') this.skipList.push(rec);
  }
  add(rootId, rel, kind, src, size, mtime, extra = {}) {
    const it = { path: `files/${rootId}/${rel}`, kind, src, bytes: size, mtime: isoUtc(mtime), rel, root: rootId, ...extra };
    it.cats = sorted(categoriesOf(rel));
    this.items.push(it);
    return it;
  }
}

/** [files, bytes, complete] of a skipped folder: at most `limit` entries, links never followed. */
function treeSize(p, limit = PEEK_ENTRIES) {
  let files = 0;
  let size = 0;
  let seen = 0;
  const todo = [p];
  while (todo.length) {
    const d = todo.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (++seen > limit) return [files, size, false];
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) todo.push(full);
      else if (e.isFile()) {
        files++;
        size += lstat(full)?.size ?? 0;
      }
    }
  }
  return [files, size, true];
}
const glob = (pat) => new RegExp('^' + pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^') + '$');
const fnmatch = (name, pat) => glob(pat).test(name) || (process.platform === 'win32' && glob(pat.toLowerCase()).test(name.toLowerCase()));
const neverFile = (name) => NEVER_FILES.some((pat) => fnmatch(name, pat) || fnmatch(name.toLowerCase(), pat.toLowerCase()));
const matches = (rel, pats) => (pats ?? []).some((p) => fnmatch(rel, p) || fnmatch(path.posix.basename(rel), p));
function looksPrivateKey(p) {
  try {
    const head = readBytes(p, 200);
    return head.toString('latin1').replace(/^\s+/, '').startsWith('-----BEGIN') && head.includes('PRIVATE');
  } catch {
    return false;
  }
}
const extOf = (name) => {
  const b = name.toLowerCase();
  const i = b.lastIndexOf('.');
  return i > 0 && !b.slice(0, i).match(/^\.+$/) ? b.slice(i) : '';
};

function classifyDir(role, rel, name, plan) {
  const low = name.toLowerCase();
  if (NEVER_DIRS.includes(name) || NEVER_DIRS.includes(low)) return ['secret', null];
  if (CODE_ENV.has(low)) return ['code-env', null];
  const top = rel.split('/')[0];
  if (role === 'hermes-home') {
    if (top === 'skills' && name.startsWith('.')) return ['derived', "Hermes Agent's own skill bookkeeping"];
    if (rel === 'profiles') return ['other', 'another profile: collect it as its own bundle'];
    if (rel === 'logs' || low === 'logs') return ['log', null];
    if (rel === 'sessions') return ['backup', 'gateway copies of sessions that are in state.db'];
    if (rel === 'cron/output' || rel === 'cron/runs') return ['log', null];
    if (rel === 'kanban/workspaces') return ['telemetry', 'scratch folders of finished board tasks'];
    if (BACKUP_DIRS.has(low)) return ['backup', null];
    if (MEDIA_DIRS.has(low) && top !== 'skills') return ['media', null];
  } else if (role === 'openclaw-state') {
    if (low === 'logs' || rel === 'cron/runs') return ['log', null];
    if (BACKUP_DIRS.has(low)) return ['backup', null];
    if (rel.startsWith('workspace') && !rel.includes('/')) return ['skip-silent', null];
    if (rel.startsWith('agents/') && rel.split('/').length === 2 && name !== plan.cand.agentId) return ['other', 'another agent: collect it as its own bundle'];
    if (MEDIA_DIRS.has(low) && !['skills', 'extensions', 'plugins'].includes(top)) return ['media', null];
    if (rel === 'memory' || (rel.endsWith('/memory') && rel.includes('agents/'))) return ['derived', 'memory search index (Sara builds her own)'];
  } else if (role === 'openclaw-workspace') {
    if (rel === 'memory/.dreams') return ['derived', 'dreaming machine state'];
    if (BACKUP_DIRS.has(low)) return ['backup', null];
    if (MEDIA_DIRS.has(low)) return ['media', null];
  } else {
    if (BACKUP_DIRS.has(low)) return ['backup', null];
    if (MEDIA_DIRS.has(low) || low === 'logs') return [low !== 'logs' ? 'media' : 'log', null];
  }
  return null;
}

function classifyFile(role, rel, name, size, plan, includePaths) {
  const e = extOf(name);
  const parts = rel.split('/');
  const top = parts[0];
  const depth = parts.length - 1;
  if (neverFile(name)) return ['secret', null];
  if (/(-wal|-shm|-journal)$/.test(name)) return ['skip-silent', null];
  if (LOG_FILE.test(name)) return ['log', null];
  if (BACKUP_FILE.test(name)) return ['backup', null];
  if (MEDIA_EXT.has(e) || (e === '.pdf' && size > 5 * MiB)) return ['media', null];
  const sqliteLike = ['.db', '.sqlite', '.sqlite3', '.db3'].includes(e) || name === 'state.db';
  const m = DATED.exec(name);
  if (m && ['yaml', 'yml', 'json', 'json5'].includes(m.groups.ext) && exists(path.join(plan.rootPath, path.posix.dirname(rel), `${m.groups.base}.${m.groups.ext}`))) return ['backup', 'a dated copy of a config file'];
  if (role === 'hermes-home') {
    if (top === 'skills' && parts.slice(1).some((x) => x.startsWith('.'))) return ['derived', "Hermes Agent's own skill bookkeeping"];
    if (rel === 'SOUL.md') return ['pack', 'persona'];
    if (depth === 0 && e === '.md') return ['pack', 'persona-extra'];
    if (top === 'memories' && e === '.md') return ['pack', 'memory'];
    if (rel === 'config.yaml') return ['pack', 'config'];
    if (top === 'skills') return ['pack', 'skill'];
    if (top === 'hooks') return ['pack', 'hook'];
    if (rel === 'cron/jobs.json') return ['pack', 'cron'];
    if (rel === 'cron/deliveries.db') return ['log', 'cron delivery queue'];
    if (top === 'cron') return ['log', null];
    if (rel === 'state.db') return ['store', 'hermes-state'];
    if (rel === 'kanban.db' || /^kanban\/boards\/[^/]+\/kanban\.db$/.test(rel)) return ['store', 'hermes-kanban'];
    if (top === 'plugins') return sqliteLike ? ['store', 'custom'] : ['pack', 'plugin'];
    if (depth === 0 && sqliteLike) return ['other', "Hermes Agent's own bookkeeping"];
  } else if (role === 'openclaw-state') {
    if (rel === 'openclaw.json' || includePaths.has(path.resolve(path.join(plan.stateRoot, rel)))) return ['pack', 'config'];
    const aid = plan.cand.agentId;
    const qa = aid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^agents/${qa}/sessions/[^/]+\\.jsonl$`).test(rel) || rel === `agents/${aid}/sessions/sessions.json`) return ['pack', 'session'];
    if (rel === `agents/${aid}/agent/openclaw-agent.sqlite`) return ['store', 'openclaw-agent'];
    if (rel === 'state/openclaw.sqlite') return ['store', 'openclaw-state'];
    if (top === 'state' && sqliteLike) return ['other', "OpenClaw's own bookkeeping"];
    if (rel === 'cron/jobs.json' || rel === 'cron/jobs-quarantine.json') return ['pack', 'cron'];
    if (top === 'skills') return ['pack', 'skill'];
    if (top === 'hooks') return ['pack', 'hook'];
    if (top === 'extensions' || top === 'plugins') return sqliteLike ? ['store', 'custom'] : ['pack', 'plugin'];
    if (top === 'agents' && rel.startsWith(`agents/${aid}/agent/workshop-skills/`)) return ['pack', 'skill'];
  } else if (role === 'openclaw-workspace') {
    if (depth === 0 && name in OPENCLAW_PERSONA) return ['pack', 'ws-' + OPENCLAW_PERSONA[name]];
    if (depth === 0 && e === '.md') return ['pack', 'persona-extra'];
    if (DAILY.test(rel)) return ['pack', 'daily'];
    if (rel.startsWith('memory/dreaming/') && e === '.md') return ['pack', 'dreams'];
    if (top === 'skills' || rel.startsWith('.agents/skills/')) return ['pack', 'skill'];
    if (top === 'hooks') return ['pack', 'hook'];
  } else {
    if (/^(SOUL|IDENTITY|PERSONA|CHARACTER|USER|MEMORY)\.md$/i.test(name)) return ['pack', 'persona-extra'];
    if (('/' + rel).includes('/skills/') && TEXT_EXT.has(e)) return ['pack', 'skill'];
    if (e === '.sql' || e === '.dump') return ['other', 'an SQL file: read it with the Python collector (--postgres-dump)'];
  }
  if (sqliteLike && isSqlite(path.join(plan.rootPath, rel))) return ['store', 'custom'];
  return ['other', null];
}

const TEXT_KINDS = new Set(['persona', 'persona-extra', 'memory', 'skill', 'hook', 'plugin', 'cron', 'session', 'daily', 'dreams', 'history']);

function walkRoot(plan, rootId, role, root) {
  const opts = plan.opts;
  plan.rootPath = root;
  if (role === 'openclaw-state') plan.stateRoot = root;
  const includePaths = new Set(plan.includes ?? []);
  const wsPaths = new Set(plan.cand.roots.filter((r) => r[1] === 'openclaw-workspace').map((r) => path.resolve(r[2])));
  const since = opts.since_ts;
  const keepTop = KEEP_TOP[role];
  const large = opts.include_large;
  const budget = new Map();
  const over = new Set();
  let seenFiles = 0;
  const visit = (dp) => {
    const relDir0 = posix(path.relative(root, dp));
    const relDir = relDir0 === '.' ? '' : relDir0;
    let ents;
    try {
      ents = fs.readdirSync(dp, { withFileTypes: true });
    } catch (e) {
      plan.skip(relDir || '.', 'unreadable', 0, 1, String(e.message ?? e));
      return;
    }
    const dns = sorted(ents.filter((x) => x.isDirectory() || (x.isSymbolicLink() && isDir(path.join(dp, x.name)))).map((x) => x.name));
    const fns = sorted(ents.filter((x) => !dns.includes(x.name)).map((x) => x.name));
    const sec = relDir ? relDir.split('/')[0] : '';
    if (sec && over.has(sec)) return;
    if (sec) {
      const b = budget.get(sec) ?? [0, Date.now()];
      budget.set(sec, b);
      b[0] += fns.length + dns.length;
      if (!large && (b[0] > SECTION_FILES || (Date.now() - b[1]) / 1000 > SECTION_SECONDS)) {
        over.add(sec);
        return;
      }
    }
    const keep = [];
    for (const d of dns) {
      const full = path.join(dp, d);
      const rel = relDir ? `${relDir}/${d}` : d;
      if (isLink(full)) {
        plan.skip(`${rootId}/${rel}`, 'other', 0, 1, 'a link (links are never followed)');
        continue;
      }
      if (wsPaths.has(path.resolve(full)) && role !== 'openclaw-workspace') continue;
      if (matches(rel, opts.never)) {
        const [files, size, whole] = treeSize(full);
        plan.skip(`${rootId}/${rel}/`, 'owner-never', size, files, whole ? null : 'not opened further');
        continue;
      }
      let c = classifyDir(role, rel, d, plan);
      if (c && matches(rel, opts.include) && c[0] !== 'secret') c = null;
      if (!c && keepTop && !relDir && !keepTop.has(d) && !matches(rel, opts.include)) c = ['other', "not part of her (program files, caches or the agent's own bookkeeping): never opened"];
      if (c) {
        if (c[0] === 'skip-silent') continue;
        const [files, size, whole] = treeSize(full);
        plan.skip(`${rootId}/${rel}/`, c[0], size, files, whole ? c[1] : (c[1] ? c[1] + '; ' : '') + 'big folder, not counted to the end');
        continue;
      }
      keep.push(d);
    }
    seenFiles += fns.length;
    Progress.say('look', `Looking through ${sec || path.basename(root)}... ${num(seenFiles)} files so far`, seenFiles);
    for (const f of fns) {
      const full = path.join(dp, f);
      const rel = relDir ? `${relDir}/${f}` : f;
      const st = lstat(full);
      if (!st) {
        plan.skip(`${rootId}/${rel}`, 'unreadable', 0, 1, 'could not be read');
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) {
        plan.skip(`${rootId}/${rel}`, 'other', 0, 1, 'not a plain file (links are never followed)');
        continue;
      }
      if (matches(rel, opts.never)) {
        plan.skip(`${rootId}/${rel}`, 'owner-never', st.size);
        continue;
      }
      let c = classifyFile(role, rel, f, st.size, plan, includePaths);
      if (c[0] === 'skip-silent') continue;
      if (!['pack', 'store', 'secret'].includes(c[0]) && matches(rel, opts.include)) c = ['pack', 'included'];
      if ((c[0] === 'pack' || c[0] === 'store') && matches(rel, opts.exclude)) c = ['owner-never', 'left out with --exclude'];
      const mtime = st.mtimeMs / 1000;
      if (c[0] === 'pack') {
        const kind = c[1];
        if (kind !== 'config' && looksPrivateKey(full)) {
          plan.skip(`${rootId}/${rel}`, 'secret', st.size, 1, 'a private key');
          continue;
        }
        const m = DATED.exec(f);
        if (m && exists(path.join(dp, `${m.groups.base}.${m.groups.ext}`)) && m.groups.tag !== 'example') {
          const base = (relDir ? relDir + '/' : '') + `${m.groups.base}.${m.groups.ext}`;
          if (kind === 'persona' || kind === 'persona-extra' || kind.startsWith('ws-')) {
            const key = `${rootId}\0${base}`;
            if (!plan.history.has(key)) plan.history.set(key, []);
            plan.history.get(key).push([mtime, rel, full, st.size]);
          } else plan.skip(`${rootId}/${rel}`, 'backup', st.size, 1, 'a dated copy');
          continue;
        }
        const limit = kind === 'hook' || kind === 'plugin' ? MAX_CODE_FILE : ['skill', 'persona', 'persona-extra', 'memory', 'cron'].includes(kind) || kind.startsWith('ws-') ? MAX_TEXT_FILE : null;
        if (['hook', 'plugin', 'skill'].includes(kind) && !TEXT_EXT.has(extOf(f)) && extOf(f) !== '' && !/^(SKILL|HOOK|README|LICENSE)/.test(f)) {
          plan.skip(`${rootId}/${rel}`, 'media', st.size, 1, 'not a text file');
          continue;
        }
        if (limit && st.size > limit) {
          plan.skip(`${rootId}/${rel}`, 'too-big', st.size);
          continue;
        }
        if (since && kind === 'session' && mtime < since) {
          plan.skip(`${rootId}/${rel}`, 'since', st.size);
          continue;
        }
        plan.add(rootId, rel, kind, full, st.size, mtime);
      } else if (c[0] === 'store') plan.stores.push({ root: rootId, rel, src: full, reader: c[1], bytes: st.size, mtime: isoUtc(mtime) });
      else plan.skip(`${rootId}/${rel}`, c[0], st.size, 1, c[1]);
    }
    for (const d of keep) visit(path.join(dp, d));
  };
  visit(root);
  for (const sec of sorted(over)) {
    const dropped = plan.items.filter((it) => it.root === rootId && it.rel.split('/')[0] === sec);
    plan.items = plan.items.filter((it) => !(it.root === rootId && it.rel.split('/')[0] === sec));
    plan.stores = plan.stores.filter((x) => !(x.root === rootId && x.rel.split('/')[0] === sec));
    plan.skip(`${rootId}/${sec}/`, 'too-big', dropped.reduce((n, it) => n + it.bytes, 0), budget.get(sec)[0], `too large to look through (more than ${num(SECTION_FILES)} files or ${SECTION_SECONDS} seconds)`);
    plan.notes.push(`Skipped because it is too large: ${sec}/ (more than ${num(SECTION_FILES)} files). Add --include-large to bring it anyway.`);
  }
  for (const [key, copies] of plan.history) {
    const [rid, base] = key.split('\0');
    if (rid !== rootId) continue;
    copies.sort((a, b) => b[0] - a[0] || cmp(b[1], a[1]));
    const target = plan.items.find((it) => it.root === rootId && it.rel === base);
    copies.forEach(([mt, rel, full, size], k) => {
      if (k < DATED_HISTORY_KEEP && target) {
        const h = plan.add(rootId, rel, 'history', full, size, mt, { of: target.path });
        (target.history ??= []).push(h.path);
      } else plan.skip(`${rootId}/${rel}`, 'backup', size, 1, 'an older dated copy');
    });
  }
}

// ---------------------------------------------------------------------------------------------
// SQLite stores: read-only, streamed (section 4.5); node:sqlite (Node 22.5+)
// ---------------------------------------------------------------------------------------------
const TELEMETRY_WORD = /^(log|logs|event|events|trace|traces|span|spans|metric|metrics|telemetry|audit|heartbeat|heartbeats|tick|ticks|run|runs|step|steps|attempt|attempts|debug|perf|usage|cost|costs|latency|queue|cache|checkpoint|checkpoints|snapshot|snapshots|migration|migrations|lock|locks|lease|leases|outbox|autonomy|loop|loops|job_runs?|inbox_raw|decision_log|session_state)$/i;
const DERIVED_TABLE = /(^sqlite_|_fts$|_fts_(data|idx|docsize|config|content)$|_fts\d*$|^fts_|_content$|_segments$|_segdir$|_stat$|^vec_|_vec$|_embeddings?$|^embeddings?$)/i;
const EMBED_COL = /(embedding|vector|^emb$|_emb$)/i;
const READER_TABLES = {
  'hermes-state': new Set(['sessions', 'messages', 'schema_version']),
  'hermes-kanban': new Set(['tasks', 'task_links', 'comments', 'task_comments', 'boards', 'attachments', 'task_attachments']),
  // OpenClaw 2026.10+: chats live in the agent database (the active branch is read from *_active_events).
  'openclaw-state': new Set(['workspace_generated_bootstrap_hashes']),
  'openclaw-agent': new Set(['transcript_events', 'session_transcript_active_events', 'session_windows', 'session_nodes', 'session_entry_snapshots', 'session_transcript_archives']),
};
const AUTOMATION_TABLE = /(automation|cron|job|schedule)/i;
const HERMES_MESSAGE_COLS = new Set(['id', 'session_id', 'role', 'content', 'tool_calls', 'tool_name', 'timestamp', 'reasoning', 'active', 'compacted', 'message_uid']);
const SHORT_MARK = '\u2026';
function slimHermesMessage(row) {
  if (row.role === 'tool' && typeof row.content === 'string' && row.content) row.content = { $skipped: 'tool output', bytes: [...row.content].length };
  for (const k of ['tool_calls', 'reasoning']) if (typeof row[k] === 'string' && [...row[k]].length > 1) row[k] = SHORT_MARK;
  return row;
}

let SQLITE;
async function sqliteModule() {
  if (SQLITE === undefined) {
    try {
      SQLITE = await import('node:sqlite');
    } catch {
      SQLITE = null;
    }
  }
  return SQLITE;
}
function openRo(p, stopped) {
  if (!SQLITE) throw new Error(`This Node (${process.version}) can't read databases: use Node 22.5 or newer, or the Python collector.`);
  const idle = !exists(p + '-wal') && !exists(p + '-shm');
  const tries = [];
  if (stopped || idle) tries.push(() => new SQLITE.DatabaseSync(new URL(pathToFileURL(path.resolve(p)).href + '?immutable=1'), { readOnly: true }));
  tries.push(() => new SQLITE.DatabaseSync(path.resolve(p), { readOnly: true }));
  let last;
  for (const t of tries) {
    try {
      const db = t();
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return db;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
/** The length of Python's json.dumps(x, ensure_ascii=False) (the size estimate matches the Python collector). */
function pyLen(x) {
  if (x === null || typeof x !== 'object') return typeof x === 'string' ? [...JSON.stringify(x)].length : typeof x === 'number' && Number.isInteger(x) === false ? String(x).length : JSON.stringify(x === undefined ? null : x).length;
  if (Array.isArray(x)) return 2 + x.reduce((n, v) => n + pyLen(v), 0) + Math.max(0, x.length - 1) * 2;
  const e = Object.entries(x);
  return 2 + e.reduce((n, [k, v]) => n + [...JSON.stringify(k)].length + 2 + pyLen(v), 0) + Math.max(0, e.length - 1) * 2;
}
const qident = (name) => `"${String(name).replaceAll('"', '""')}"`;
function storeId(spec, taken) {
  const base0 = path.posix.basename(spec.rel);
  const i = base0.lastIndexOf('.');
  const relNoExt = i > 0 ? spec.rel.slice(0, spec.rel.length - (base0.length - i)) : spec.rel;
  const base = `${spec.root}-${relNoExt}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'store';
  let sid = base;
  let k = 2;
  while (taken.has(sid)) sid = `${base}-${k++}`;
  taken.add(sid);
  return sid;
}
const telemetryByName = (name) => nameWords(name).some((x) => TELEMETRY_WORD.test(x)) || /^(autonomy|loop|token|tokens)_/i.test(name);
const jsonNum = (v) => (typeof v === 'bigint' ? (v <= 9007199254740991n && v >= -9007199254740991n ? Number(v) : String(v)) : v);

function analyzeSqlite(spec, plan) {
  const info = { tables: [], error: null, sql: '' };
  let db;
  try {
    db = openRo(spec.src, plan.opts.stopped);
  } catch (e) {
    info.error = String(e.message ?? e);
    return info;
  }
  try {
    const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type DESC, name').all();
    info.sql = rows.filter((r) => r.sql).map((r) => r.sql + ';').join('\n');
    const virtual = new Set(rows.filter((r) => r.type === 'table' && String(r.sql ?? '').toUpperCase().startsWith('CREATE VIRTUAL')).map((r) => r.name));
    const indexes = {};
    for (const r of rows) if (r.type === 'index') (indexes[r.tbl_name] ??= []).push(r.name);
    const reader = spec.reader;
    for (const r of rows) {
      if (r.type !== 'table') continue;
      const name = r.name;
      const t = { name, columns: [], indexes: indexes[name] ?? [], foreignKeys: [], rows: 0, verdict: 'data', why: '' };
      try {
        for (const c of db.prepare(`PRAGMA table_info(${qident(name)})`).all()) t.columns.push({ name: c.name, type: c.type || '', pk: Boolean(c.pk), nullable: !c.notnull });
        for (const fk of db.prepare(`PRAGMA foreign_key_list(${qident(name)})`).all()) t.foreignKeys.push({ from: fk.from, table: fk.table, to: fk.to });
      } catch {
        /* a table it can't describe */
      }
      t.withoutRowid = String(r.sql ?? '').toUpperCase().includes('WITHOUT ROWID');
      const known = READER_TABLES[reader] ?? new Set();
      const cats = categoriesOf(name, ...t.columns.map((c) => c.name));
      if (name.startsWith('sqlite_') || DERIVED_TABLE.test(name) || virtual.has(name)) [t.verdict, t.why] = ['derived', 'search index or internal table (Sara builds her own)'];
      else if (known.has(name)) t.verdict = 'data';
      else if (SECRET_TABLE.test(name)) [t.verdict, t.why] = ['secret', 'looks like sign-ins or keys: never collected'];
      else if (reader === 'openclaw-state' && !AUTOMATION_TABLE.test(name)) [t.verdict, t.why] = ['other', 'shared state (only the automations are read)'];
      else if (reader === 'openclaw-agent' && /(^|_)(chunks?|memory_index|vectors?)$/i.test(name)) [t.verdict, t.why] = ['derived', 'memory search index (Sara builds her own)'];
      else if (reader === 'hermes-state' && !known.has(name)) [t.verdict, t.why] = ['other', 'session store internals'];
      try {
        t.rows = t.verdict !== 'derived' && t.verdict !== 'secret' ? Number(Object.values(db.prepare(`SELECT count(*) FROM ${qident(name)}`).get())[0]) : 0;
      } catch (e) {
        [t.verdict, t.why] = ['unreadable', String(e.message ?? e)];
      }
      if (t.verdict === 'data' && !known.has(name) && telemetryByName(name)) {
        const texty = t.columns.some((c) => c.type.toUpperCase().includes('CHAR') || c.type.toUpperCase().includes('TEXT') || c.type === '');
        if (t.rows > 50000 || !texty || (t.columns.length && t.columns.filter((c) => /INT|REAL|NUM|BOOL|DATE|TIME/.test(c.type.toUpperCase())).length >= 0.7 * t.columns.length)) [t.verdict, t.why] = ['telemetry', 'a log or telemetry table'];
      }
      if (cats.size && t.verdict === 'data') t.cats = sorted(cats);
      if (t.verdict === 'data' && t.rows && !plan.opts.schema_only) {
        try {
          const smp = [...iterTable(db, name, t.columns, t.withoutRowid, SAMPLE_ROWS)];
          t.avgRowBytes = Math.trunc(smp.reduce((n, x) => n + pyLen(x), 0) / Math.max(1, smp.length)) + 12;
          if (name === 'schema_version' && smp.length) {
            const vals = smp.flatMap((x) => Object.values(x)).filter((v) => Number.isInteger(v));
            if (vals.length) plan.schemaVersion = Math.max(...vals);
          }
        } catch {
          t.avgRowBytes = 200;
        }
      }
      info.tables.push(t);
    }
  } finally {
    db.close();
  }
  return info;
}

function cell(col, v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return jsonNum(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Uint8Array) {
    const b = Buffer.from(v);
    if (EMBED_COL.test(col || '') && b.length % 4 === 0) return { $skipped: 'embedding', bytes: b.length };
    return { $blob: crypto.createHash('sha256').update(b).digest('hex'), bytes: b.length };
  }
  const s = String(v);
  const len = s.length > MAX_CELL_TEXT / 2 ? [...s].length : s.length;
  if (len > MAX_CELL_TEXT) return { $blob: crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'), bytes: len, text: true };
  if (s && SECRET_KEY.test(col || '') && !HARMLESS_KEY.test(col || '') && !/^(.*_)?(id|ids|count|at|on|name|type|kind|by)$/i.test(col || '')) {
    REDACT.text += 1;
    return { $redacted: 'key', len: [...s].length };
  }
  return scrubText(s);
}
function* iterTable(db, table, cols, withoutRowid, limit, where = '') {
  const names = cols.map((c) => c.name);
  let order = 'rowid';
  if (withoutRowid) {
    const pk = cols.filter((c) => c.pk).map((c) => c.name);
    order = pk.length ? pk.map(qident).join(', ') : '1';
  }
  const sel = names.map(qident).join(', ') || '*';
  const w_ = where ? ` WHERE ${where}` : '';
  const lim = limit ? ` LIMIT ${limit}` : '';
  let st;
  try {
    st = db.prepare(`SELECT ${sel} FROM ${qident(table)}${w_} ORDER BY ${order}${lim}`);
  } catch {
    st = db.prepare(`SELECT ${sel} FROM ${qident(table)}${w_}${lim}`);
  }
  if (st.setReadBigInts) st.setReadBigInts(true);
  if (st.setReturnArrays) st.setReturnArrays(true);
  for (const row of st.iterate()) {
    const vals = Array.isArray(row) ? row : Object.values(row);
    const out = {};
    for (let k = 0; k < names.length; k++) out[names[k]] = cell(names[k], vals[k]);
    yield out;
  }
}
function chatsWhere(spec, t, opts) {
  const n = opts.max_chats;
  if (!n || spec.reader !== 'hermes-state') return '';
  const cols = t.columns.map((c) => c.name);
  const newest = `SELECT id FROM sessions ORDER BY started_at DESC LIMIT ${Math.trunc(n)}`;
  if (t.name === 'sessions' && cols.includes('id')) return `id IN (${newest})`;
  if (t.name === 'messages' && cols.includes('session_id')) return `session_id IN (${newest})`;
  return '';
}
// ---------------------------------------------------------------------------------------------
// Progress: one line on stderr so a long read never looks stuck; --progress json for Sara
// ---------------------------------------------------------------------------------------------
export const Progress = {
  mode: 'line',
  last: 0,
  shown: false,
  sink: null,
  say(key, msg, n = null, force = false) {
    const now = Date.now();
    if (!force && now - this.last < 400) return;
    this.last = now;
    if (this.sink) return this.sink({ progress: key, text: msg, n });
    if (this.mode === 'off') return;
    if (this.mode === 'json') process.stderr.write(JSON.stringify({ progress: key, text: msg, n }) + '\n');
    else if (process.stderr.isTTY) {
      process.stderr.write('\r' + msg.slice(0, 110).padEnd(110));
      this.shown = true;
    } else process.stderr.write(msg + '\n');
  },
  done() {
    if (this.shown) {
      process.stderr.write('\r' + ' '.repeat(110) + '\r');
      this.shown = false;
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Building the plan
// ---------------------------------------------------------------------------------------------
const countEntriesHermes = (text) => {
  const parts = text.split('\u00a7').map((p) => p.trim());
  return parts.filter((p) => (p && !/^(#|\[|memory store|user profile)/i.test(p)) || (p && parts.length > 1)).length;
};
function countCron(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    try {
      v = json5Loads(text);
    } catch {
      return 0;
    }
  }
  if (obj(v)) v = v.jobs || v.items || [];
  return Array.isArray(v) ? v.length : 0;
}
function displayName(plan) {
  if (plan.opts.schema_only) return plan.cand.agentId;
  const NAME = /^\s*[-*]?\s*\**name\**\s*[:\uff1a]\s*\**([^\n*]{1,40})/im;
  for (const it of plan.items) {
    if (it.kind === 'ws-identity') {
      const m = NAME.exec(readText(it.src, 64 * 1024));
      if (m) return m[1].trim();
    }
  }
  for (const it of plan.items) {
    const scanned = it.kind === 'persona-extra' && /^(SOUL|IDENTITY|PERSONA|CHARACTER)\.md$/i.test(path.posix.basename(it.rel));
    if (it.kind === 'persona' || it.kind === 'ws-persona' || scanned) {
      const text = readText(it.src, 64 * 1024);
      const m = NAME.exec(text) || /^#\s+(?:I am |I'm )?([A-Z][\w\- ]{0,30})\s*$/m.exec(text);
      if (m && !/^(soul|identity|persona|who i am|about me)$/i.test(m[1].trim())) return m[1].trim();
    }
  }
  return plan.cand.agentId;
}

export async function buildPlan(cand, opts) {
  await sqliteModule();
  const plan = new Plan(cand, opts);
  if (cand.kind === 'openclaw') {
    const state = cand.roots.find((r) => r[0] === 'state')[2];
    const { includes, error } = loadOpenclawConfig(state);
    plan.includes = includes.map((p) => path.resolve(p));
    if (error) plan.notes.push(`openclaw.json could not be read confidently (${error}): only its key names are packed`);
  }
  for (const [rootId, role, p] of cand.roots) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      fs.readdirSync(p);
    } catch {
      plan.skip(rootId + '/', 'unreadable', 0, 1, 'no permission');
      continue;
    }
    walkRoot(plan, rootId, role, p);
  }
  const taken = new Set();
  for (const spec of plan.stores) {
    spec.id = storeId(spec, taken);
    Progress.say('count', `Counting what is in ${path.posix.basename(spec.rel)}...`, null, true);
    spec.info = analyzeSqlite(spec, plan);
    if (spec.info.error) plan.skip(`${spec.root}/${spec.rel}`, 'unreadable', spec.bytes, 1, spec.info.error);
  }
  plan.stores = plan.stores.filter((s) => !s.info.error);
  if (opts.postgres?.length || opts.postgres_dump?.length) plan.notes.push('Postgres databases and dumps are read by the Python collector (sara-movein.py): this one left them out.');
  for (const it of plan.items) {
    if (it.kind !== 'config' || opts.schema_only) continue;
    const before = REDACT.config;
    const text = readText(it.src, 8 * MiB);
    const yaml = /\.(yaml|yml)$/.test(it.rel);
    try {
      const tree = yaml ? yamlLoads(text) : json5Loads(text);
      it.tree = { $format: yaml ? 'yaml' : 'json5', tree: redactTree(tree) };
    } catch (e) {
      it.tree = { $format: 'skeleton', why: String(e.message ?? e).slice(0, 200), keys: keySkeletonLines(text) };
    }
    it.redacted = REDACT.config - before;
  }
  plan.display = displayName(plan);
  plan.layout = sorted(new Set([...plan.stores.filter((s) => s.reader !== 'custom').map((s) => s.rel), ...plan.items.filter((it) => it.kind === 'cron').map((it) => it.rel), ...(plan.items.some((it) => it.kind === 'session' && it.rel.endsWith('.jsonl')) ? ['sessions-jsonl'] : []), ...(plan.items.some((it) => it.kind === 'daily') ? ['memory-daily'] : [])]));
  return plan;
}

function categoryCounts(plan) {
  const out = {};
  const o = (c) => (out[c] ??= { items: 0, bytes: 0, files: 0, tables: 0, stores: new Set() });
  for (const it of plan.items) for (const c of it.cats ?? []) {
    const x = o(c);
    x.items++;
    x.files++;
    x.bytes += it.bytes;
  }
  for (const s of plan.stores) for (const t of s.info.tables) for (const c of t.cats ?? []) {
    const x = o(c);
    x.items++;
    x.tables++;
    x.stores.add(s.id);
    x.bytes += t.rows * (t.avgRowBytes ?? 200);
  }
  return out;
}
function applyCategories(plan, chosen) {
  const keep = [];
  for (const it of plan.items) {
    const off = (it.cats ?? []).filter((c) => !chosen.has(c));
    if (off.length && it.kind !== 'config') plan.skip(`${it.root}/${it.rel}`, 'sensitive-unchosen', it.bytes, 1, off.join(', '));
    else keep.push(it);
  }
  plan.items = keep;
  for (const s of plan.stores) for (const t of s.info.tables) {
    const off = (t.cats ?? []).filter((c) => !chosen.has(c));
    if (off.length) {
      [t.verdict, t.why] = ['sensitive-unchosen', off.join(', ')];
      plan.skip(`${s.root}/${s.rel}:${t.name}`, 'sensitive-unchosen', t.rows * (t.avgRowBytes ?? 200), 1, off.join(', '));
    }
  }
  plan.chosen = sorted(chosen);
}
function sections(plan) {
  const base = (p) => path.posix.basename(p);
  if (plan.opts.schema_only) {
    const by = {};
    for (const it of plan.items) {
      by[it.kind] ??= [0, 0];
      by[it.kind][0]++;
      by[it.kind][1] += it.bytes;
    }
    return [['files', sorted(Object.keys(by)).map((k) => `${k}: ${by[k][0]} (${human(by[k][1])})`).join(', '), 'pack']];
  }
  const rows = [];
  const items = plan.items;
  const persona = items.filter((it) => ['persona', 'ws-persona', 'ws-identity'].includes(it.kind));
  const extra = items.filter((it) => it.kind === 'persona-extra');
  const hist = items.filter((it) => it.kind === 'history');
  if (persona.length || extra.length) {
    let txt = persona.slice(0, 3).map((it) => `${base(it.rel)} (${human(it.bytes)})`).join(' + ');
    if (extra.length) txt += (txt ? ' + ' : '') + `${extra.length} other persona files`;
    if (hist.length) txt += ` + ${hist.length} older versions (history)`;
    rows.push(['personality', txt, 'pack']);
  }
  const mem = items.filter((it) => ['memory', 'ws-memory', 'ws-profile'].includes(it.kind));
  const daily = items.filter((it) => it.kind === 'daily');
  if (mem.length || daily.length) {
    const parts = mem.map((it) => {
      const text = readText(it.src, MAX_TEXT_FILE);
      const n = it.kind === 'memory' ? countEntriesHermes(text) : (text.match(/<!--\s*observed:/g)?.length || text.match(/^\s*[-*] /gm)?.length || 0);
      return `${base(it.rel)} ${n} entries`;
    });
    if (daily.length) parts.push(`${daily.length} daily files`);
    rows.push(['memories', parts.join(', '), 'pack']);
  }
  const sess = [];
  for (const s of plan.stores) {
    if (s.reader === 'hermes-state') {
      const t = Object.fromEntries(s.info.tables.map((x) => [x.name, x]));
      sess.push(`state.db: ${num(t.sessions?.rows ?? 0)} sessions, ${num(t.messages?.rows ?? 0)} messages (${human(s.bytes)})`);
    }
    if (s.reader === 'openclaw-agent') {
      const data = s.info.tables.filter((x) => x.verdict === 'data');
      sess.push(`openclaw-agent.sqlite: ${data.length} tables, ${num(data.reduce((n, x) => n + x.rows, 0))} rows`);
    }
  }
  const jl = items.filter((it) => it.kind === 'session' && it.rel.endsWith('.jsonl'));
  if (jl.length) sess.push(`${jl.length} session files (${human(jl.reduce((n, it) => n + it.bytes, 0))})`);
  if (sess.length) rows.push(['sessions', sess.join('; '), 'pack']);
  const sk = items.filter((it) => it.kind === 'skill');
  if (sk.length) rows.push(['skills', `${sk.filter((it) => base(it.rel) === 'SKILL.md').length} folders (${human(sk.reduce((n, it) => n + it.bytes, 0))})`, 'pack']);
  const cron = items.filter((it) => it.kind === 'cron');
  const auto = plan.stores.filter((s) => s.reader === 'openclaw-state').flatMap((s) => s.info.tables.filter((x) => x.verdict === 'data'));
  if (cron.length || auto.length) {
    let txt = cron.map((it) => `${it.rel}: ${countCron(readText(it.src, MAX_TEXT_FILE))} jobs`).join(', ');
    if (auto.length) txt += (txt ? ', ' : '') + `state/openclaw.sqlite: ${auto.reduce((n, x) => n + x.rows, 0)} automation rows`;
    rows.push(['schedules', txt, 'pack']);
  }
  const kb = plan.stores.filter((s) => s.reader === 'hermes-kanban');
  if (kb.length) rows.push(['board', `${kb.length} board(s): ${num(kb.flatMap((s) => s.info.tables.filter((x) => x.name === 'tasks')).reduce((n, x) => n + x.rows, 0))} tasks`, 'pack']);
  const hooks = items.filter((it) => it.kind === 'hook');
  const plugs = items.filter((it) => it.kind === 'plugin');
  if (hooks.length || plugs.length) {
    const nh = new Set(hooks.filter((it) => it.rel.includes('/')).map((it) => it.rel.split('/')[1])).size;
    const np = new Set(plugs.filter((it) => it.rel.includes('/')).map((it) => it.rel.split('/').slice(0, 2).join('/'))).size;
    rows.push(['code', `${nh} hooks, ${np} plugins (source, ${human([...hooks, ...plugs].reduce((n, it) => n + it.bytes, 0))}) - read, never run`, 'pack']);
  }
  const custom = plan.stores.filter((s) => s.reader === 'custom');
  if (custom.length) {
    const tabs = custom.flatMap((s) => s.info.tables);
    const data = tabs.filter((t) => t.verdict === 'data').length;
    const tele = tabs.filter((t) => t.verdict === 'telemetry').length;
    rows.push(['stores', `${custom.length} stores, ${tabs.length} tables: ${data} data, ${tele} telemetry, ${tabs.length - data - tele} other (${human(custom.reduce((n, s) => n + s.bytes, 0))})`, 'schema + data tables']);
  }
  const cfg = items.filter((it) => it.kind === 'config');
  if (cfg.length) rows.push(['config', cfg.map((it) => `${base(it.rel)} (secrets removed: ${it.redacted ?? 0} values)`).join(', '), 'pack']);
  return rows;
}
function estimateBytes(plan) {
  let total = plan.items.reduce((n, it) => n + it.bytes, 0);
  for (const s of plan.stores) for (const t of s.info.tables) {
    if (t.verdict === 'data') total += t.rows * (t.avgRowBytes ?? 200);
    total += 8 * 1024;
  }
  return Math.trunc(total * 0.45) + 64 * 1024;
}
function printPlan(plan, p = (s = '') => process.stdout.write(s + '\n')) {
  const pad = (s, n) => String(s).padEnd(n);
  p(w('title', { v: VERSION }));
  p();
  const roleWord = { 'hermes-home': 'Hermes Agent home', 'openclaw-state': 'OpenClaw state', 'openclaw-workspace': 'OpenClaw workspace', scan: 'Folder' };
  for (const [, role, rp] of plan.cand.roots) p(`${w('found')}: ${roleWord[role]}  ${tilde(rp)}  (${plan.cand.agentId})`);
  for (const [key, txt, act] of sections(plan)) p(`  ${pad(WORDS[key] ? w(key) : key, 15)} ${pad(txt, 60)} ${act === 'pack' ? w('pack') : act}`);
  p(w('skipped'));
  const sk = plan.skips;
  if (sk.secret) {
    const names = sorted(new Set(sk.secret.examples.map((x) => path.posix.basename(x.replace(/\/$/, '')) + (x.endsWith('/') ? '/' : '')))).join(', ');
    p(`  ${pad(w('secrets'), 15)} ${pad(`${names} (${w('never_opened')})`, 60)} -`);
  }
  for (const [key, reason] of [['logs', 'log'], ['media', 'media'], ['backups', 'backup'], ['codeenv', 'code-env'], ['telemetry', 'telemetry'], ['other', 'other']]) if (sk[reason]) p(`  ${pad(w(key), 15)} ${pad(`${num(sk[reason].files)} files, ${human(sk[reason].bytes)}`, 60)} ${w('skip')}`);
  const tele = plan.stores.flatMap((s) => s.info.tables.filter((t) => t.verdict === 'telemetry'));
  if (tele.length) p(`  ${pad(w('telemetry'), 15)} ${pad(`${tele.length} tables in stores (${tele.slice(0, 3).map((t) => t.name).join(', ')}, ...)`, 60)} schema + samples`);
  for (const reason of ['too-big', 'unreadable', 'derived', 'owner-never', 'since']) if (sk[reason]) p(`  ${pad(reason, 15)} ${pad(`${num(sk[reason].files)} files, ${human(sk[reason].bytes)}`, 60)} ${w('skip')}`);
  p(w('sensitive'));
  for (const cat of ['medical', 'intimate', 'finances']) {
    const c = plan.catCounts[cat];
    const state = plan.chosen ? (plan.chosen.includes(cat) ? 'yes' : 'no') : DEFAULT_CATEGORIES_ON.has(cat) ? '[Y/n]' : '[y/N]';
    if (c) p(`  ${pad(w(cat), 15)} ${pad(`${c.files} files, ${c.tables} tables in ${c.stores.size} stores (${human(c.bytes)})`, 60)} ${state}`);
    else p(`  ${pad(w(cat), 15)} ${w('none_found')}`);
  }
  for (const n of plan.notes) p('Note: ' + n);
  p(`${w('bundle')}: ~${human(estimateBytes(plan))} -> ${plan.outPath}`);
  p(w('diary'));
}
function tableJson(t, schemaOnly) {
  const out = { name: t.name, rows: t.rows, verdict: t.verdict, cats: t.cats ?? [] };
  if (t.schema) out.schema = t.schema;
  if (schemaOnly) {
    out.columns = (t.columns ?? []).map((c) => ({ name: c.name, type: c.type || '', pk: Boolean(c.pk) }));
    out.foreignKeys = t.foreignKeys ?? [];
    if (t.kind) out.kind = t.kind;
    if (t.why) out.why = t.why;
  }
  return out;
}
export function planJson(plan) {
  const schemaOnly = Boolean(plan.opts.schema_only);
  const byKind = {};
  for (const k of sorted(new Set(plan.items.map((it) => it.kind)))) byKind[k] = plan.items.filter((it) => it.kind === k).length;
  return {
    collector: VERSION,
    source: { kind: plan.cand.kind, agentId: plan.cand.agentId, displayName: plan.display, layout: plan.layout, schemaVersion: plan.schemaVersion },
    roots: plan.cand.roots.map((r) => ({ id: r[0], role: r[1], path: tilde(r[2]) })),
    sections: sections(plan).map(([key, text, action]) => ({ key, text, action })),
    packed: { files: plan.items.length, bytes: plan.items.reduce((n, it) => n + it.bytes, 0), byKind },
    stores: plan.stores.map((s) => ({ id: s.id, source: `${s.root}/${s.rel}`, reader: s.reader, bytes: s.bytes, kind: 'sqlite', tables: s.info.tables.map((t) => tableJson(t, schemaOnly)) })),
    skipped: Object.fromEntries(Object.entries(plan.skips).map(([r, v]) => [r, { files: v.files, bytes: v.bytes }])),
    categories: Object.fromEntries(Object.entries(plan.catCounts).map(([c, v]) => [c, { files: v.files, tables: v.tables, bytes: v.bytes, chosen: (plan.chosen ?? []).includes(c) }])),
    redactions: { config: plan.items.reduce((n, it) => n + (it.redacted ?? 0), 0), text: REDACT.text },
    estimateBytes: estimateBytes(plan),
    notes: plan.notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Writing the bundle (section 5): one zip (ZIP64 when big), hashes.txt last
// ---------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf, crc = 0) {
  crc = ~crc;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}
class ZipWriter {
  constructor(fd) {
    this.fd = fd;
    this.offset = 0;
    this.central = [];
  }
  #write(b) {
    fs.writeSync(this.fd, b);
    this.offset += b.length;
  }
  /** One entry from chunks (deflated in one go; a part is at most ROWS_PART_BYTES). */
  add(name, chunks) {
    const data = Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c)));
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const nameB = Buffer.from(name, 'utf8');
    const big = data.length >= 0xffffffff || comp.length >= 0xffffffff || this.offset >= 0xffffffff;
    const local = Buffer.alloc(30);
    const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
    if (big) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(comp.length), 12);
    }
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(big ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(big ? 0xffffffff : comp.length, 18);
    local.writeUInt32LE(big ? 0xffffffff : data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const at = this.offset;
    this.#write(local);
    this.#write(nameB);
    this.#write(extra);
    this.#write(comp);
    this.central.push({ nameB, crc, size: data.length, csize: comp.length, at });
  }
  finish() {
    const start = this.offset;
    for (const e of this.central) {
      const big = e.size >= 0xffffffff || e.csize >= 0xffffffff || e.at >= 0xffffffff;
      const extra = big ? Buffer.alloc(28) : Buffer.alloc(0);
      if (big) {
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(e.size), 4);
        extra.writeBigUInt64LE(BigInt(e.csize), 12);
        extra.writeBigUInt64LE(BigInt(e.at), 20);
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | (big ? 45 : 20), 4);
      h.writeUInt16LE(big ? 45 : 20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt32LE(0, 12);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(big ? 0xffffffff : e.csize, 20);
      h.writeUInt32LE(big ? 0xffffffff : e.size, 24);
      h.writeUInt16LE(e.nameB.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE((0o100600 << 16) >>> 0, 38);
      h.writeUInt32LE(big ? 0xffffffff : e.at, 42);
      this.#write(h);
      this.#write(e.nameB);
      this.#write(extra);
    }
    const size = this.offset - start;
    const n = this.central.length;
    if (n >= 0xffff || start >= 0xffffffff || size >= 0xffffffff) {
      const z = Buffer.alloc(56);
      const zAt = this.offset;
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(n), 24);
      z.writeBigUInt64LE(BigInt(n), 32);
      z.writeBigUInt64LE(BigInt(size), 40);
      z.writeBigUInt64LE(BigInt(start), 48);
      this.#write(z);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(zAt), 8);
      loc.writeUInt32LE(1, 16);
      this.#write(loc);
    }
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(Math.min(n, 0xffff), 8);
    e.writeUInt16LE(Math.min(n, 0xffff), 10);
    e.writeUInt32LE(Math.min(size, 0xffffffff), 12);
    e.writeUInt32LE(Math.min(start, 0xffffffff), 16);
    this.#write(e);
  }
}
const safeEntryName = (p) => {
  const parts = posix(p).split('/').filter((x) => x && x !== '.');
  if (parts.includes('..')) throw new Error(`bad path ${p}`);
  return parts.join('/').normalize('NFC');
};
const fileName = (s) => s.replace(/[^A-Za-z0-9_.\-]/g, '_');

function writeStore(zip, hashes, spec, opts, manifestItems) {
  const sid = spec.id;
  const base = `stores/${sid}/`;
  const tables = spec.info.tables;
  const written = {};
  const entry = (name, chunks) => {
    const b = Buffer.concat(chunks.map((c) => Buffer.from(c, 'utf8')));
    hashes.push([crypto.createHash('sha256').update(b).digest('hex'), b.length, name]);
    zip.add(name, [b]);
  };
  const db = openRo(spec.src, opts.stopped);
  try {
    entry(base + 'schema.sql', [spec.info.sql]);
    for (const t of tables) {
      if (['derived', 'secret', 'unreadable', 'sensitive-unchosen'].includes(t.verdict)) continue;
      const fname = fileName(t.name);
      entry(base + `samples/${fname}.jsonl`, [...iterTable(db, t.name, t.columns, t.withoutRowid, SAMPLE_ROWS)].map((row) => JSON.stringify({ t: t.name, r: row }) + '\n'));
      if (t.verdict !== 'data') continue;
      const where = chatsWhere(spec, t, opts);
      const slim = spec.reader === 'hermes-state' && t.name === 'messages';
      const label = slim ? 'Reading past chats' : `Reading ${t.name}`;
      const cols = slim ? t.columns.filter((c) => HERMES_MESSAGE_COLS.has(c.name)) : t.columns;
      if (slim && cols.length < t.columns.length) t.slim = sorted(t.columns.filter((c) => !HERMES_MESSAGE_COLS.has(c.name)).map((c) => c.name));
      let part = 1;
      let chunks = [];
      let size = 0;
      let n = 0;
      for (let row of iterTable(db, t.name, cols, t.withoutRowid, null, where)) {
        if (slim) row = slimHermesMessage(row);
        const line = JSON.stringify({ t: t.name, r: row }) + '\n';
        if (size + line.length > ROWS_PART_BYTES && n) {
          entry(base + `rows/${fname}.${part}.jsonl`, chunks);
          part++;
          chunks = [];
          size = 0;
        }
        chunks.push(line);
        size += line.length;
        n++;
        if (n % 500 === 0) Progress.say('rows', `${label}... ${num(n)} of ${num(t.rows)}`, n);
      }
      entry(base + `rows/${fname}.${part}.jsonl`, chunks);
      written[t.name] = n;
    }
  } finally {
    db.close();
  }
  const schema = { id: sid, source: `${spec.root}/${spec.rel}`, kind: 'sqlite', reader: spec.reader, bytes: spec.bytes, client: null, tables: tables.map((t) => ({ ...Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'avgRowBytes')), written: written[t.name] ?? 0 })) };
  entry(base + 'schema.json', [JSON.stringify(schema, null, 1)]);
  manifestItems.push({ path: base, kind: 'sqlite', source: schema.source, reader: spec.reader, tables: tables.length, rows: Object.values(written).reduce((a, b) => a + b, 0) });
}

const SELF = fileURLToPath(import.meta.url);
const selfSha = () => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(SELF)).digest('hex');
  } catch {
    return '';
  }
};
function localZone() {
  if (process.env.TZ) return process.env.TZ;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function writeBundle(plan, outPath) {
  const opts = plan.opts;
  const need = estimateBytes(plan);
  const targetDir = path.dirname(path.resolve(outPath));
  try {
    const st = fs.statfsSync?.(targetDir);
    if (st && st.bavail * st.bsize < need * 1.1) throw new Error(`Not enough free space in ${targetDir}: about ${human(need * 1.1)} needed, ${human(st.bavail * st.bsize)} free. Use --out on a bigger disk.`);
  } catch (e) {
    if (/Not enough free space/.test(e.message)) throw e;
  }
  const tmp = `${outPath}.partial-${process.pid}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  const hashes = [];
  const itemsOut = [];
  let ok = false;
  try {
    const zip = new ZipWriter(fd);
    const entry = (name, data) => {
      const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      hashes.push([crypto.createHash('sha256').update(b).digest('hex'), b.length, name]);
      zip.add(name, [b]);
    };
    plan.items.forEach((it, k) => {
      if (k % 50 === 0) Progress.say('write', `Packing files... ${k} of ${plan.items.length}`, k);
      let name = safeEntryName(it.path);
      const rec = { path: name, kind: it.kind, bytes: it.bytes, mtime: it.mtime };
      for (const key of ['history', 'of', 'cats']) if (it[key] && (!Array.isArray(it[key]) || it[key].length)) rec[key] = it[key];
      if (it.kind === 'config') {
        name += '.json';
        rec.path = name;
        rec.format = it.tree.$format;
        rec.redacted = it.redacted ?? 0;
        entry(name, JSON.stringify(it.tree, null, 1));
      } else {
        const data = readBytes(it.src);
        const text = TEXT_KINDS.has(it.kind) || it.kind.startsWith('ws-');
        entry(name, text ? Buffer.from(scrubText(new TextDecoder('utf-8').decode(data)), 'utf8') : data);
      }
      itemsOut.push(rec);
    });
    for (const spec of plan.stores) {
      Progress.say('write', `Reading ${path.posix.basename(spec.rel)}...`, null, true);
      writeStore(zip, hashes, spec, opts, itemsOut);
    }
    const pj = planJson(plan);
    entry('plan.json', JSON.stringify({ ...pj, skippedList: plan.skipList }, null, 1));
    const manifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      collector: { version: VERSION, sha256: selfSha(), node: process.versions.node, os: `${process.platform}-${process.arch}` },
      createdAt: isoUtc(),
      timeZone: localZone(),
      source: { kind: plan.cand.kind, agentId: plan.cand.agentId, displayName: plan.display, detected: { schemaVersion: plan.schemaVersion, layout: plan.layout } },
      roots: plan.cand.roots.map((r) => ({ id: r[0], role: r[1], path: tilde(r[2]) })),
      items: itemsOut,
      skipped: plan.skipList,
      categories: Object.fromEntries(['medical', 'intimate', 'finances'].map((c) => [c, { chosen: plan.chosen.includes(c), items: plan.catCounts[c]?.items ?? 0 }])),
      redactions: { config: plan.items.reduce((n, it) => n + (it.redacted ?? 0), 0), text: REDACT.text },
      postgres: [],
    };
    entry('manifest.json', JSON.stringify(manifest, null, 1));
    zip.add('hashes.txt', [hashes.map(([h, n, nm]) => `${h}  ${n}  ${nm}\n`).join('')]);
    zip.finish();
    fs.closeSync(fd);
    fs.renameSync(tmp, outPath);
    ok = true;
  } finally {
    if (!ok) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
      fs.rmSync(tmp, { force: true });
    }
  }
  Progress.done();
  return outPath;
}

// ---------------------------------------------------------------------------------------------
// verify and send
// ---------------------------------------------------------------------------------------------
export function readZip(file) {
  const buf = fs.readFileSync(file);
  const out = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let n = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (n === 0xffff || off === 0xffffffff) {
    const loc = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    n = Number(buf.readBigUInt64LE(loc + 32));
    off = Number(buf.readBigUInt64LE(loc + 48));
  }
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(off + 10);
    let csize = buf.readUInt32LE(off + 20);
    const nl = buf.readUInt16LE(off + 28);
    const xl = buf.readUInt16LE(off + 30);
    const cl = buf.readUInt16LE(off + 32);
    let lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nl).toString('utf8');
    const extra = buf.subarray(off + 46 + nl, off + 46 + nl + xl);
    for (let x = 0; x + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(x);
      const sz = extra.readUInt16LE(x + 2);
      if (id === 1) {
        let k = x + 4;
        if (buf.readUInt32LE(off + 24) === 0xffffffff) k += 8;
        if (csize === 0xffffffff) {
          csize = Number(extra.readBigUInt64LE(k));
          k += 8;
        }
        if (lho === 0xffffffff) lho = Number(extra.readBigUInt64LE(k));
      }
      x += 4 + sz;
    }
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    off += 46 + nl + xl + cl;
  }
  return out;
}
function verify(file) {
  const z = readZip(file);
  let bad = 0;
  const lines = z.get('hashes.txt').toString('utf8').split('\n').filter(Boolean);
  const listed = new Set();
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) {2}(\d+) {2}(.+)$/.exec(line);
    if (!m) continue;
    listed.add(m[3]);
    const b = z.get(m[3]);
    if (!b || crypto.createHash('sha256').update(b).digest('hex') !== m[1] || b.length !== Number(m[2])) {
      bad++;
      console.log(`MISMATCH  ${m[3]}`);
    }
  }
  for (const x of z.keys()) if (!listed.has(x) && x !== 'hashes.txt') {
    bad++;
    console.log(`NOT LISTED  ${x}`);
  }
  const m = JSON.parse(z.get('manifest.json').toString('utf8'));
  console.log(`${m.format} ${m.version}  ${m.source?.displayName} (${m.source?.kind})  made ${m.createdAt} by collector ${m.collector?.version}`);
  console.log('  hashes: ' + (bad ? `${bad} problems` : `all ${lines.length} match`));
  return bad ? 1 : 0;
}
export async function send(file, to, code) {
  const base = to.replace(/\/+$/, '');
  if (!base.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(base) && !/^http:\/\/(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.[\d.]+(:\d+)?$/.test(base)) throw new Error('Use the https:// address of your Sara (plain http only on this computer or your home network).');
  const size = fs.statSync(file).size;
  const hdr = { 'content-type': 'application/json', 'x-movein-code': code };
  const call = async (method, url, body, headers = hdr) => {
    const r = await fetch(base + url, { method, headers, body });
    const t = await r.text();
    if (!r.ok) {
      let msg = t;
      try {
        msg = JSON.parse(t).error ?? t;
      } catch {
        /* text */
      }
      throw Object.assign(new Error(msg || `HTTP ${r.status}`), { status: r.status });
    }
    return t ? JSON.parse(t) : {};
  };
  const up = await call('POST', '/api/movein/send', JSON.stringify({ code, name: path.basename(file), size }));
  const chunk = Number(up.chunk || 8 * MiB);
  let offset = Number(up.received || 0);
  let tries = 0;
  const fd = fs.openSync(file, 'r');
  try {
    while (offset < size) {
      const b = Buffer.alloc(Math.min(chunk, size - offset));
      fs.readSync(fd, b, 0, b.length, offset);
      try {
        const r = await call('PUT', `/api/movein/uploads/${up.id}?offset=${offset}`, b, { 'content-type': 'application/octet-stream', 'x-movein-code': code });
        offset = Number(r.received ?? offset + b.length);
        tries = 0;
        Progress.say('send', `Sending to Sara... ${human(offset)} of ${human(size)}`, offset);
      } catch (e) {
        if (e.status === 401) throw e;
        if (++tries > 5) throw new Error(`The upload stopped (${e.message}). Run the same command again to resume.`);
        await new Promise((r) => setTimeout(r, 2000 * tries));
        offset = Number((await call('GET', `/api/movein/uploads/${up.id}`)).received ?? offset);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  await call('POST', `/api/movein/uploads/${up.id}/done`, '{}');
  Progress.done();
}

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const multi = new Set(['scan', 'include-category', 'exclude-category', 'include', 'exclude', 'never', 'include-table', 'postgres', 'postgres-dump']);
  const flags = new Set(['plan-only', 'json', 'yes', 'stopped', 'include-large', 'schema-only', 'allow-root', 'keep']);
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith('--')) {
      a._.push(x);
      continue;
    }
    let [k, v] = x.slice(2).split(/=(.*)/s);
    if (flags.has(k)) {
      a[k] = true;
      continue;
    }
    if (v === undefined) v = argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    if (multi.has(k)) (a[k] ??= []).push(v);
    else a[k] = v;
  }
  return a;
}
function ask(q, dflt) {
  if (!process.stdin.isTTY) return dflt;
  process.stdout.write(q);
  const b = Buffer.alloc(256);
  let s = '';
  try {
    for (;;) {
      const n = fs.readSync(0, b, 0, 256, null);
      if (!n) break;
      s += b.subarray(0, n).toString('utf8');
      if (s.includes('\n')) break;
    }
  } catch {
    return dflt;
  }
  s = s.trim().toLowerCase();
  return s ? 'yjso'.includes(s[0]) : dflt;
}

export async function main(argv = process.argv.slice(2)) {
  argv = [...argv];
  let cmd = 'collect';
  if (['collect', 'verify', 'send'].includes(argv[0])) cmd = argv.shift();
  const a = parseArgs(argv);
  LANG = pickLang(a.lang);
  if (a.progress) Progress.mode = a.progress;
  if (cmd === 'verify') return verify(a._[0]);
  if (cmd === 'send') {
    await send(a._[0], a.to, a.code);
    console.log('Sent. Sara takes it from here: look at her Move in page.');
    return 0;
  }
  if (process.getuid?.() === 0 && !a['allow-root']) {
    console.log("This collector does not run as root (it could read other people's files). Run it as the user your agent runs as, or add --allow-root with --hermes-home / --openclaw-state.");
    return 2;
  }
  if (a['section-files']) SECTION_FILES = Number(a['section-files']);
  const opts = { hermes_home: a['hermes-home'], openclaw_state: a['openclaw-state'], workspace: a.workspace, scan: a.scan, postgres: a.postgres, postgres_dump: a['postgres-dump'], schema_only: a['schema-only'], stopped: a.stopped, include: a.include, exclude: a.exclude, never: a.never, include_table: a['include-table'] ?? [], max_chats: Math.max(0, Number(a['max-chats'] || 0)), include_large: a['include-large'] };
  if (a.since) {
    const t = Date.parse(`${a.since}T00:00:00`);
    if (Number.isNaN(t)) {
      console.log('--since wants a date like 2026-01-31.');
      return 2;
    }
    opts.since_ts = t / 1000;
  }
  const cands = findCandidates(opts);
  if (!cands.length) {
    console.log(w('nothing'));
    return 1;
  }
  let cand;
  if (a.agent) {
    cand = cands.find((c) => c.agentId === a.agent);
    if (!cand) {
      console.log(`No agent or profile called ${JSON.stringify(a.agent)}. Found: ${cands.map((c) => c.agentId).join(', ')}`);
      return 1;
    }
  } else {
    cand = cands[0];
    if (cands.length > 1 && !a.json) console.log(`Several agents found; packing ${cand.agentId}. Pick another with --agent: ${cands.map((c) => c.agentId).join(', ')}`);
  }
  const plan = await buildPlan(cand, opts);
  Progress.done();
  if (opts.max_chats) plan.notes.push(`Only the newest ${num(opts.max_chats)} past chats are packed (--max-chats).`);
  for (const inc of opts.include_table) {
    const [db, tname] = [inc.split(':')[0], inc.split(':').slice(1).join(':')];
    for (const s of plan.stores) if ([s.rel, path.posix.basename(s.rel), s.id].includes(db)) for (const t of s.info.tables) if (t.name === tname && t.verdict === 'telemetry') [t.verdict, t.why] = ['data', 'included with --include-table'];
  }
  plan.catCounts = categoryCounts(plan);
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = plan.display.replace(/[^A-Za-z0-9_\-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'agent';
  const out = a.out || (a['send-to'] ? os.tmpdir() : '.');
  plan.outPath = path.resolve(isDir(out) ? path.join(out, `${slug}-${stamp}.saramove`) : out);
  const chosen = new Set([...DEFAULT_CATEGORIES_ON].filter((c) => !(a['exclude-category'] ?? []).includes(c)).concat(a['include-category'] ?? []));
  if (a['plan-only']) {
    if (a.json) {
      plan.chosen = sorted(chosen);
      console.log(JSON.stringify({ ...planJson(plan), candidates: cands.map((c) => ({ kind: c.kind, agentId: c.agentId })) }, (k, v) => (v instanceof Set ? sorted(v) : v), 1));
    } else {
      printPlan(plan);
      console.log(w('plan_only'));
    }
    return 0;
  }
  printPlan(plan);
  if (!a.yes) for (const cat of ['medical', 'intimate']) if (plan.catCounts[cat] && !chosen.has(cat) && ask(w('include_q', { what: w(cat) }), false)) chosen.add(cat);
  applyCategories(plan, chosen);
  if (!a.yes && !ask(w('continue_q'), true)) return 0;
  if (fs.existsSync(plan.outPath)) {
    console.log(`There is already a file at ${plan.outPath}: move it away or use --out.`);
    return 1;
  }
  const file = writeBundle(plan, plan.outPath);
  console.log(`${w('written')}: ${file} (${human(fs.statSync(file).size)})`);
  if (a['send-to']) {
    try {
      await send(file, a['send-to'], a.code ?? '');
    } catch (e) {
      console.log(`Not sent: ${e.message}`);
      console.log(`The file is still here: ${file}. On the Move in page, choose "Upload a file" and pick it.`);
      return 1;
    }
    if (!a.keep) fs.rmSync(file, { force: true });
    console.log('Sent to Sara. Look at your Sara: the move-in carries on there.');
    return 0;
  }
  console.log(w('diary'));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().then(
    (code) => process.exit(code ?? 0),
    (e) => {
      Progress.done();
      console.error(e?.message ?? e);
      process.exit(1);
    },
  );
}
