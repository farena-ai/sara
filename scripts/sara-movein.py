#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sara move-in collector (docs/design/MOVE_IN.md section 4).

Runs on the computer where your old agent (Hermes Agent or OpenClaw) lives and packs what Sara can
bring over into ONE file, <name>-<date>.saramove, that you then upload in Sara (Settings -> Data &
health -> Move in from another agent).

Read it before you run it. What it does, in plain words:
  * It only READS. Files are opened read-only, SQLite databases through read-only URIs, and the
    only file it creates is the bundle (written to a temporary name beside it, then renamed).
  * It never opens secrets: .env files, auth.json, credentials/, tokens, keys, browser profiles and
    the like are skipped by name before anything is read (their names and sizes are listed, so the
    move-in report can tell you what to reconnect).
  * Config files are packed with every secret-looking value replaced by {"$redacted": ...}; text
    files have secret-shaped strings replaced by "<<secret removed>>".
  * Logs, media, models, dated backups and telemetry are skipped by default (counted, with a reason).
  * Health/medical and intimate items are left out unless you say yes for that category.
  * No network, except `send` (an upload to YOUR Sara) and psql/pg_dump if you pass --postgres.

Commands:
  python3 sara-movein.py [collect] [options]   find the agent, show the plan, write the bundle
  python3 sara-movein.py collect --plan-only    only show the plan (writes nothing)
  python3 sara-movein.py verify FILE            re-check every hash in a bundle
  python3 sara-movein.py send FILE --to https://your-sara --code "six words from the page"

Python 3.6 or newer, standard library only. No installs.
"""
import base64
import fnmatch
import getpass
import hashlib
import io
import json
import locale
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import zipfile

VERSION = '2.37.0'
FORMAT = 'saramove'
FORMAT_VERSION = 1
MiB = 1024 * 1024

# ---------------------------------------------------------------------------------------------
# Limits (section 4.3 / 4.5)
# ---------------------------------------------------------------------------------------------
MAX_TEXT_FILE = 1 * MiB          # skill and persona text files
MAX_CODE_FILE = 512 * 1024       # hook / plugin source files
MAX_CELL_TEXT = 256 * 1024       # a TEXT value bigger than this becomes a reference
ROWS_PART_BYTES = 256 * MiB      # one rows/<table>.<n>.jsonl part (uncompressed)
SAMPLE_ROWS = 5
FETCH = 2000
DATED_HISTORY_KEEP = 3

# ---------------------------------------------------------------------------------------------
# The plan screen's words, in the six languages of Sara's app (section 4.8)
# ---------------------------------------------------------------------------------------------
WORDS = {
    'title': ['Sara move-in collector {v}  (read-only: nothing here will be changed)',
              'Recolector de mudanza de Sara {v}  (solo lectura: aquí no se cambia nada)',
              'Collecteur de déménagement de Sara {v}  (lecture seule : rien ne sera modifié ici)',
              'Sara-Umzugssammler {v}  (nur lesen: hier wird nichts verändert)',
              'Coletor de mudança da Sara {v}  (só leitura: nada aqui será alterado)',
              'Raccoglitore per il trasloco di Sara {v}  (sola lettura: qui non verrà cambiato nulla)'],
    'found': ['Found', 'Encontrado', 'Trouvé', 'Gefunden', 'Encontrado', 'Trovato'],
    'personality': ['Personality', 'Personalidad', 'Personnalité', 'Persönlichkeit', 'Personalidade', 'Personalità'],
    'memories': ['Memories', 'Recuerdos', 'Souvenirs', 'Erinnerungen', 'Memórias', 'Ricordi'],
    'sessions': ['Sessions', 'Sesiones', 'Sessions', 'Sitzungen', 'Sessões', 'Sessioni'],
    'skills': ['Skills', 'Habilidades', 'Compétences', 'Fähigkeiten', 'Habilidades', 'Abilità'],
    'schedules': ['Schedules', 'Programaciones', 'Planifications', 'Zeitpläne', 'Agendamentos', 'Programmazioni'],
    'board': ['Board', 'Tablero', 'Tableau', 'Board', 'Quadro', 'Bacheca'],
    'code': ['Hooks/plugins', 'Hooks/plugins', 'Hooks/plugins', 'Hooks/Plugins', 'Hooks/plugins', 'Hook/plugin'],
    'stores': ['Plugin stores', 'Almacenes de plugins', 'Bases des plugins', 'Plugin-Datenbanken', 'Bancos de plugins', 'Archivi dei plugin'],
    'config': ['Config', 'Configuración', 'Configuration', 'Einstellungen', 'Configuração', 'Configurazione'],
    'skipped': ['Skipped', 'Omitido', 'Ignoré', 'Übersprungen', 'Ignorado', 'Saltato'],
    'secrets': ['Secrets', 'Secretos', 'Secrets', 'Geheimnisse', 'Segredos', 'Segreti'],
    'logs': ['Logs', 'Registros', 'Journaux', 'Protokolle', 'Logs', 'Log'],
    'media': ['Media/models', 'Multimedia/modelos', 'Médias/modèles', 'Medien/Modelle', 'Mídia/modelos', 'Media/modelli'],
    'backups': ['Backups', 'Copias', 'Sauvegardes', 'Sicherungen', 'Backups', 'Backup'],
    'codeenv': ['Code/envs', 'Código/entornos', 'Code/environnements', 'Code/Umgebungen', 'Código/ambientes', 'Codice/ambienti'],
    'telemetry': ['Telemetry', 'Telemetría', 'Télémétrie', 'Telemetrie', 'Telemetria', 'Telemetria'],
    'other': ['Not understood', 'No entendido', 'Non compris', 'Nicht verstanden', 'Não entendido', 'Non capito'],
    'never_opened': ['never opened', 'nunca abiertos', 'jamais ouverts', 'nie geöffnet', 'nunca abertos', 'mai aperti'],
    'pack': ['pack', 'empaquetar', 'emballer', 'einpacken', 'empacotar', 'impacchettare'],
    'skip': ['skip', 'omitir', 'ignorer', 'überspringen', 'ignorar', 'saltare'],
    'sensitive': ['Sensitive (off until you say yes)', 'Sensible (desactivado hasta que digas que sí)', 'Sensible (désactivé tant que vous ne dites pas oui)',
                  'Sensibel (aus, bis du Ja sagst)', 'Sensível (desligado até você dizer sim)', 'Sensibile (spento finché non dici di sì)'],
    'medical': ['Health/medical', 'Salud/medicina', 'Santé/médical', 'Gesundheit/Medizin', 'Saúde/médico', 'Salute/medicina'],
    'intimate': ['Intimate', 'Íntimo', 'Intime', 'Intim', 'Íntimo', 'Intimo'],
    'finances': ['Finances', 'Finanzas', 'Finances', 'Finanzen', 'Finanças', 'Finanze'],
    'none_found': ['none found', 'nada encontrado', 'rien trouvé', 'nichts gefunden', 'nada encontrado', 'niente trovato'],
    'include_q': ['Include {what} items? [y/N] ', '¿Incluir elementos de {what}? [s/N] ', 'Inclure les éléments {what} ? [o/N] ',
                  '{what}-Elemente einpacken? [j/N] ', 'Incluir itens de {what}? [s/N] ', 'Includere gli elementi {what}? [s/N] '],
    'continue_q': ['Continue? [Y/n] ', '¿Continuar? [S/n] ', 'Continuer ? [O/n] ', 'Weiter? [J/n] ', 'Continuar? [S/n] ', 'Continuare? [S/n] '],
    'bundle': ['Bundle', 'Paquete', 'Paquet', 'Paket', 'Pacote', 'Pacchetto'],
    'diary': ['This file is as private as your diary: delete it after the move-in.',
              'Este archivo es tan privado como tu diario: bórralo después de la mudanza.',
              'Ce fichier est aussi privé que votre journal : supprimez-le après le déménagement.',
              'Diese Datei ist so privat wie dein Tagebuch: lösche sie nach dem Umzug.',
              'Este arquivo é tão privado quanto seu diário: apague-o depois da mudança.',
              'Questo file è privato come il tuo diario: cancellalo dopo il trasloco.'],
    'plan_only': ['Plan only: no bundle written.', 'Solo el plan: no se escribió ningún paquete.', 'Plan seulement : aucun paquet écrit.',
                  'Nur der Plan: kein Paket geschrieben.', 'Só o plano: nenhum pacote gravado.', 'Solo il piano: nessun pacchetto scritto.'],
    'written': ['Written', 'Escrito', 'Écrit', 'Geschrieben', 'Gravado', 'Scritto'],
    'nothing': ['No Hermes Agent home or OpenClaw state folder was found. Point at it with --hermes-home PATH or --openclaw-state PATH.',
                'No se encontró ninguna carpeta de Hermes Agent ni de OpenClaw. Indícala con --hermes-home RUTA o --openclaw-state RUTA.',
                'Aucun dossier Hermes Agent ou OpenClaw trouvé. Indiquez-le avec --hermes-home CHEMIN ou --openclaw-state CHEMIN.',
                'Kein Hermes-Agent- oder OpenClaw-Ordner gefunden. Gib ihn mit --hermes-home PFAD oder --openclaw-state PFAD an.',
                'Nenhuma pasta do Hermes Agent ou do OpenClaw encontrada. Indique-a com --hermes-home CAMINHO ou --openclaw-state CAMINHO.',
                'Nessuna cartella di Hermes Agent o OpenClaw trovata. Indicala con --hermes-home PERCORSO o --openclaw-state PERCORSO.'],
}
LANGS = ['en', 'es', 'fr', 'de', 'pt-BR', 'it']
LANG = 0


def w(key, **kw):
    s = WORDS[key][LANG]
    return s.format(**kw) if kw else s


def pick_lang(arg):
    raw = (arg or os.environ.get('LC_ALL') or os.environ.get('LANG') or '')
    if not raw:
        try:
            raw = locale.getdefaultlocale()[0] or ''
        except Exception:
            raw = ''
    raw = raw.replace('_', '-').split('.')[0]
    if raw.lower().startswith('pt'):
        return LANGS.index('pt-BR')
    for i, l in enumerate(LANGS):
        if raw.lower().startswith(l.lower()[:2]):
            return i
    return 0

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------
def human(n):
    n = float(n or 0)
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if n < 1024 or unit == 'TB':
            return ('%d %s' % (n, unit)) if unit == 'B' else ('%.1f %s' % (n, unit))
        n /= 1024.0


def num(n):
    return '{:,}'.format(int(n)).replace(',', ' ')


def posix(rel):
    return rel.replace(os.sep, '/').replace('\\', '/')


def read_bytes(path, limit=None):
    """Reads a file read-only (os.O_RDONLY), at most `limit` bytes."""
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_BINARY', 0))
    try:
        chunks = []
        left = limit if limit is not None else -1
        while True:
            want = 1 * MiB if left < 0 else min(1 * MiB, left)
            if want == 0:
                break
            b = os.read(fd, want)
            if not b:
                break
            chunks.append(b)
            if left > 0:
                left -= len(b)
        return b''.join(chunks)
    finally:
        os.close(fd)


def read_text(path, limit=None):
    return read_bytes(path, limit).decode('utf-8', 'replace')


def is_sqlite(path):
    try:
        return read_bytes(path, 16) == b'SQLite format 3\x00'
    except Exception:
        return False


def iso_utc(t=None):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t if t is not None else time.time()))


# ---------------------------------------------------------------------------------------------
# Secrets (section 4.4): never-open names, key names, value shapes
# ---------------------------------------------------------------------------------------------
NEVER_FILES = [
    '.env', '*.env', '.env.*', 'auth.json', 'auth-profiles.json', '*.secrets.json', 'secrets.json', 'oauth.json',
    '.anthropic_oauth.json', '*.key', '*.pem', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*', '*.p12', '*.pfx',
    '*.keystore', '*.jks', 'bws_cache*.json', 'Cookies', 'Cookies-journal', 'cookies.sqlite', 'Login Data', 'keychain*',
    '*.keychain', '*.keychain-db', '.netrc', '.pgpass', '.npmrc', '.pypirc',
]
NEVER_DIRS = ['credentials', 'auth', 'mcp-tokens', 'pairing', 'vault', 'codex-home', 'browser-profile', '.ssh', '.gnupg', 'keychains']
SECRET_KEY = re.compile(r'(api[_-]?key|token|secret|password|passwd|credential|auth|cookie|private[_-]?key|client[_-]?secret|bearer|session[_-]?key|^env$)', re.I)
# Keys that only look secret ("max_tokens", "author", "authority"): their numbers and booleans stay.
HARMLESS_KEY = re.compile(r'^(max|min)_?(new_|output_|input_)?tokens?$|_tokens$|^tokens?_(limit|budget|count|used)$|^author$|^auth_?mode$', re.I)
SECRET_TABLE = re.compile(r'(^|_)(auth|oauth|credential|credentials|secret|secrets|token|tokens|api_?keys?|password|passwords|cookie|cookies|vault|keychain)(_|s|$)', re.I)

# Secret-shaped values. Built from parts so this file itself never holds a secret-looking string.
_SHAPES = [
    r'-----BEGIN [A-Z ]*PRIVATE' + r' KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----',
    r'\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}',
    r'\bxai-[A-Za-z0-9]{20,}',
    r'\bgh[pousr]_[A-Za-z0-9]{30,}',
    r'\bgithub_pat_[A-Za-z0-9_]{30,}',
    r'\bglpat-[A-Za-z0-9_\-]{20,}',
    r'\bxox[abposr]-[A-Za-z0-9\-]{10,}',
    r'\bAKIA[0-9A-Z]{16}\b',
    r'\bAIza[0-9A-Za-z_\-]{35}\b',
    r'\bhf_[A-Za-z0-9]{30,}',
    r'\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}',
    r'\b\d{8,10}:[A-Za-z0-9_\-]{35}\b',
    r'\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=\-]{20,}',
]
SHAPE_RE = re.compile('|'.join('(?:%s)' % s for s in _SHAPES))
LONG_HEX = re.compile(r'^[0-9a-fA-F]{40,}$')
LONG_B64 = re.compile(r'^[A-Za-z0-9+/_\-]{40,}={0,2}$')
PRIVATE_KEY_HEAD = b'-----BEGIN'
REMOVED = '\u00absecret removed\u00bb'


class Counter(object):
    def __init__(self):
        self.text = 0
        self.config = 0


REDACT = Counter()


def scrub_text(s):
    """Replaces secret-shaped strings inside free text (persona, memories, skills, sessions)."""
    if not s:
        return s
    out, n = SHAPE_RE.subn(REMOVED, s)
    REDACT.text += n
    return out


def secret_value(v):
    if not isinstance(v, str):
        return False
    t = v.strip()
    if SHAPE_RE.search(t):
        return True
    if ' ' not in t and (LONG_HEX.match(t) or (LONG_B64.match(t) and re.search(r'\d', t) and re.search(r'[a-z]', t) and re.search(r'[A-Z]', t))):
        return True
    return False


def redact_tree(v, key='', path=''):
    """Replaces every secret value in a parsed config tree (section 4.4)."""
    if isinstance(v, dict):
        # A SecretRef keeps its names only.
        if set(v.keys()) <= {'source', 'provider', 'id'} and 'source' in v:
            return {k: v[k] for k in v if isinstance(v[k], str)}
        out = {}
        for k, x in v.items():
            ks = str(k)
            if ks.lower() == 'env' and isinstance(x, dict):
                out[ks] = {kk: ({'$redacted': 'env', 'len': len(str(vv))} if vv not in (None, '') else vv) for kk, vv in x.items()}
                REDACT.config += sum(1 for vv in x.values() if vv not in (None, ''))
                continue
            out[ks] = redact_tree(x, ks, path + '.' + ks)
        return out
    if isinstance(v, list):
        return [redact_tree(x, key, path) for x in v]
    if isinstance(v, (bool, int, float)) or v is None:
        if SECRET_KEY.search(key or '') and not HARMLESS_KEY.search(key or '') and isinstance(v, int) and not isinstance(v, bool) and abs(v) >= 100000:
            REDACT.config += 1
            return {'$redacted': 'key', 'len': len(str(v))}
        return v
    s = str(v)
    if s == '':
        return s
    if key and SECRET_KEY.search(key) and not HARMLESS_KEY.search(key):
        REDACT.config += 1
        return {'$redacted': 'key', 'len': len(s)}
    if secret_value(s):
        REDACT.config += 1
        return {'$redacted': 'shape', 'len': len(s)}
    return scrub_text(s)


def skeleton(v):
    """Only the key paths of a tree (no values): what's packed when a config can't be read confidently."""
    if isinstance(v, dict):
        return {str(k): skeleton(x) for k, x in v.items()}
    if isinstance(v, list):
        return [skeleton(x) for x in v[:3]]
    return None


def key_skeleton_lines(text):
    """Key names of a YAML/JSON-ish file, line by line, without any value."""
    keys = []
    for line in text.splitlines():
        m = re.match(r'^(\s*)(?:- )?["\']?([A-Za-z0-9_.$\-]+)["\']?\s*:', line)
        if m:
            keys.append(m.group(1) + m.group(2))
    return keys


# ---------------------------------------------------------------------------------------------
# A small JSON5 reader (openclaw.json) and a restricted YAML reader (config.yaml, HOOK.yaml)
# ---------------------------------------------------------------------------------------------
class NotUnderstood(Exception):
    pass


def json5_loads(text):
    i = [0]
    s = text
    n = len(s)

    def ws():
        while i[0] < n:
            c = s[i[0]]
            if c in ' \t\r\n\ufeff\u00a0\u2028\u2029':
                i[0] += 1
            elif s.startswith('//', i[0]):
                j = s.find('\n', i[0])
                i[0] = n if j < 0 else j + 1
            elif s.startswith('/*', i[0]):
                j = s.find('*/', i[0] + 2)
                if j < 0:
                    raise NotUnderstood('unclosed comment')
                i[0] = j + 2
            else:
                break

    def string():
        q = s[i[0]]
        i[0] += 1
        out = []
        while i[0] < n:
            c = s[i[0]]
            if c == q:
                i[0] += 1
                return ''.join(out)
            if c == '\\':
                i[0] += 1
                e = s[i[0]] if i[0] < n else ''
                if e == 'u':
                    out.append(chr(int(s[i[0] + 1:i[0] + 5], 16)))
                    i[0] += 5
                    continue
                if e == 'x':
                    out.append(chr(int(s[i[0] + 1:i[0] + 3], 16)))
                    i[0] += 3
                    continue
                if e in '\r\n':
                    i[0] += 1
                    if e == '\r' and i[0] < n and s[i[0]] == '\n':
                        i[0] += 1
                    continue
                out.append({'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', 'v': '\v', '0': '\0'}.get(e, e))
                i[0] += 1
                continue
            out.append(c)
            i[0] += 1
        raise NotUnderstood('unclosed string')

    def ident():
        m = re.compile(r'[A-Za-z_$][A-Za-z0-9_$]*').match(s, i[0])
        if not m:
            raise NotUnderstood('unexpected %r at %d' % (s[i[0]:i[0] + 10], i[0]))
        i[0] = m.end()
        return m.group(0)

    def number():
        m = re.compile(r'[+-]?(0[xX][0-9a-fA-F]+|Infinity|NaN|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)').match(s, i[0])
        if not m:
            raise NotUnderstood('bad number at %d' % i[0])
        i[0] = m.end()
        t = m.group(0)
        if 'x' in t.lower():
            return int(t, 16)
        if 'Infinity' in t or 'NaN' in t:
            return None
        return float(t) if re.search(r'[.eE]', t) else int(t)

    def value(depth=0):
        if depth > 200:
            raise NotUnderstood('too deep')
        ws()
        if i[0] >= n:
            raise NotUnderstood('unexpected end')
        c = s[i[0]]
        if c == '{':
            i[0] += 1
            obj = {}
            while True:
                ws()
                if i[0] < n and s[i[0]] == '}':
                    i[0] += 1
                    return obj
                k = string() if s[i[0]] in '"\'' else ident()
                ws()
                if i[0] >= n or s[i[0]] != ':':
                    raise NotUnderstood('expected : at %d' % i[0])
                i[0] += 1
                obj[k] = value(depth + 1)
                ws()
                if i[0] < n and s[i[0]] == ',':
                    i[0] += 1
                    continue
                ws()
                if i[0] < n and s[i[0]] == '}':
                    i[0] += 1
                    return obj
                raise NotUnderstood('expected , or } at %d' % i[0])
        if c == '[':
            i[0] += 1
            arr = []
            while True:
                ws()
                if i[0] < n and s[i[0]] == ']':
                    i[0] += 1
                    return arr
                arr.append(value(depth + 1))
                ws()
                if i[0] < n and s[i[0]] == ',':
                    i[0] += 1
                    continue
                ws()
                if i[0] < n and s[i[0]] == ']':
                    i[0] += 1
                    return arr
                raise NotUnderstood('expected , or ] at %d' % i[0])
        if c in '"\'':
            return string()
        if c in '+-.0123456789' or s.startswith('Infinity', i[0]) or s.startswith('NaN', i[0]):
            return number()
        word = ident()
        if word == 'true':
            return True
        if word == 'false':
            return False
        if word == 'null':
            return None
        raise NotUnderstood('unexpected word %r' % word)

    v = value()
    ws()
    if i[0] != n:
        raise NotUnderstood('extra text at %d' % i[0])
    return v


def _yaml_scalar(t):
    t = t.strip()
    if t == '' or t in ('~', 'null', 'Null', 'NULL'):
        return None
    if t[0] in '&*!':
        raise NotUnderstood('anchors, aliases and tags are not read')
    if t[0] == '"':
        try:
            return json.loads(t)
        except ValueError:
            raise NotUnderstood('bad quoted string')
    if t[0] == "'":
        if not t.endswith("'") or len(t) < 2:
            raise NotUnderstood('bad quoted string')
        return t[1:-1].replace("''", "'")
    if t[0] in '[{':
        try:
            return json5_loads(t)
        except NotUnderstood:
            if t[0] == '[' and t.endswith(']'):
                return [_yaml_scalar(x) for x in t[1:-1].split(',') if x.strip()]
            raise
    if t in ('true', 'True', 'TRUE', 'yes', 'Yes', 'on', 'On'):
        return True
    if t in ('false', 'False', 'FALSE', 'no', 'No', 'off', 'Off'):
        return False
    if re.match(r'^[+-]?\d+$', t):
        return int(t)
    if re.match(r'^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$', t):
        return float(t)
    return t


def _strip_comment(line):
    out = []
    q = None
    for k, c in enumerate(line):
        if q:
            if c == q:
                q = None
        elif c in '"\'':
            q = c
        elif c == '#' and (k == 0 or line[k - 1] in ' \t'):
            break
        out.append(c)
    return ''.join(out).rstrip()


def yaml_loads(text):
    """Mappings, lists, scalars and block strings (| and >). Anything else: NotUnderstood."""
    raw = text.replace('\r\n', '\n').replace('\t', '    ').split('\n')
    lines = []
    for idx, l in enumerate(raw):
        if l.strip() in ('---', '...') and not lines:
            continue
        lines.append(l)
    pos = [0]

    def indent_of(l):
        return len(l) - len(l.lstrip(' '))

    def skip_blank():
        while pos[0] < len(lines) and (not _strip_comment(lines[pos[0]]).strip()):
            pos[0] += 1

    def block_string(parent_indent, style):
        out = []
        ind = None
        while pos[0] < len(lines):
            l = lines[pos[0]]
            if l.strip() == '':
                out.append('')
                pos[0] += 1
                continue
            li = indent_of(l)
            if li <= parent_indent:
                break
            if ind is None:
                ind = li
            out.append(l[ind:] if li >= ind else l.strip())
            pos[0] += 1
        while out and out[-1] == '':
            out.pop()
        if style.startswith('>'):
            return ' '.join(x for x in out if x) + '\n'
        return '\n'.join(out) + '\n'

    def node(ind):
        skip_blank()
        if pos[0] >= len(lines):
            return None
        l = _strip_comment(lines[pos[0]])
        if l.lstrip().startswith('- ') or l.strip() == '-':
            return seq(indent_of(l))
        return mapping(indent_of(l))

    def seq(ind):
        out = []
        while True:
            skip_blank()
            if pos[0] >= len(lines):
                return out
            l = _strip_comment(lines[pos[0]])
            if indent_of(l) != ind or not (l.lstrip().startswith('- ') or l.strip() == '-'):
                if indent_of(l) > ind:
                    raise NotUnderstood('odd indentation at line %d' % (pos[0] + 1))
                return out
            rest = l.strip()[1:].strip()
            if rest == '':
                pos[0] += 1
                out.append(node(ind + 1))
            elif re.match(r'^[^"\'\[{][^:]*:(\s|$)', rest) or re.match(r'^"[^"]*"\s*:(\s|$)', rest):
                # "- key: value" starts a mapping inside the list.
                lines[pos[0]] = ' ' * (ind + 2) + rest
                out.append(mapping(ind + 2))
            else:
                pos[0] += 1
                if rest in ('|', '|-', '>', '>-'):
                    out.append(block_string(ind, rest))
                else:
                    out.append(_yaml_scalar(rest))

    def mapping(ind):
        out = {}
        while True:
            skip_blank()
            if pos[0] >= len(lines):
                return out
            l = _strip_comment(lines[pos[0]])
            li = indent_of(l)
            if li < ind:
                return out
            if li > ind:
                raise NotUnderstood('odd indentation at line %d' % (pos[0] + 1))
            m = re.match(r'^\s*("(?:[^"\\]|\\.)*"|\'[^\']*\'|[^:#][^:]*?)\s*:(?:\s+(.*))?$', l)
            if not m:
                if l.lstrip().startswith('- '):
                    return out
                raise NotUnderstood('not a mapping line at %d' % (pos[0] + 1))
            k = m.group(1)
            if k[0] in '"\'':
                k = str(_yaml_scalar(k))
            if k.startswith('<<') or k.startswith('?'):
                raise NotUnderstood('merge keys are not read')
            rest = (m.group(2) or '').strip()
            pos[0] += 1
            if rest == '':
                skip_blank()
                if pos[0] < len(lines):
                    nl = _strip_comment(lines[pos[0]])
                    ni = indent_of(nl)
                    if ni > ind or (ni == ind and nl.lstrip().startswith('- ')):
                        out[k] = node(ni)
                        continue
                out[k] = None
            elif rest in ('|', '|-', '|+', '>', '>-', '>+'):
                out[k] = block_string(ind, rest)
            else:
                out[k] = _yaml_scalar(rest)

    v = node(0)
    skip_blank()
    if pos[0] < len(lines):
        raise NotUnderstood('extra text at line %d' % (pos[0] + 1))
    return v


def frontmatter(text):
    """The YAML frontmatter of a SKILL.md / HOOK.md (None when absent or not understood)."""
    if not text.startswith('---'):
        return None
    end = text.find('\n---', 3)
    if end < 0:
        return None
    try:
        v = yaml_loads(text[3:end])
        return v if isinstance(v, dict) else None
    except (NotUnderstood, ValueError, IndexError):
        return None


# ---------------------------------------------------------------------------------------------
# Sensitive categories, by NAMES only (section 4.6)
# ---------------------------------------------------------------------------------------------
CATEGORY_WORDS = {
    'medical': re.compile(r'^(health|healthkit|medical|med|meds|medication|medications|medicine|symptoms?|diagnos\w*|doctors?|therapy|therapist|mood_?log|moodlog|sleep|vitals?|labs?|prescri\w*|period|cycle|weight|glucose|bp|blood|insulin|clinic|patient|allerg\w*)$', re.I),
    'intimate': re.compile(r'^(intimate|intimacy|nsfw|adult|sexual|sex|kinks?|erotic\w*|lewd|spicy|nudes?|nude)$', re.I),
    'finances': re.compile(r'^(finance|finances|financial|bank|banking|budget|budgets|invoices?|taxes|tax|salary|payroll|brokerage|crypto|wallet)$', re.I),
}
DEFAULT_CATEGORIES_ON = {'finances'}


def name_words(name):
    parts = re.split(r'[^A-Za-z0-9]+', re.sub(r'([a-z])([A-Z])', r'\1_\2', name))
    words = [p for p in parts if p]
    # "mood_log" style compounds count too.
    words += ['_'.join(words[k:k + 2]) for k in range(len(words) - 1)]
    return words


def categories_of(*names):
    found = set()
    for nm in names:
        for wd in name_words(nm or ''):
            for cat, rx in CATEGORY_WORDS.items():
                if rx.match(wd):
                    found.add(cat)
    return found

# ---------------------------------------------------------------------------------------------
# Finding the homes (section 4.2)
# ---------------------------------------------------------------------------------------------
HERMES_MARKERS = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db']
DATED = re.compile(r'^(?P<base>[A-Za-z0-9_\-]+)\.(?P<tag>[^/]+)\.(?P<ext>md|yaml|yml|json|json5)$')
MEDIA_EXT = set('.png .jpg .jpeg .gif .webp .heic .bmp .tif .tiff .svg .ico .mp3 .wav .ogg .opus .m4a .flac .aac .mp4 .mov .webm .mkv .avi .gguf .safetensors .bin .onnx .pt .pth .ckpt .npy .npz .tflite .mlmodel .zip .tar .gz .tgz .7z .rar .xz .zst .dmg .iso .woff .woff2 .ttf .otf .exe .dll .so .dylib'.split())
TEXT_EXT = set('.md .txt .json .json5 .jsonl .yaml .yml .toml .ini .cfg .py .ts .js .mjs .cjs .sh .bash .zsh .ps1 .rb .go .rs .java .kt .swift .lua .sql .csv .tsv .html .css .xml .tmpl .j2 .jinja .env.example'.split())
CODE_ENV = {'hermes-agent', 'node_modules', '.venv', 'venv', 'env', '.git', '__pycache__', 'site-packages', '.mypy_cache', '.pytest_cache', 'dist', 'build', '.next', '.turbo'}
BACKUP_DIRS = {'backups', 'backup', 'state-snapshots', 'snapshots', 'checkpoints', 'archive', 'archives', 'trash', '.trash'}
MEDIA_DIRS = {'media', 'images', 'image_cache', 'audio', 'audio_cache', 'voice', 'voices', 'tts_cache', 'video', 'models', 'downloads', 'uploads', 'attachments', 'cache', '.cache', 'tmp', 'temp'}
LOG_FILE = re.compile(r'(\.log(\.\d+)?|\.log\.gz)$', re.I)
BACKUP_FILE = re.compile(r'(\.bak[^/]*|\.orig|\.migrated|~|\.old|\.prev|\.backup|\.save)$', re.I)
OPENCLAW_PERSONA = {'SOUL.md': 'persona', 'IDENTITY.md': 'identity', 'AGENTS.md': 'rules', 'USER.md': 'profile', 'MEMORY.md': 'memory', 'memory.md': 'memory',
                    'BOOT.md': 'boot', 'BOOTSTRAP.md': 'bootstrap', 'HEARTBEAT.md': 'heartbeat', 'DREAMS.md': 'dreams', 'TOOLS.md': 'tools'}
DAILY = re.compile(r'^memory/(\d{4}-\d{2}-\d{2})(?:[^/]*)\.md$')


def expand(p, base=None):
    p = os.path.expanduser(os.path.expandvars(str(p)))
    if base and not os.path.isabs(p):
        p = os.path.join(base, p)
    return os.path.abspath(p)


def tilde(p):
    home = os.path.expanduser('~')
    return '~' + p[len(home):] if p.startswith(home) else p


def is_hermes_home(p):
    return os.path.isdir(p) and any(os.path.exists(os.path.join(p, m)) for m in HERMES_MARKERS)


def is_openclaw_state(p):
    return os.path.isdir(p) and (os.path.isfile(os.path.join(p, 'openclaw.json')) or os.path.isdir(os.path.join(p, 'agents')) and os.path.isdir(os.path.join(p, 'workspace')))


def load_openclaw_config(state, path=None):
    """openclaw.json (JSON5) with its $include files; returns (tree or None, [include paths], error)."""
    cfg = path or os.environ.get('OPENCLAW_CONFIG_PATH') or os.path.join(state, 'openclaw.json')
    if not os.path.isfile(cfg):
        return None, [], None
    includes = []

    def load(p, depth):
        if depth > 8:
            raise NotUnderstood('$include nested too deep')
        tree = json5_loads(read_text(p, 8 * MiB))

        def walk(v):
            if isinstance(v, dict):
                inc = v.get('$include')
                out = {}
                if inc:
                    for one in (inc if isinstance(inc, list) else [inc]):
                        ip = expand(one, os.path.dirname(p))
                        includes.append(ip)
                        sub = load(ip, depth + 1)
                        if isinstance(sub, dict):
                            out.update(sub)
                for k, x in v.items():
                    if k != '$include':
                        out[k] = walk(x)
                return out
            if isinstance(v, list):
                return [walk(x) for x in v]
            return v
        return walk(tree)
    try:
        return load(cfg, 0), includes, None
    except Exception as e:  # noqa: BLE001 - a config we can't read is reported, never fatal
        return None, includes, str(e)


def openclaw_agents(state, tree):
    ids = []
    agents = (tree or {}).get('agents') if isinstance(tree, dict) else None
    if isinstance(agents, dict):
        ent = agents.get('entries')
        if isinstance(ent, dict):
            ids += [str(k) for k in ent.keys()]
        lst = agents.get('list')
        if isinstance(lst, list):
            ids += [str(x.get('id')) for x in lst if isinstance(x, dict) and x.get('id')]
    adir = os.path.join(state, 'agents')
    if os.path.isdir(adir):
        for d in sorted(os.listdir(adir)):
            if os.path.isdir(os.path.join(adir, d)) and d not in ids:
                ids.append(d)
    return ids or ['main']


def openclaw_agent_entry(tree, agent):
    agents = (tree or {}).get('agents') if isinstance(tree, dict) else None
    if not isinstance(agents, dict):
        return {}, {}
    defaults = agents.get('defaults') if isinstance(agents.get('defaults'), dict) else {}
    ent = agents.get('entries') if isinstance(agents.get('entries'), dict) else {}
    e = ent.get(agent) if isinstance(ent.get(agent), dict) else {}
    for x in agents.get('list') or []:
        if isinstance(x, dict) and str(x.get('id')) == agent:
            e = x
    return e, defaults


def openclaw_workspace(state, tree, agent, many, override=None):
    e, defaults = openclaw_agent_entry(tree, agent)
    cands = []
    if override:
        cands.append(expand(override))
    if e.get('workspace'):
        cands.append(expand(e['workspace'], state))
    if os.environ.get('OPENCLAW_WORKSPACE_DIR'):
        cands.append(expand(os.environ['OPENCLAW_WORKSPACE_DIR']))
    if defaults.get('workspace'):
        base = expand(defaults['workspace'], state)
        cands.append(os.path.join(base, agent) if many else base)
    cands.append(os.path.join(state, 'workspace-' + agent))
    cands.append(os.path.join(state, 'workspace'))
    for c in cands:
        if os.path.isdir(c):
            return c
    return None


def find_candidates(opts):
    """Every agent the script can pack: [{kind, agentId, roots:[(id, role, path)], label}]."""
    out = []
    seen = set()

    def add_hermes(home, profile):
        home = os.path.abspath(home)
        if home in seen or not is_hermes_home(home):
            return
        seen.add(home)
        out.append({'kind': 'hermes', 'agentId': profile, 'roots': [('home', 'hermes-home', home)], 'label': 'Hermes Agent  %s  (profile: %s)' % (tilde(home), profile)})

    def hermes_tree(home):
        add_hermes(home, 'default')
        pdir = os.path.join(home, 'profiles')
        if os.path.isdir(pdir):
            for d in sorted(os.listdir(pdir)):
                add_hermes(os.path.join(pdir, d), d)

    def add_openclaw(state, ws_override=None):
        state = os.path.abspath(state)
        if state in seen or not is_openclaw_state(state):
            return
        seen.add(state)
        tree, _inc, _err = load_openclaw_config(state)
        ids = openclaw_agents(state, tree)
        for aid in ids:
            ws = openclaw_workspace(state, tree, aid, len(ids) > 1, ws_override)
            roots = [('state', 'openclaw-state', state)]
            if ws:
                roots.append(('ws', 'openclaw-workspace', ws))
            out.append({'kind': 'openclaw', 'agentId': aid, 'roots': roots, 'label': 'OpenClaw  %s  (agent: %s%s)' % (tilde(state), aid, ', workspace ' + tilde(ws) if ws else ', no workspace found')})

    given = False
    if opts.get('hermes_home'):
        given = True
        hermes_tree(expand(opts['hermes_home']))
    if opts.get('openclaw_state'):
        given = True
        add_openclaw(expand(opts['openclaw_state']), opts.get('workspace'))
    if not given:
        if os.environ.get('HERMES_HOME'):
            hermes_tree(expand(os.environ['HERMES_HOME']))
        if os.environ.get('OPENCLAW_STATE_DIR'):
            add_openclaw(expand(os.environ['OPENCLAW_STATE_DIR']), opts.get('workspace'))
        if os.environ.get('OPENCLAW_PROFILE'):
            add_openclaw(expand('~/.openclaw-' + os.environ['OPENCLAW_PROFILE']), opts.get('workspace'))
        hermes_tree(expand('~/.hermes'))
        if os.environ.get('LOCALAPPDATA'):
            hermes_tree(os.path.join(os.environ['LOCALAPPDATA'], 'hermes'))
        add_openclaw(expand('~/.openclaw'), opts.get('workspace'))
        home = os.path.expanduser('~')
        try:
            for d in sorted(os.listdir(home)):
                if d.startswith('.openclaw-'):
                    add_openclaw(os.path.join(home, d), opts.get('workspace'))
        except OSError:
            pass
        add_openclaw(expand('~/openclaw'), opts.get('workspace'))
    for sp in opts.get('scan') or []:
        p = expand(sp)
        if os.path.isdir(p) and p not in seen:
            seen.add(p)
            out.append({'kind': 'custom', 'agentId': os.path.basename(p.rstrip('/\\')) or 'custom', 'roots': [('ext', 'scan', p)], 'label': 'Custom folder  %s' % tilde(p)})
    return out


# ---------------------------------------------------------------------------------------------
# The plan: every file found gets packed, or skipped with a reason code (section 4.3)
# ---------------------------------------------------------------------------------------------
REASONS = ['secret', 'log', 'media', 'backup', 'code-env', 'telemetry', 'sensitive-unchosen', 'too-big', 'owner-never', 'unreadable', 'derived', 'other', 'since']


class Plan(object):
    def __init__(self, cand, opts):
        self.cand = cand
        self.opts = opts
        self.items = []        # dicts: path (in bundle), kind, src, bytes, mtime, cats, history
        self.skips = {}        # reason -> {files, bytes, examples[]}
        self.skip_list = []    # {path, reason, bytes, files}
        self.stores = []       # store specs (see the STORES part)
        self.history = {}      # persona file -> [dated copies]
        self.config_trees = []
        self.notes = []
        self.layout = []
        self.display = cand['agentId']
        self.schema_version = None

    def skip(self, path, reason, size=0, files=1, why=None):
        s = self.skips.setdefault(reason, {'files': 0, 'bytes': 0, 'examples': []})
        s['files'] += files
        s['bytes'] += size
        if len(s['examples']) < 6:
            s['examples'].append(path)
        rec = {'path': path, 'reason': reason, 'bytes': size}
        if files != 1:
            rec['files'] = files
        if why:
            rec['why'] = why
        if len(self.skip_list) < 20000 or reason == 'secret':
            self.skip_list.append(rec)

    def add(self, root_id, rel, kind, src, size, mtime, **extra):
        it = {'path': 'files/%s/%s' % (root_id, rel), 'kind': kind, 'src': src, 'bytes': size, 'mtime': iso_utc(mtime), 'rel': rel, 'root': root_id}
        it.update(extra)
        it['cats'] = sorted(categories_of(rel))
        self.items.append(it)
        return it


def tree_size(path):
    files = 0
    size = 0
    for dp, dns, fns in os.walk(path, onerror=lambda e: None):
        for f in fns:
            try:
                st = os.lstat(os.path.join(dp, f))
                files += 1
                size += st.st_size
            except OSError:
                pass
    return files, size


def never_file(name):
    return any(fnmatch.fnmatch(name, pat) or fnmatch.fnmatch(name.lower(), pat.lower()) for pat in NEVER_FILES)


def owner_never(rel, opts):
    return any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(os.path.basename(rel), p) for p in (opts.get('never') or []))


def matches(rel, pats):
    return any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(os.path.basename(rel), p) for p in (pats or []))


def looks_private_key(path):
    try:
        head = read_bytes(path, 200)
    except OSError:
        return False
    return head.lstrip().startswith(PRIVATE_KEY_HEAD) and b'PRIVATE' in head


def ext_of(name):
    n = name.lower()
    return os.path.splitext(n)[1]


def classify_dir(role, rel, name, plan):
    """None to walk into the folder; else (reason, why) to skip it whole."""
    low = name.lower()
    if name in NEVER_DIRS or low in NEVER_DIRS:
        return ('secret', None)
    if low in CODE_ENV:
        return ('code-env', None)
    top = rel.split('/')[0]
    if role == 'hermes-home':
        if rel == 'profiles':
            return ('other', 'another profile: collect it as its own bundle')
        if rel == 'logs' or low == 'logs':
            return ('log', None)
        if rel == 'sessions':
            return ('backup', 'gateway copies of sessions that are in state.db')
        if rel in ('cron/output', 'cron/runs'):
            return ('log', None)
        if rel == 'kanban/workspaces':
            return ('telemetry', 'scratch folders of finished board tasks')
        if low in BACKUP_DIRS:
            return ('backup', None)
        if low in MEDIA_DIRS and top not in ('skills',):
            return ('media', None)
    elif role == 'openclaw-state':
        if low == 'logs' or rel in ('cron/runs',):
            return ('log', None)
        if low in BACKUP_DIRS:
            return ('backup', None)
        if rel.startswith('workspace') and '/' not in rel:
            return ('skip-silent', None)
        if rel.startswith('agents/') and rel.count('/') == 1 and name != plan.cand['agentId']:
            return ('other', 'another agent: collect it as its own bundle')
        if low in MEDIA_DIRS and top not in ('skills', 'extensions', 'plugins'):
            return ('media', None)
        if rel == 'memory' or rel.endswith('/memory') and 'agents/' in rel:
            return ('derived', 'memory search index (Sara builds her own)')
    elif role == 'openclaw-workspace':
        if rel == 'memory/.dreams':
            return ('derived', 'dreaming machine state')
        if low in BACKUP_DIRS:
            return ('backup', None)
        if low in MEDIA_DIRS:
            return ('media', None)
    else:
        if low in BACKUP_DIRS:
            return ('backup', None)
        if low in MEDIA_DIRS or low == 'logs':
            return ('media' if low != 'logs' else 'log', None)
    return None


def classify_file(role, rel, name, size, plan, include_paths):
    """('pack', kind) | ('store', reader) | (reason, why)."""
    e = ext_of(name)
    top = rel.split('/')[0]
    depth = rel.count('/')
    if never_file(name):
        return ('secret', None)
    if name.endswith(('-wal', '-shm', '-journal')):
        return ('skip-silent', None)
    if LOG_FILE.search(name):
        return ('log', None)
    if BACKUP_FILE.search(name):
        return ('backup', None)
    if e in MEDIA_EXT or (e == '.pdf' and size > 5 * MiB):
        return ('media', None)
    sqlite_like = e in ('.db', '.sqlite', '.sqlite3', '.db3') or name == 'state.db'
    m = DATED.match(name)
    if m and m.group('ext') in ('yaml', 'yml', 'json', 'json5') and os.path.exists(os.path.join(plan.root_path, os.path.dirname(rel), '%s.%s' % (m.group('base'), m.group('ext')))):
        return ('backup', 'a dated copy of a config file')
    if role == 'hermes-home':
        if rel == 'SOUL.md':
            return ('pack', 'persona')
        if depth == 0 and e == '.md':
            return ('pack', 'persona-extra')
        if top == 'memories' and e == '.md':
            return ('pack', 'memory')
        if rel == 'config.yaml':
            return ('pack', 'config')
        if top == 'skills':
            return ('pack', 'skill')
        if top == 'hooks':
            return ('pack', 'hook')
        if rel == 'cron/jobs.json':
            return ('pack', 'cron')
        if rel == 'cron/deliveries.db':
            return ('log', 'cron delivery queue')
        if top == 'cron':
            return ('log', None)
        if rel == 'state.db':
            return ('store', 'hermes-state')
        if rel == 'kanban.db' or re.match(r'^kanban/boards/[^/]+/kanban\.db$', rel):
            return ('store', 'hermes-kanban')
        if top == 'plugins':
            if sqlite_like:
                return ('store', 'custom')
            return ('pack', 'plugin')
    elif role == 'openclaw-state':
        if rel == 'openclaw.json' or os.path.abspath(os.path.join(plan.state_root, rel)) in include_paths:
            return ('pack', 'config')
        aid = plan.cand['agentId']
        if re.match(r'^agents/%s/sessions/[^/]+\.jsonl$' % re.escape(aid), rel) or rel == 'agents/%s/sessions/sessions.json' % aid:
            return ('pack', 'session')
        if rel == 'agents/%s/agent/openclaw-agent.sqlite' % aid:
            return ('store', 'openclaw-agent')
        if rel == 'state/openclaw.sqlite':
            return ('store', 'openclaw-state')
        if rel in ('cron/jobs.json', 'cron/jobs-quarantine.json'):
            return ('pack', 'cron')
        if top == 'skills':
            return ('pack', 'skill')
        if top == 'hooks':
            return ('pack', 'hook')
        if top in ('extensions', 'plugins'):
            if sqlite_like:
                return ('store', 'custom')
            return ('pack', 'plugin')
        if top == 'agents' and rel.startswith('agents/%s/agent/workshop-skills/' % aid):
            return ('pack', 'skill')
    elif role == 'openclaw-workspace':
        if depth == 0 and name in OPENCLAW_PERSONA:
            return ('pack', 'ws-' + OPENCLAW_PERSONA[name])
        if depth == 0 and e == '.md':
            return ('pack', 'persona-extra')
        if DAILY.match(rel):
            return ('pack', 'daily')
        if rel.startswith('memory/dreaming/') and e == '.md':
            return ('pack', 'dreams')
        if top == 'skills' or rel.startswith('.agents/skills/'):
            return ('pack', 'skill')
        if top == 'hooks':
            return ('pack', 'hook')
    else:  # --scan: persona-shaped files, SKILL.md folders, SQLite files, SQL dumps
        if re.match(r'^(SOUL|IDENTITY|PERSONA|CHARACTER|USER|MEMORY)\.md$', name, re.I):
            return ('pack', 'persona-extra')
        if '/skills/' in '/' + rel and e in TEXT_EXT:
            return ('pack', 'skill')
        if e in ('.sql', '.dump'):
            return ('other', 'SQL dumps are read in a later update (MI2)')
    if sqlite_like and is_sqlite(os.path.join(plan.root_path, rel)):
        return ('store', 'custom')
    return ('other', None)


TEXT_KINDS = {'persona', 'persona-extra', 'memory', 'skill', 'hook', 'plugin', 'cron', 'session', 'daily', 'dreams', 'history'}


def walk_root(plan, root_id, role, path):
    opts = plan.opts
    plan.root_path = path
    if role == 'openclaw-state':
        plan.state_root = path
    include_paths = set(getattr(plan, 'includes', []))
    ws_paths = set(os.path.abspath(r[2]) for r in plan.cand['roots'] if r[1] == 'openclaw-workspace')
    since = opts.get('since_ts')
    for dp, dns, fns in os.walk(path, onerror=lambda e: plan.skip(posix(os.path.relpath(getattr(e, 'filename', path) or path, path)), 'unreadable', 0, 1, str(e))):
        rel_dir = posix(os.path.relpath(dp, path))
        rel_dir = '' if rel_dir == '.' else rel_dir
        keep = []
        for d in sorted(dns):
            full = os.path.join(dp, d)
            rel = (rel_dir + '/' + d) if rel_dir else d
            if os.path.islink(full):
                plan.skip('%s/%s' % (root_id, rel), 'other', 0, 1, 'a link (links are never followed)')
                continue
            if os.path.abspath(full) in ws_paths and role != 'openclaw-workspace':
                continue
            if owner_never(rel, opts):
                files, size = tree_size(full)
                plan.skip('%s/%s/' % (root_id, rel), 'owner-never', size, files)
                continue
            c = classify_dir(role, rel, d, plan)
            if c and matches(rel, opts.get('include')) and c[0] not in ('secret',):
                c = None
            if c:
                if c[0] == 'skip-silent':
                    continue
                files, size = tree_size(full)
                plan.skip('%s/%s/' % (root_id, rel), c[0], size, files, c[1])
                continue
            keep.append(d)
        dns[:] = keep
        for f in sorted(fns):
            full = os.path.join(dp, f)
            rel = (rel_dir + '/' + f) if rel_dir else f
            try:
                st = os.lstat(full)
            except OSError as e:
                plan.skip('%s/%s' % (root_id, rel), 'unreadable', 0, 1, str(e))
                continue
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                plan.skip('%s/%s' % (root_id, rel), 'other', 0, 1, 'not a plain file (links are never followed)')
                continue
            if owner_never(rel, opts):
                plan.skip('%s/%s' % (root_id, rel), 'owner-never', st.st_size)
                continue
            c = classify_file(role, rel, f, st.st_size, plan, include_paths)
            if c[0] == 'skip-silent':
                continue
            if c[0] not in ('pack', 'store', 'secret') and matches(rel, opts.get('include')):
                c = ('pack', 'included')
            if c[0] in ('pack', 'store') and matches(rel, opts.get('exclude')):
                c = ('owner-never', 'left out with --exclude')
            if c[0] == 'pack':
                kind = c[1]
                if kind != 'config' and looks_private_key(full):
                    plan.skip('%s/%s' % (root_id, rel), 'secret', st.st_size, 1, 'a private key')
                    continue
                m = DATED.match(f)
                if m and os.path.exists(os.path.join(dp, '%s.%s' % (m.group('base'), m.group('ext')))) and m.group('tag') not in ('example',):
                    base = (rel_dir + '/' if rel_dir else '') + '%s.%s' % (m.group('base'), m.group('ext'))
                    if kind in ('persona', 'persona-extra') or kind.startswith('ws-'):
                        plan.history.setdefault((root_id, base), []).append((st.st_mtime, rel, full, st.st_size))
                    else:
                        plan.skip('%s/%s' % (root_id, rel), 'backup', st.st_size, 1, 'a dated copy')
                    continue
                limit = MAX_CODE_FILE if kind in ('hook', 'plugin') else (MAX_TEXT_FILE if kind in ('skill', 'persona', 'persona-extra', 'memory', 'cron') or kind.startswith('ws-') else None)
                if kind in ('hook', 'plugin', 'skill') and ext_of(f) not in TEXT_EXT and ext_of(f) != '' and not f.startswith(('SKILL', 'HOOK', 'README', 'LICENSE')):
                    plan.skip('%s/%s' % (root_id, rel), 'media', st.st_size, 1, 'not a text file')
                    continue
                if limit and st.st_size > limit:
                    plan.skip('%s/%s' % (root_id, rel), 'too-big', st.st_size)
                    continue
                if since and kind in ('session',) and st.st_mtime < since:
                    plan.skip('%s/%s' % (root_id, rel), 'since', st.st_size)
                    continue
                plan.add(root_id, rel, kind, full, st.st_size, st.st_mtime)
            elif c[0] == 'store':
                plan.stores.append({'root': root_id, 'rel': rel, 'src': full, 'reader': c[1], 'bytes': st.st_size, 'mtime': iso_utc(st.st_mtime)})
            else:
                plan.skip('%s/%s' % (root_id, rel), c[0], st.st_size, 1, c[1])
    # Dated copies of a persona file: the newest three are its history, the rest are backups.
    for (root_id2, base), copies in plan.history.items():
        if root_id2 != root_id:
            continue
        copies.sort(reverse=True)
        target = next((it for it in plan.items if it['root'] == root_id and it['rel'] == base), None)
        for k, (mt, rel, full, size) in enumerate(copies):
            if k < DATED_HISTORY_KEEP and target is not None:
                h = plan.add(root_id, rel, 'history', full, size, mt, of=target['path'])
                target.setdefault('history', []).append(h['path'])
            else:
                plan.skip('%s/%s' % (root_id, rel), 'backup', size, 1, 'an older dated copy')

# ---------------------------------------------------------------------------------------------
# SQLite stores: read-only, one snapshot, streamed (section 4.5)
# ---------------------------------------------------------------------------------------------
TELEMETRY_WORD = re.compile(r'^(log|logs|event|events|trace|traces|span|spans|metric|metrics|telemetry|audit|heartbeat|heartbeats|tick|ticks|run|runs|step|steps|attempt|attempts|debug|perf|usage|cost|costs|latency|queue|cache|checkpoint|checkpoints|snapshot|snapshots|migration|migrations|lock|locks|lease|leases|outbox|autonomy|loop|loops|job_runs?|inbox_raw|decision_log|session_state)$', re.I)
DERIVED_TABLE = re.compile(r'(^sqlite_|_fts$|_fts_(data|idx|docsize|config|content)$|_fts\d*$|^fts_|_content$|_segments$|_segdir$|_stat$|^vec_|_vec$|_embeddings?$|^embeddings?$)', re.I)
EMBED_COL = re.compile(r'(embedding|vector|^emb$|_emb$)', re.I)
# The tables a known reader needs (always data), and the ones it leaves (derived/secret).
READER_TABLES = {
    'hermes-state': {'sessions', 'messages', 'schema_version'},
    'hermes-kanban': {'tasks', 'task_links', 'comments', 'task_comments', 'boards', 'attachments', 'task_attachments'},
}
AUTOMATION_TABLE = re.compile(r'(automation|cron|job|schedule)', re.I)


def sqlite_uri(path, stopped):
    try:
        from urllib.request import pathname2url
    except ImportError:  # pragma: no cover
        from urllib import pathname2url
    u = pathname2url(os.path.abspath(path))
    if not u.startswith('/'):
        u = '/' + u
    # A WAL database that nobody has open has no -wal/-shm files; plain mode=ro would create them
    # beside it. Then it is opened immutable (nothing is written at all). With the sidecars there
    # (the agent is running), mode=ro reads through the agent's own files and creates none.
    idle = not os.path.exists(path + '-wal') and not os.path.exists(path + '-shm')
    return 'file:%s?mode=ro%s' % (u, '&immutable=1' if stopped or idle else '')


def open_ro(path, stopped):
    last = None
    for k in range(3):
        try:
            conn = sqlite3.connect(sqlite_uri(path, stopped), uri=True, timeout=5, isolation_level=None, check_same_thread=False)
            conn.text_factory = lambda b: b.decode('utf-8', 'replace')
            conn.execute('BEGIN')
            conn.execute('SELECT count(*) FROM sqlite_master').fetchone()
            return conn
        except sqlite3.Error as e:
            last = e
            # An older system SQLite can't read newer schemas (STRICT tables need 3.37): try Node's.
            if 'malformed database schema' in str(e) or 'syntax error' in str(e):
                nc = NodeSqlite.open(path, stopped)
                if nc:
                    return nc
                break
            time.sleep(0.5 * (2 ** k))
    raise last


# Node's built-in SQLite (node:sqlite, Node 22.5+), used only when the system SQLite is too old for the
# database (OpenClaw always runs on Node, so it is there). One read-only process per query, rows
# streamed back as JSON lines. It is opened immutable when nobody has the database open, so it never
# writes anything either.
NODE_SQL = r'''
const [path, immutable, sql] = process.argv.slice(1);
const { DatabaseSync } = require('node:sqlite');
let db;
const tries = immutable === '1' ? [() => new DatabaseSync(new URL('file://' + (path.startsWith('/') ? '' : '/') + path.replace(/\\/g, '/').split('/').map((x) => encodeURIComponent(x).replace(/%3A/g, ':')).join('/') + '?immutable=1'), { readOnly: true })] : [() => new DatabaseSync(path, { readOnly: true })];
for (const t of tries) { try { db = t(); break; } catch (e) { db = undefined; } }
if (!db) { process.stderr.write('cannot open'); process.exit(3); }
const st = db.prepare(sql);
if (st.setReadBigInts) st.setReadBigInts(true);
const enc = (v) => typeof v === 'bigint' ? (v <= 9007199254740991n && v >= -9007199254740991n ? Number(v) : String(v)) : v instanceof Uint8Array ? { $b: Buffer.from(v).toString('base64') } : v;
const out = [];
const flush = () => { if (out.length) { process.stdout.write(out.join('\n') + '\n'); out.length = 0; } };
for (const row of st.iterate()) { out.push(JSON.stringify(Object.values(row).map(enc))); if (out.length >= 500) flush(); }
flush();
'''


class NodeCursor(object):
    def __init__(self, proc):
        self.proc = proc

    def _row(self, line):
        return tuple(base64.b64decode(v['$b']) if isinstance(v, dict) and '$b' in v else v for v in json.loads(line))

    def fetchone(self):
        line = self.proc.stdout.readline()
        if not line:
            self._end()
            return None
        return self._row(line)

    def fetchmany(self, n):
        out = []
        while len(out) < n:
            r = self.fetchone()
            if r is None:
                break
            out.append(r)
        return out

    def fetchall(self):
        return self.fetchmany(1 << 62)

    def __iter__(self):
        while True:
            r = self.fetchone()
            if r is None:
                return
            yield r

    def _end(self):
        if self.proc.poll() is None:
            self.proc.wait()
        if self.proc.returncode:
            raise sqlite3.OperationalError('node:sqlite: %s' % self.proc.stderr.read().decode('utf-8', 'replace')[-200:])


class EmptyCursor(object):
    def fetchone(self):
        return None

    def fetchmany(self, n):
        return []

    def fetchall(self):
        return []


class NodeSqlite(object):
    """The few calls the collector makes on a connection, answered by node:sqlite."""

    def __init__(self, node, path, immutable):
        self.node, self.path, self.immutable = node, path, immutable

    @classmethod
    def open(cls, path, stopped):
        import shutil
        node = shutil.which('node') if hasattr(shutil, 'which') else None
        if not node:
            return None
        idle = not os.path.exists(path + '-wal') and not os.path.exists(path + '-shm')
        c = cls(node, os.path.abspath(path), stopped or idle)
        try:
            c.execute('SELECT count(*) FROM sqlite_master').fetchone()
        except (sqlite3.Error, OSError, ValueError):
            return None
        return c

    def execute(self, sql, params=()):
        if sql.strip().upper() in ('BEGIN', 'ROLLBACK', 'COMMIT'):
            return EmptyCursor()
        if params:
            raise sqlite3.OperationalError('node:sqlite fallback takes no parameters')
        env = dict(os.environ)
        env['NODE_NO_WARNINGS'] = '1'
        p = subprocess.Popen([self.node, '-e', NODE_SQL, self.path, '1' if self.immutable else '0', sql], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        return NodeCursor(p)

    def close(self):
        pass


def qident(name):
    return '"%s"' % str(name).replace('"', '""')


def store_id(spec, taken):
    base = re.sub(r'[^a-z0-9]+', '-', ('%s-%s' % (spec['root'], os.path.splitext(spec['rel'])[0])).lower()).strip('-')[:60] or 'store'
    sid = base
    k = 2
    while sid in taken:
        sid = '%s-%d' % (base, k)
        k += 1
    taken.add(sid)
    return sid


def table_words(name):
    return name_words(name)


def telemetry_by_name(name):
    words = table_words(name)
    return any(TELEMETRY_WORD.match(x) for x in words) or bool(re.match(r'^(autonomy|loop|token|tokens)_', name, re.I))


def analyze_sqlite(spec, plan):
    """Tables, columns, counts and a verdict per table (no rows are written here)."""
    stopped = plan.opts.get('stopped')
    info = {'tables': [], 'error': None, 'sql': ''}
    try:
        conn = open_ro(spec['src'], stopped)
    except sqlite3.Error as e:
        info['error'] = str(e)
        return info
    try:
        rows = conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type DESC, name").fetchall()
        info['sql'] = '\n'.join((r[3] or '') + ';' for r in rows if r[3])
        virtual = set(r[1] for r in rows if r[0] == 'table' and (r[3] or '').upper().startswith('CREATE VIRTUAL'))
        indexes = {}
        for r in rows:
            if r[0] == 'index':
                indexes.setdefault(r[2], []).append(r[1])
        reader = spec['reader']
        for r in rows:
            if r[0] != 'table':
                continue
            name = r[1]
            t = {'name': name, 'columns': [], 'indexes': indexes.get(name, []), 'foreignKeys': [], 'rows': 0, 'verdict': 'data', 'why': ''}
            try:
                for c in conn.execute('PRAGMA table_info(%s)' % qident(name)).fetchall():
                    t['columns'].append({'name': c[1], 'type': c[2] or '', 'pk': bool(c[5]), 'nullable': not c[3]})
                for fk in conn.execute('PRAGMA foreign_key_list(%s)' % qident(name)).fetchall():
                    t['foreignKeys'].append({'from': fk[3], 'table': fk[2], 'to': fk[4]})
            except sqlite3.Error:
                pass
            t['withoutRowid'] = 'WITHOUT ROWID' in (r[3] or '').upper()
            known = READER_TABLES.get(reader, set())
            cats = categories_of(name, *[c['name'] for c in t['columns']])
            if name.startswith('sqlite_') or DERIVED_TABLE.search(name) or name in virtual:
                t['verdict'], t['why'] = 'derived', 'search index or internal table (Sara builds her own)'
            elif name in known:
                t['verdict'] = 'data'
            elif SECRET_TABLE.search(name):
                t['verdict'], t['why'] = 'secret', 'looks like sign-ins or keys: never collected'
            elif reader == 'openclaw-state' and not AUTOMATION_TABLE.search(name):
                t['verdict'], t['why'] = 'other', 'shared state (only the automations are read)'
            elif reader == 'openclaw-agent' and re.search(r'(^|_)(chunks?|memory_index|vectors?)$', name, re.I):
                t['verdict'], t['why'] = 'derived', 'memory search index (Sara builds her own)'
            elif reader == 'hermes-state' and name not in known:
                t['verdict'], t['why'] = 'other', 'session store internals'
            try:
                t['rows'] = int(conn.execute('SELECT count(*) FROM %s' % qident(name)).fetchone()[0]) if t['verdict'] not in ('derived', 'secret') else 0
            except sqlite3.Error as e:
                t['verdict'], t['why'] = 'unreadable', str(e)
            if t['verdict'] == 'data' and name not in known and telemetry_by_name(name):
                # Name says log/telemetry; volume or the lack of human text confirms it (2 of the section 8.2 signals).
                texty = any('CHAR' in c['type'].upper() or 'TEXT' in c['type'].upper() or c['type'] == '' for c in t['columns'])
                if t['rows'] > 50000 or not texty or len(t['columns']) and sum(1 for c in t['columns'] if re.search(r'INT|REAL|NUM|BOOL|DATE|TIME', c['type'].upper())) >= 0.7 * len(t['columns']):
                    t['verdict'], t['why'] = 'telemetry', 'a log or telemetry table'
            if cats and t['verdict'] == 'data':
                t['cats'] = sorted(cats)
            if t['verdict'] == 'data' and t['rows']:
                # Five rows give the size estimate (kept in memory only; never printed).
                try:
                    smp = list(iter_table(conn, name, t['columns'], t['withoutRowid'], SAMPLE_ROWS))
                    t['avgRowBytes'] = int(sum(len(json.dumps(x, ensure_ascii=False)) for x in smp) / max(1, len(smp))) + 12
                    if name == 'schema_version' and smp:
                        vals = [v for x in smp for v in x.values() if isinstance(v, int)]
                        if vals:
                            plan.schema_version = max(vals)
                except sqlite3.Error:
                    t['avgRowBytes'] = 200
            info['tables'].append(t)
    finally:
        try:
            conn.execute('ROLLBACK')
        except sqlite3.Error:
            pass
        conn.close()
    return info


def cell(col, v):
    if v is None or isinstance(v, (int,)):
        return v
    if isinstance(v, float):
        return None if v != v or v in (float('inf'), float('-inf')) else v
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        if EMBED_COL.search(col or '') and len(b) % 4 == 0:
            return {'$skipped': 'embedding', 'bytes': len(b)}
        return {'$blob': hashlib.sha256(b).hexdigest(), 'bytes': len(b)}
    s = str(v)
    if len(s) > MAX_CELL_TEXT:
        return {'$blob': hashlib.sha256(s.encode('utf-8', 'replace')).hexdigest(), 'bytes': len(s), 'text': True}
    if s and SECRET_KEY.search(col or '') and not HARMLESS_KEY.search(col or '') and not re.match(r'^(.*_)?(id|ids|count|at|on|name|type|kind|by)$', col or '', re.I):
        REDACT.text += 1
        return {'$redacted': 'key', 'len': len(s)}
    return scrub_text(s)


def iter_table(conn, table, cols, without_rowid, limit=None):
    names = [c['name'] for c in cols]
    order = 'rowid'
    if without_rowid:
        pk = [c['name'] for c in cols if c['pk']]
        order = ', '.join(qident(x) for x in pk) if pk else '1'
    sql = 'SELECT %s FROM %s ORDER BY %s%s' % (', '.join(qident(x) for x in names) or '*', qident(table), order, ' LIMIT %d' % limit if limit else '')
    try:
        cur = conn.execute(sql)
    except sqlite3.Error:
        cur = conn.execute('SELECT %s FROM %s%s' % (', '.join(qident(x) for x in names) or '*', qident(table), ' LIMIT %d' % limit if limit else ''))
    while True:
        batch = cur.fetchmany(FETCH)
        if not batch:
            return
        for row in batch:
            yield {names[k]: cell(names[k], row[k]) for k in range(len(names))}


# ---------------------------------------------------------------------------------------------
# Postgres, only when the owner points at one (section 4.7): system psql / pg_dump, read-only
# ---------------------------------------------------------------------------------------------
def pg_safe(conn_str):
    s = re.sub(r'(://[^:/@]+):[^@]*@', r'\1@', conn_str)
    s = re.sub(r'(password\s*=\s*)\S+', r'\1***', s, flags=re.I)
    return s + ' (password not stored)'


def pg_env(conn_str):
    env = dict(os.environ)
    env['PGOPTIONS'] = '-c default_transaction_read_only=on -c statement_timeout=0'
    if 'PGPASSWORD' not in env and not re.search(r':[^@/]+@|password\s*=', conn_str, re.I) and sys.stdin.isatty():
        pw = getpass.getpass('Postgres password for %s (Enter for none): ' % pg_safe(conn_str).split(' (')[0])
        if pw:
            env['PGPASSWORD'] = pw
    return env


def pg_tool(name):
    for d in os.environ.get('PATH', '').split(os.pathsep):
        for cand in (name, name + '.exe'):
            p = os.path.join(d, cand)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return p
    return None


def pg_catalog(conn_str, env):
    psql = pg_tool('psql')
    if not psql:
        raise RuntimeError('psql was not found on PATH (the collector never downloads it)')
    q = ("SELECT json_agg(t) FROM (SELECT c.table_schema AS schema, c.table_name AS name, "
         "json_agg(json_build_object('name', c.column_name, 'type', c.data_type, 'nullable', c.is_nullable = 'YES') ORDER BY c.ordinal_position) AS columns, "
         "(SELECT GREATEST(cl.reltuples, 0)::bigint FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = c.table_schema AND cl.relname = c.table_name) AS rows, "
         "(SELECT tt.table_type FROM information_schema.tables tt WHERE tt.table_schema = c.table_schema AND tt.table_name = c.table_name) AS kind "
         "FROM information_schema.columns c WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') GROUP BY c.table_schema, c.table_name) t")
    p = subprocess.Popen([psql, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', conn_str, '-c', q], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    out, err = p.communicate()
    if p.returncode != 0:
        raise RuntimeError(err.decode('utf-8', 'replace').strip()[:400])
    tables = json.loads(out.decode('utf-8') or 'null') or []
    for t in tables:
        t['verdict'] = 'data'
        nm = t['name']
        if (t.get('kind') or '').upper() == 'VIEW':
            t['verdict'], t['why'] = 'other', 'a view (its tables are read instead)'
        elif SECRET_TABLE.search(nm):
            t['verdict'], t['why'] = 'secret', 'looks like sign-ins or keys: never collected'
        elif telemetry_by_name(nm) and (t.get('rows') or 0) > 50000:
            t['verdict'], t['why'] = 'telemetry', 'a log or telemetry table'
        cats = categories_of(nm, *[c['name'] for c in t.get('columns') or []])
        if cats and t['verdict'] == 'data':
            t['cats'] = sorted(cats)
        for c in t.get('columns') or []:
            c['pk'] = False
    return tables


def pg_schema_sql(conn_str, env):
    dump = pg_tool('pg_dump')
    if not dump:
        return '-- pg_dump was not found on PATH\n'
    p = subprocess.Popen([dump, '--schema-only', '--no-owner', '--no-privileges', '-d', conn_str], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    out, err = p.communicate()
    return out.decode('utf-8', 'replace') if p.returncode == 0 else '-- pg_dump failed: %s\n' % err.decode('utf-8', 'replace')[:300]


def pg_rows(conn_str, env, tables):
    """Yields (table, row dict) for every chosen table, all from ONE read-only snapshot."""
    import csv
    psql = pg_tool('psql')
    nonce = hashlib.sha256(os.urandom(16)).hexdigest()[:16]
    script = ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;']
    for t in tables:
        full = '%s.%s' % (qident(t['schema']), qident(t['name']))
        script.append("\\echo ==SARA-%s== %s" % (nonce, json.dumps([t['schema'], t['name']])))
        script.append('COPY (SELECT * FROM %s) TO STDOUT WITH (FORMAT csv, HEADER);' % full)
    script.append("\\echo ==SARA-%s== []" % nonce)
    script.append('ROLLBACK;')
    p = subprocess.Popen([psql, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', conn_str], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    p.stdin.write(('\n'.join(script) + '\n').encode('utf-8'))
    p.stdin.close()
    marker = ('==SARA-%s== ' % nonce).encode('ascii')
    stream = io.TextIOWrapper(p.stdout, encoding='utf-8', errors='replace', newline='')
    current = [None]
    pending = [None]

    def lines():
        for line in stream:
            if line.encode('utf-8').startswith(marker):
                pending[0] = json.loads(line[len(marker):].strip() or '[]')
                return
            yield line
    while True:
        if pending[0] is None:
            for line in stream:
                if line.encode('utf-8').startswith(marker):
                    pending[0] = json.loads(line[len(marker):].strip() or '[]')
                    break
        nxt = pending[0]
        pending[0] = None
        if not nxt:
            break
        current[0] = nxt
        reader = csv.reader(lines())
        header = None
        for rec in reader:
            if header is None:
                header = rec
                continue
            yield '%s.%s' % (nxt[0], nxt[1]), {header[k]: cell(header[k], rec[k] if rec[k] != '' else None) for k in range(min(len(header), len(rec)))}
        if pending[0] is None:
            break
    p.wait()

# ---------------------------------------------------------------------------------------------
# Building the plan and showing it (section 4.8)
# ---------------------------------------------------------------------------------------------
def count_entries_hermes(text):
    parts = [p.strip() for p in text.split('\u00a7')]
    return len([p for p in parts if p and not re.match(r'^(#|\[|memory store|user profile)', p, re.I) or (p and len(parts) > 1)])


def count_cron(text):
    try:
        v = json.loads(text)
    except ValueError:
        try:
            v = json5_loads(text)
        except NotUnderstood:
            return 0
    if isinstance(v, dict):
        v = v.get('jobs') or v.get('items') or []
    return len(v) if isinstance(v, list) else 0


def display_name(plan):
    for it in plan.items:
        if it['kind'] == 'ws-identity':
            m = re.search(r'(?im)^\s*[-*]?\s*\**name\**\s*[:\uff1a]\s*\**([^\n*]{1,40})', read_text(it['src'], 64 * 1024))
            if m:
                return m.group(1).strip()
    for it in plan.items:
        if it['kind'] in ('persona', 'ws-persona'):
            text = read_text(it['src'], 64 * 1024)
            m = re.search(r'(?im)^\s*[-*]?\s*\**name\**\s*[:\uff1a]\s*\**([^\n*]{1,40})', text) or re.search(r'(?m)^#\s+(?:I am |I\'m )?([A-Z][\w\- ]{0,30})\s*$', text)
            if m and not re.match(r'(?i)^(soul|identity|persona|who i am|about me)$', m.group(1).strip()):
                return m.group(1).strip()
    return plan.cand['agentId']


def build_plan(cand, opts):
    plan = Plan(cand, opts)
    if cand['kind'] == 'openclaw':
        state = next(r[2] for r in cand['roots'] if r[0] == 'state')
        tree, includes, err = load_openclaw_config(state)
        plan.includes = [os.path.abspath(p) for p in includes]
        if err:
            plan.notes.append('openclaw.json could not be read confidently (%s): only its key names are packed' % err)
    for root_id, role, path in cand['roots']:
        if not os.access(path, os.R_OK | os.X_OK):
            plan.skip(root_id + '/', 'unreadable', 0, 1, 'no permission')
            try:
                import pwd
                owner = pwd.getpwuid(os.stat(path).st_uid).pw_name
                plan.notes.append('The agent runs as another user (%s). Run: sudo -u %s python3 %s %s' % (owner, owner, os.path.basename(sys.argv[0]), ' '.join(sys.argv[1:])))
            except Exception:
                pass
            continue
        walk_root(plan, root_id, role, path)
    # Stores: analysed now (tables, counts, verdicts); rows are only read when the bundle is written.
    taken = set()
    for spec in plan.stores:
        spec['id'] = store_id(spec, taken)
        spec['info'] = analyze_sqlite(spec, plan)
        if spec['info']['error']:
            plan.skip('%s/%s' % (spec['root'], spec['rel']), 'unreadable', spec['bytes'], 1, spec['info']['error'])
    plan.stores = [s for s in plan.stores if not s['info']['error']]
    for pg in opts.get('postgres') or []:
        spec = {'root': 'pg', 'rel': 'app', 'reader': 'custom', 'bytes': 0, 'postgres': pg, 'id': store_id({'root': 'pg', 'rel': 'app'}, taken)}
        try:
            spec['env'] = pg_env(pg)
            spec['info'] = {'tables': pg_catalog(pg, spec['env']), 'error': None, 'sql': ''}
            plan.stores.append(spec)
        except Exception as e:  # noqa: BLE001
            plan.skip('postgres:' + pg_safe(pg), 'unreadable', 0, 1, str(e))
    # Config files: parsed and redacted now, so the plan can say how many values were removed.
    for it in plan.items:
        if it['kind'] != 'config':
            continue
        before = REDACT.config
        text = read_text(it['src'], 8 * MiB)
        try:
            tree = yaml_loads(text) if it['rel'].endswith(('.yaml', '.yml')) else json5_loads(text)
            it['tree'] = {'$format': 'yaml' if it['rel'].endswith(('.yaml', '.yml')) else 'json5', 'tree': redact_tree(tree)}
        except (NotUnderstood, ValueError, IndexError, RecursionError) as e:
            it['tree'] = {'$format': 'skeleton', 'why': str(e)[:200], 'keys': key_skeleton_lines(text)}
        it['redacted'] = REDACT.config - before
    plan.display = display_name(plan)
    plan.layout = sorted(set(
        [s['rel'] for s in plan.stores if s['reader'] != 'custom'] +
        [it['rel'] for it in plan.items if it['kind'] == 'cron'] +
        (['sessions-jsonl'] if any(it['kind'] == 'session' and it['rel'].endswith('.jsonl') for it in plan.items) else []) +
        (['memory-daily'] if any(it['kind'] == 'daily' for it in plan.items) else [])))
    return plan


def category_counts(plan):
    out = {}
    for it in plan.items:
        for c in it.get('cats') or []:
            o = out.setdefault(c, {'items': 0, 'bytes': 0, 'files': 0, 'tables': 0, 'stores': set()})
            o['items'] += 1
            o['files'] += 1
            o['bytes'] += it['bytes']
    for s in plan.stores:
        for t in s['info']['tables']:
            for c in t.get('cats') or []:
                o = out.setdefault(c, {'items': 0, 'bytes': 0, 'files': 0, 'tables': 0, 'stores': set()})
                o['items'] += 1
                o['tables'] += 1
                o['stores'].add(s['id'])
                o['bytes'] += t['rows'] * t.get('avgRowBytes', 200)
    return out


def apply_categories(plan, chosen):
    """Unchosen sensitive items are not packed at all (reason sensitive-unchosen; counts only)."""
    keep = []
    for it in plan.items:
        off = [c for c in it.get('cats') or [] if c not in chosen]
        if off and it['kind'] not in ('config',):
            plan.skip('%s/%s' % (it['root'], it['rel']), 'sensitive-unchosen', it['bytes'], 1, ', '.join(off))
        else:
            keep.append(it)
    plan.items = keep
    for s in plan.stores:
        for t in s['info']['tables']:
            off = [c for c in t.get('cats') or [] if c not in chosen]
            if off:
                t['verdict'], t['why'] = 'sensitive-unchosen', ', '.join(off)
                plan.skip('%s/%s:%s' % (s['root'], s['rel'], t['name']), 'sensitive-unchosen', t['rows'] * t.get('avgRowBytes', 200), 1, ', '.join(off))
    plan.chosen = sorted(chosen)


def sections(plan):
    """The plan screen's rows: (word key, text, action)."""
    rows = []
    items = plan.items
    persona = [it for it in items if it['kind'] in ('persona', 'ws-persona', 'ws-identity')]
    extra = [it for it in items if it['kind'] == 'persona-extra']
    hist = [it for it in items if it['kind'] == 'history']
    if persona or extra:
        txt = ' + '.join('%s (%s)' % (os.path.basename(it['rel']), human(it['bytes'])) for it in persona[:3])
        if extra:
            txt += (' + ' if txt else '') + '%d other persona files' % len(extra)
        if hist:
            txt += ' + %d older versions (history)' % len(hist)
        rows.append(('personality', txt, 'pack'))
    mem = [it for it in items if it['kind'] in ('memory', 'ws-memory', 'ws-profile')]
    daily = [it for it in items if it['kind'] == 'daily']
    if mem or daily:
        parts = []
        for it in mem:
            text = read_text(it['src'], MAX_TEXT_FILE)
            n = count_entries_hermes(text) if it['kind'] == 'memory' else (len(re.findall(r'<!--\s*observed:', text)) or len(re.findall(r'(?m)^\s*[-*] ', text)))
            parts.append('%s %d entries' % (os.path.basename(it['rel']), n))
        if daily:
            parts.append('%d daily files' % len(daily))
        rows.append(('memories', ', '.join(parts), 'pack'))
    sess_text = []
    for s in plan.stores:
        if s['reader'] == 'hermes-state':
            t = {x['name']: x for x in s['info']['tables']}
            sess_text.append('state.db: %s sessions, %s messages (%s)' % (num(t.get('sessions', {}).get('rows', 0)), num(t.get('messages', {}).get('rows', 0)), human(s['bytes'])))
        if s['reader'] == 'openclaw-agent':
            data = [x for x in s['info']['tables'] if x['verdict'] == 'data']
            sess_text.append('openclaw-agent.sqlite: %d tables, %s rows' % (len(data), num(sum(x['rows'] for x in data))))
    jl = [it for it in items if it['kind'] == 'session' and it['rel'].endswith('.jsonl')]
    if jl:
        sess_text.append('%d session files (%s)' % (len(jl), human(sum(it['bytes'] for it in jl))))
    if sess_text:
        rows.append(('sessions', '; '.join(sess_text), 'pack'))
    sk = [it for it in items if it['kind'] == 'skill']
    if sk:
        n = len([it for it in sk if os.path.basename(it['rel']) == 'SKILL.md'])
        rows.append(('skills', '%d folders (%s)' % (n, human(sum(it['bytes'] for it in sk))), 'pack'))
    cron = [it for it in items if it['kind'] == 'cron']
    jobs_n = sum(count_cron(read_text(it['src'], MAX_TEXT_FILE)) for it in cron)
    auto = [x for s in plan.stores if s['reader'] == 'openclaw-state' for x in s['info']['tables'] if x['verdict'] == 'data']
    if cron or auto:
        txt = ', '.join('%s: %d jobs' % (it['rel'], count_cron(read_text(it['src'], MAX_TEXT_FILE))) for it in cron)
        if auto:
            txt += (', ' if txt else '') + 'state/openclaw.sqlite: %d automation rows' % sum(x['rows'] for x in auto)
        rows.append(('schedules', txt, 'pack'))
    kb = [s for s in plan.stores if s['reader'] == 'hermes-kanban']
    if kb:
        tasks = sum(x['rows'] for s in kb for x in s['info']['tables'] if x['name'] == 'tasks')
        rows.append(('board', '%d board(s): %s tasks' % (len(kb), num(tasks)), 'pack'))
    hooks = [it for it in items if it['kind'] == 'hook']
    plugs = [it for it in items if it['kind'] == 'plugin']
    if hooks or plugs:
        nh = len(set(it['rel'].split('/')[1] for it in hooks if '/' in it['rel']))
        np_ = len(set('/'.join(it['rel'].split('/')[:2]) for it in plugs if '/' in it['rel']))
        rows.append(('code', '%d hooks, %d plugins (source, %s) - read, never run' % (nh, np_, human(sum(it['bytes'] for it in hooks + plugs))), 'pack'))
    custom = [s for s in plan.stores if s['reader'] == 'custom']
    if custom:
        tabs = [t for s in custom for t in s['info']['tables']]
        data = [t for t in tabs if t['verdict'] == 'data']
        tele = [t for t in tabs if t['verdict'] == 'telemetry']
        rows.append(('stores', '%d stores, %d tables: %d data, %d telemetry, %d other (%s)' % (len(custom), len(tabs), len(data), len(tele), len(tabs) - len(data) - len(tele), human(sum(s['bytes'] for s in custom))), 'schema + data tables'))
    cfg = [it for it in items if it['kind'] == 'config']
    if cfg:
        rows.append(('config', ', '.join('%s (secrets removed: %d values)' % (os.path.basename(it['rel']), it.get('redacted', 0)) for it in cfg), 'pack'))
    return rows


def estimate_bytes(plan):
    total = sum(it['bytes'] for it in plan.items)
    for s in plan.stores:
        for t in s['info']['tables']:
            if t['verdict'] in ('data',):
                total += t['rows'] * t.get('avgRowBytes', 200)
            total += 8 * 1024
    return int(total * 0.45) + 64 * 1024


def print_plan(plan, out=sys.stdout):
    p = lambda s='': out.write(s + '\n')
    p(w('title', v=VERSION))
    p()
    for root_id, role, path in plan.cand['roots']:
        p('%s: %s  %s  (%s)' % (w('found'), {'hermes-home': 'Hermes Agent home', 'openclaw-state': 'OpenClaw state', 'openclaw-workspace': 'OpenClaw workspace', 'scan': 'Folder'}[role], tilde(path), plan.cand['agentId']))
    for key, txt, act in sections(plan):
        p('  %-15s %-60s %s' % (w(key), txt, w('pack') if act == 'pack' else act))
    p(w('skipped'))
    sk = plan.skips
    if 'secret' in sk:
        names = ', '.join(sorted(set(os.path.basename(x.rstrip('/')) + ('/' if x.endswith('/') else '') for x in sk['secret']['examples'])))
        p('  %-15s %-60s %s' % (w('secrets'), '%s (%s)' % (names, w('never_opened')), '-'))
    for key, reason in (('logs', 'log'), ('media', 'media'), ('backups', 'backup'), ('codeenv', 'code-env'), ('telemetry', 'telemetry'), ('other', 'other')):
        if reason in sk:
            p('  %-15s %-60s %s' % (w(key), '%s files, %s' % (num(sk[reason]['files']), human(sk[reason]['bytes'])), w('skip')))
    tele = [t for s in plan.stores for t in s['info']['tables'] if t['verdict'] == 'telemetry']
    if tele:
        p('  %-15s %-60s %s' % (w('telemetry'), '%d tables in stores (%s, ...)' % (len(tele), ', '.join(t['name'] for t in tele[:3])), 'schema + samples'))
    for reason in ('too-big', 'unreadable', 'derived', 'owner-never', 'since'):
        if reason in sk:
            p('  %-15s %-60s %s' % (reason, '%s files, %s' % (num(sk[reason]['files']), human(sk[reason]['bytes'])), w('skip')))
    p(w('sensitive'))
    cc = plan.cat_counts
    for cat in ('medical', 'intimate', 'finances'):
        c = cc.get(cat)
        state = ('yes' if cat in plan.chosen else 'no') if hasattr(plan, 'chosen') else ('[y/N]' if cat not in DEFAULT_CATEGORIES_ON else '[Y/n]')
        if c:
            p('  %-15s %-60s %s' % (w(cat), '%d files, %d tables in %d stores (%s)' % (c['files'], c['tables'], len(c['stores']), human(c['bytes'])), state))
        else:
            p('  %-15s %s' % (w(cat), w('none_found')))
    for n in plan.notes:
        p('Note: ' + n)
    p('%s: ~%s -> %s' % (w('bundle'), human(estimate_bytes(plan)), plan.out_path))
    p(w('diary'))


def plan_json(plan):
    def table(t):
        return {k: v for k, v in t.items() if not k.startswith('_')}
    return {
        'collector': VERSION,
        'source': {'kind': plan.cand['kind'], 'agentId': plan.cand['agentId'], 'displayName': plan.display, 'layout': plan.layout, 'schemaVersion': plan.schema_version},
        'roots': [{'id': r[0], 'role': r[1], 'path': tilde(r[2])} for r in plan.cand['roots']],
        'sections': [{'key': k, 'text': t, 'action': a} for k, t, a in sections(plan)],
        'packed': {'files': len(plan.items), 'bytes': sum(it['bytes'] for it in plan.items), 'byKind': {k: len([1 for it in plan.items if it['kind'] == k]) for k in sorted(set(it['kind'] for it in plan.items))}},
        'stores': [{'id': s['id'], 'source': '%s/%s' % (s['root'], s['rel']) if not s.get('postgres') else pg_safe(s['postgres']), 'reader': s['reader'], 'bytes': s['bytes'],
                    'tables': [{'name': t['name'], 'rows': t['rows'], 'verdict': t['verdict'], 'cats': t.get('cats', [])} for t in s['info']['tables']]} for s in plan.stores],
        'skipped': {r: {'files': v['files'], 'bytes': v['bytes']} for r, v in plan.skips.items()},
        'categories': {c: {'files': v['files'], 'tables': v['tables'], 'bytes': v['bytes'], 'chosen': c in getattr(plan, 'chosen', [])} for c, v in plan.cat_counts.items()},
        'redactions': {'config': sum(it.get('redacted', 0) for it in plan.items), 'text': REDACT.text},
        'estimateBytes': estimate_bytes(plan),
        'notes': plan.notes,
    }

# ---------------------------------------------------------------------------------------------
# Writing the bundle (section 5): one zip, ZIP64 when big, hashes.txt last
# ---------------------------------------------------------------------------------------------
class Entry(object):
    """One zip entry being written: hashes and counts what goes through it."""

    def __init__(self, zf, name, hashes):
        self.name = name
        self.h = hashlib.sha256()
        self.n = 0
        self.fh = zf.open(name, 'w', force_zip64=True)
        self.hashes = hashes

    def write(self, b):
        if isinstance(b, str):
            b = b.encode('utf-8')
        self.h.update(b)
        self.n += len(b)
        self.fh.write(b)

    def close(self):
        self.fh.close()
        self.hashes.append((self.h.hexdigest(), self.n, self.name))


def progress(msg):
    sys.stderr.write('\r' + msg[:110].ljust(110))
    sys.stderr.flush()


def safe_entry_name(p):
    p = posix(p)
    parts = [x for x in p.split('/') if x not in ('', '.')]
    if any(x == '..' for x in parts):
        raise ValueError('bad path %s' % p)
    try:
        import unicodedata
        return unicodedata.normalize('NFC', '/'.join(parts))
    except ImportError:  # pragma: no cover
        return '/'.join(parts)


def write_store(zf, hashes, spec, opts, manifest_items):
    sid = spec['id']
    base = 'stores/%s/' % sid
    tables = spec['info']['tables']
    written = {}
    if spec.get('postgres'):
        e = Entry(zf, base + 'schema.sql', hashes)
        e.write(pg_schema_sql(spec['postgres'], spec['env']))
        e.close()
        chosen = [t for t in tables if t['verdict'] == 'data']
        cur = None
        part = 0
        size = 0
        for tname, row in pg_rows(spec['postgres'], spec['env'], chosen):
            if cur is None or cur.tname != tname or size > ROWS_PART_BYTES:
                if cur is not None:
                    cur.close()
                part = part + 1 if cur is not None and cur.tname == tname else 1
                cur = Entry(zf, base + 'rows/%s.%d.jsonl' % (safe_entry_name(tname).replace('/', '_'), part), hashes)
                cur.tname = tname
                size = 0
            line = json.dumps({'t': tname, 'r': row}, ensure_ascii=False) + '\n'
            cur.write(line)
            size += len(line)
            written[tname] = written.get(tname, 0) + 1
        if cur is not None:
            cur.close()
    else:
        conn = open_ro(spec['src'], opts.get('stopped'))
        try:
            e = Entry(zf, base + 'schema.sql', hashes)
            e.write(spec['info']['sql'])
            e.close()
            for t in tables:
                if t['verdict'] in ('derived', 'secret', 'unreadable', 'sensitive-unchosen'):
                    continue
                fname = re.sub(r'[^A-Za-z0-9_.\-]', '_', t['name'])
                e = Entry(zf, base + 'samples/%s.jsonl' % fname, hashes)
                for row in iter_table(conn, t['name'], t['columns'], t['withoutRowid'], SAMPLE_ROWS):
                    e.write(json.dumps({'t': t['name'], 'r': row}, ensure_ascii=False) + '\n')
                e.close()
                if t['verdict'] != 'data':
                    continue
                part = 1
                e = Entry(zf, base + 'rows/%s.%d.jsonl' % (fname, part), hashes)
                size = 0
                n = 0
                for row in iter_table(conn, t['name'], t['columns'], t['withoutRowid']):
                    line = json.dumps({'t': t['name'], 'r': row}, ensure_ascii=False) + '\n'
                    if size + len(line) > ROWS_PART_BYTES and n:
                        e.close()
                        part += 1
                        e = Entry(zf, base + 'rows/%s.%d.jsonl' % (fname, part), hashes)
                        size = 0
                    e.write(line)
                    size += len(line)
                    n += 1
                    if n % 5000 == 0:
                        progress('  %s: %s %s / %s' % (sid, t['name'], num(n), num(t['rows'])))
                e.close()
                written[t['name']] = n
        finally:
            try:
                conn.execute('ROLLBACK')
            except sqlite3.Error:
                pass
            conn.close()
    schema = {'id': sid, 'source': '%s/%s' % (spec['root'], spec['rel']) if not spec.get('postgres') else pg_safe(spec['postgres']), 'kind': 'postgres' if spec.get('postgres') else 'sqlite', 'reader': spec['reader'],
              'bytes': spec['bytes'], 'tables': [dict({k: v for k, v in t.items() if k not in ('avgRowBytes',)}, written=written.get(t['name'], 0)) for t in tables]}
    e = Entry(zf, base + 'schema.json', hashes)
    e.write(json.dumps(schema, ensure_ascii=False, indent=1))
    e.close()
    manifest_items.append({'path': base, 'kind': 'postgres' if spec.get('postgres') else 'sqlite', 'source': schema['source'], 'reader': spec['reader'], 'tables': len(tables), 'rows': sum(written.values())})


def write_bundle(plan, out_path):
    opts = plan.opts
    need = estimate_bytes(plan)
    target_dir = os.path.dirname(os.path.abspath(out_path)) or '.'
    free = shutil.disk_usage(target_dir).free
    if free < need * 1.1:
        raise RuntimeError('Not enough free space in %s: about %s needed, %s free. Use --out on a bigger disk, or --max-size.' % (target_dir, human(need * 1.1), human(free)))
    tmp = '%s.partial-%d' % (out_path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0), 0o600)
    hashes = []
    items_out = []
    ok = False
    try:
        with os.fdopen(fd, 'wb') as fh:
            with zipfile.ZipFile(fh, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                for k, it in enumerate(plan.items):
                    if k % 50 == 0:
                        progress('  %d / %d files' % (k, len(plan.items)))
                    name = safe_entry_name(it['path'])
                    rec = {'path': name, 'kind': it['kind'], 'bytes': it['bytes'], 'mtime': it['mtime']}
                    for key in ('history', 'of', 'cats'):
                        if it.get(key):
                            rec[key] = it[key]
                    if it['kind'] == 'config':
                        name = name + '.json'
                        rec['path'] = name
                        rec['format'] = it['tree'].get('$format')
                        rec['redacted'] = it.get('redacted', 0)
                        e = Entry(zf, name, hashes)
                        e.write(json.dumps(it['tree'], ensure_ascii=False, indent=1))
                        e.close()
                    elif it['kind'] == 'session' and it['rel'].endswith('.jsonl'):
                        e = Entry(zf, name, hashes)
                        fd2 = os.open(it['src'], os.O_RDONLY | getattr(os, 'O_BINARY', 0))
                        with os.fdopen(fd2, 'rb') as src:
                            for line in src:
                                e.write(scrub_text(line.decode('utf-8', 'replace')))
                        e.close()
                    else:
                        data = read_bytes(it['src'])
                        e = Entry(zf, name, hashes)
                        e.write(scrub_text(data.decode('utf-8', 'replace')) if it['kind'] in TEXT_KINDS or it['kind'].startswith('ws-') else data)
                        e.close()
                    items_out.append(rec)
                for spec in plan.stores:
                    progress('  %s ...' % spec['id'])
                    write_store(zf, hashes, spec, opts, items_out)
                progress('  manifest')
                pj = plan_json(plan)
                e = Entry(zf, 'plan.json', hashes)
                e.write(json.dumps(dict(pj, skippedList=plan.skip_list), ensure_ascii=False, indent=1))
                e.close()
                manifest = {
                    'format': FORMAT, 'version': FORMAT_VERSION,
                    'collector': {'version': VERSION, 'sha256': self_sha(), 'python': '%d.%d.%d' % sys.version_info[:3], 'os': '%s-%s' % (sys.platform, os.uname().machine if hasattr(os, 'uname') else '')},
                    'createdAt': iso_utc(), 'timeZone': local_zone(),
                    'source': {'kind': plan.cand['kind'], 'agentId': plan.cand['agentId'], 'displayName': plan.display, 'detected': {'schemaVersion': plan.schema_version, 'layout': plan.layout}},
                    'roots': [{'id': r[0], 'role': r[1], 'path': tilde(r[2])} for r in plan.cand['roots']],
                    'items': items_out,
                    'skipped': plan.skip_list,
                    'categories': {c: {'chosen': c in plan.chosen, 'items': plan.cat_counts.get(c, {}).get('items', 0)} for c in ('medical', 'intimate', 'finances')},
                    'redactions': {'config': sum(it.get('redacted', 0) for it in plan.items), 'text': REDACT.text},
                    'postgres': [{'id': s['id'], 'server': pg_safe(s['postgres'])} for s in plan.stores if s.get('postgres')],
                }
                e = Entry(zf, 'manifest.json', hashes)
                e.write(json.dumps(manifest, ensure_ascii=False, indent=1))
                e.close()
                zf.writestr('hashes.txt', ''.join('%s  %d  %s\n' % h for h in hashes))
        os.replace(tmp, out_path)
        try:
            os.chmod(out_path, 0o600)
        except OSError:
            pass
        ok = True
    finally:
        if not ok:
            try:
                os.remove(tmp)
            except OSError:
                pass
    sys.stderr.write('\n')
    return out_path


def self_sha():
    try:
        return hashlib.sha256(read_bytes(os.path.abspath(__file__))).hexdigest()
    except Exception:
        return ''


def local_zone():
    tz = os.environ.get('TZ')
    if tz:
        return tz
    try:
        link = os.path.realpath('/etc/localtime')
        if 'zoneinfo/' in link:
            return link.split('zoneinfo/')[-1]
    except OSError:
        pass
    # Windows names its zones differently ("Central Standard Time"): those are not passed on.
    return None


# ---------------------------------------------------------------------------------------------
# verify and send
# ---------------------------------------------------------------------------------------------
def verify(path):
    bad = 0
    with zipfile.ZipFile(path) as zf:
        lines = zf.read('hashes.txt').decode('utf-8').splitlines()
        listed = set()
        for line in lines:
            m = re.match(r'^([0-9a-f]{64})  (\d+)  (.+)$', line)
            if not m:
                continue
            sha, size, name = m.group(1), int(m.group(2)), m.group(3)
            listed.add(name)
            h = hashlib.sha256()
            n = 0
            with zf.open(name) as f:
                while True:
                    b = f.read(1 * MiB)
                    if not b:
                        break
                    h.update(b)
                    n += len(b)
            if h.hexdigest() != sha or n != size:
                bad += 1
                print('MISMATCH  %s' % name)
        extra = [i.filename for i in zf.infolist() if i.filename not in listed and i.filename != 'hashes.txt']
        for x in extra:
            bad += 1
            print('NOT LISTED  %s' % x)
        m = json.loads(zf.read('manifest.json').decode('utf-8'))
    src = m.get('source', {})
    print('%s %s  %s (%s)  made %s by collector %s' % (m.get('format'), m.get('version'), src.get('displayName'), src.get('kind'), m.get('createdAt'), m.get('collector', {}).get('version')))
    kinds = {}
    for it in m.get('items', []):
        kinds[it['kind']] = kinds.get(it['kind'], 0) + 1
    print('  items: ' + ', '.join('%s %d' % kv for kv in sorted(kinds.items())))
    reasons = {}
    for s in m.get('skipped', []):
        reasons[s['reason']] = reasons.get(s['reason'], 0) + s.get('files', 1)
    print('  left behind: ' + ', '.join('%s %d' % kv for kv in sorted(reasons.items())))
    print('  hashes: %s' % ('all %d match' % len(lines) if not bad else '%d problems' % bad))
    return 0 if not bad else 1


def send(path, to, code):
    try:
        from urllib.request import Request, urlopen
    except ImportError:  # pragma: no cover
        raise SystemExit('This Python has no urllib.request.')
    base = to.rstrip('/')
    if not base.startswith('https://') and not re.match(r'^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$', base):
        raise SystemExit('Use the https:// address of your Sara (plain http only for this computer).')
    size = os.path.getsize(path)
    hdr = {'content-type': 'application/json', 'x-movein-code': code}

    def call(method, url, body=None, headers=None):
        req = Request(base + url, data=body, method=method, headers=headers or hdr)
        with urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode('utf-8') or '{}')
    up = call('POST', '/api/movein/send', json.dumps({'code': code, 'name': os.path.basename(path), 'size': size}).encode('utf-8'))
    uid = up['id']
    chunk = int(up.get('chunk') or 8 * MiB)
    offset = int(up.get('received') or 0)
    tries = 0
    with open(path, 'rb') as f:
        while offset < size:
            f.seek(offset)
            b = f.read(chunk)
            try:
                r = call('PUT', '/api/movein/uploads/%s?offset=%d' % (uid, offset), b, {'content-type': 'application/octet-stream', 'x-movein-code': code})
                offset = int(r.get('received', offset + len(b)))
                tries = 0
                progress('  sent %s of %s' % (human(offset), human(size)))
            except Exception as e:  # noqa: BLE001 - network hiccup: ask where it got to, then go on
                tries += 1
                if tries > 5:
                    raise SystemExit('\nThe upload stopped (%s). Run the same command again to resume.' % e)
                time.sleep(2 * tries)
                offset = int(call('GET', '/api/movein/uploads/%s' % uid).get('received', offset))
    call('POST', '/api/movein/uploads/%s/done' % uid, b'{}')
    sys.stderr.write('\n')
    print('Sent. Open Settings -> Data & health -> Move in from another agent in Sara to see what is inside.')

# ---------------------------------------------------------------------------------------------
# The command line
# ---------------------------------------------------------------------------------------------
def parse_size(s):
    m = re.match(r'^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)B?\s*$', s or '', re.I)
    if not m:
        raise SystemExit('Size like 2G or 500M, please (got %r).' % s)
    return int(float(m.group(1)) * {'': 1, 'K': 1024, 'M': MiB, 'G': 1024 * MiB, 'T': 1024 * 1024 * MiB}[m.group(2).upper()])


def ask(q, default):
    if not sys.stdin.isatty():
        return default
    try:
        a = input(q).strip().lower()
    except EOFError:
        return default
    if not a:
        return default
    return a[0] in 'yjso'


def main(argv=None):
    global LANG
    import argparse
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = 'collect'
    if argv and argv[0] in ('collect', 'verify', 'send'):
        cmd = argv.pop(0)
    ap = argparse.ArgumentParser(prog='sara-movein.py ' + cmd, description='Sara move-in collector %s (read-only).' % VERSION)
    if cmd == 'verify':
        ap.add_argument('file')
        a = ap.parse_args(argv)
        return verify(a.file)
    if cmd == 'send':
        ap.add_argument('file')
        ap.add_argument('--to', required=True, help='your Sara, e.g. https://sara.example.com')
        ap.add_argument('--code', required=True, help='the move-in code from Sara\'s Move in page (valid 30 minutes)')
        a = ap.parse_args(argv)
        send(a.file, a.to, a.code)
        return 0
    ap.add_argument('--hermes-home', help='the Hermes Agent home (default ~/.hermes)')
    ap.add_argument('--openclaw-state', help='the OpenClaw state folder (default ~/.openclaw)')
    ap.add_argument('--workspace', help='the OpenClaw workspace, when it is somewhere unusual')
    ap.add_argument('--agent', help='which profile (Hermes) or agent id (OpenClaw) to pack, when there are several')
    ap.add_argument('--scan', action='append', help='a custom agent folder to look through (SQLite stores, persona files, skills)')
    ap.add_argument('--postgres', action='append', help='a Postgres connection string or service name (read-only; uses the system psql/pg_dump)')
    ap.add_argument('--plan-only', action='store_true', help='only show the plan; write nothing')
    ap.add_argument('--json', action='store_true', help='print the plan as JSON (with --plan-only)')
    ap.add_argument('--yes', action='store_true', help='do not ask (sensitive categories stay out unless --include-category)')
    ap.add_argument('--out', help='where to write the bundle (a file or a folder; default: this folder)')
    ap.add_argument('--stopped', action='store_true', help='the old agent is stopped: open its databases as immutable (no sidecar files at all)')
    ap.add_argument('--include-category', action='append', default=[], choices=['medical', 'intimate', 'finances'], help='pack this sensitive category')
    ap.add_argument('--exclude-category', action='append', default=[], choices=['medical', 'intimate', 'finances'], help='leave this category out')
    ap.add_argument('--include', action='append', help='also pack files matching this pattern (never secrets)')
    ap.add_argument('--exclude', action='append', help='leave files matching this pattern out')
    ap.add_argument('--never', action='append', help='never touch files matching this pattern (not even their names are read further)')
    ap.add_argument('--include-table', action='append', default=[], help='db:table to pack although it looks like telemetry')
    ap.add_argument('--since', help='only sessions changed since YYYY-MM-DD')
    ap.add_argument('--max-size', help='stop if the bundle would be bigger, e.g. 2G')
    ap.add_argument('--lang', help='en, es, fr, de, pt-BR or it')
    ap.add_argument('--allow-root', action='store_true', help='run as root anyway (then only the given homes are read)')
    a = ap.parse_args(argv)
    LANG = pick_lang(a.lang)
    if hasattr(os, 'geteuid') and os.geteuid() == 0 and not a.allow_root:
        print('This collector does not run as root (it could read other people\'s files). Run it as the user your agent runs as, or add --allow-root with --hermes-home / --openclaw-state.')
        return 2
    if a.allow_root and not (a.hermes_home or a.openclaw_state or a.scan):
        print('With --allow-root, name the home: --hermes-home PATH or --openclaw-state PATH.')
        return 2
    opts = {'hermes_home': a.hermes_home, 'openclaw_state': a.openclaw_state, 'workspace': a.workspace, 'scan': a.scan, 'postgres': a.postgres,
            'stopped': a.stopped, 'include': a.include, 'exclude': a.exclude, 'never': a.never, 'include_table': a.include_table}
    if a.since:
        try:
            opts['since_ts'] = time.mktime(time.strptime(a.since, '%Y-%m-%d'))
        except ValueError:
            print('--since wants a date like 2026-01-31.')
            return 2
    cands = find_candidates(opts)
    if not cands:
        print(w('nothing'))
        return 1
    cand = None
    if a.agent:
        cand = next((c for c in cands if c['agentId'] == a.agent), None)
        if not cand:
            print('No agent or profile called %r. Found: %s' % (a.agent, ', '.join(c['agentId'] for c in cands)))
            return 1
    elif len(cands) > 1 and sys.stdin.isatty() and not a.yes and not a.plan_only:
        for k, c in enumerate(cands, 1):
            print('  %d) %s' % (k, c['label']))
        try:
            k = int(input('Which one? (one bundle per agent) [1] ') or '1')
        except (ValueError, EOFError):
            k = 1
        cand = cands[max(1, min(k, len(cands))) - 1]
    else:
        cand = cands[0]
        if len(cands) > 1 and not a.json:
            print('Several agents found; packing %s. Pick another with --agent: %s' % (cand['agentId'], ', '.join(c['agentId'] for c in cands)))
    plan = build_plan(cand, opts)
    for inc in a.include_table:
        db, _, tname = inc.partition(':')
        for s in plan.stores:
            if db in (s['rel'], os.path.basename(s['rel']), s['id']):
                for t in s['info']['tables']:
                    if t['name'] == tname and t['verdict'] == 'telemetry':
                        t['verdict'], t['why'] = 'data', 'included with --include-table'
    plan.cat_counts = category_counts(plan)
    stamp = time.strftime('%Y-%m-%d')
    slug = re.sub(r'[^A-Za-z0-9_\-]+', '-', plan.display).strip('-').lower() or 'agent'
    out = a.out or '.'
    plan.out_path = os.path.abspath(os.path.join(out, '%s-%s.saramove' % (slug, stamp)) if os.path.isdir(out) else out)
    if a.plan_only:
        chosen = set(c for c in DEFAULT_CATEGORIES_ON if c not in a.exclude_category) | set(a.include_category)
        if a.json:
            plan.chosen = sorted(chosen)
            print(json.dumps(dict(plan_json(plan), candidates=[{'kind': c['kind'], 'agentId': c['agentId']} for c in cands]), indent=1, default=lambda x: sorted(x) if isinstance(x, set) else str(x)))
        else:
            print_plan(plan)
            print(w('plan_only'))
        return 0
    print_plan(plan)
    chosen = set(c for c in DEFAULT_CATEGORIES_ON if c not in a.exclude_category) | set(a.include_category)
    if not a.yes:
        for cat in ('medical', 'intimate'):
            if plan.cat_counts.get(cat) and cat not in chosen and ask(w('include_q', what=w(cat)), False):
                chosen.add(cat)
    apply_categories(plan, chosen)
    est = estimate_bytes(plan)
    if a.max_size and est > parse_size(a.max_size):
        print('The bundle would be about %s, more than --max-size %s. Leave things out with --exclude or --since.' % (human(est), a.max_size))
        return 1
    if not a.yes and not ask(w('continue_q'), True):
        return 0
    path = write_bundle(plan, plan.out_path)
    print('%s: %s (%s)' % (w('written'), path, human(os.path.getsize(path))))
    print(w('diary'))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.stderr.write('\nStopped. Nothing was changed.\n')
        sys.exit(130)
