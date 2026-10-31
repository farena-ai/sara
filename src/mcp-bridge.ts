#!/usr/bin/env node
// Phase 57: a stdio bridge to Sara's MCP server, for MCP apps that start a program instead of
// calling an address (Claude Desktop, some editors). This file is standalone (Node built-ins only):
// Settings → Connections → Other apps downloads it as sara-mcp.ts, and clients/mcp/sara-mcp.ts in
// the repo runs it. It reads JSON-RPC lines on stdin, sends each
// one to <server>/mcp with the API key, and writes the answers (JSON or SSE) back as lines on
// stdout. Zero dependencies; Node 24 runs it as is.
//
//   node sara-mcp.ts --server https://sara.example.ts.net      (key in SARA_API_KEY)
//   node sara-mcp.ts --server http://127.0.0.1:7860 --key-file ~/.sara-api-key
//   node sara-mcp.ts --describe      (no server: answers initialize and tools/list with her tools,
//                                     for MCP directories that check a server by starting it)
//   node sara-mcp.ts --server work   (Phase 68: a server saved by `sara-chat servers add`, by its
//                                     name; uses that server's own sign-in from sara-chat's file.
//                                     SARA_SERVER=work does the same)
//
// The key never goes on the command line (other programs on the computer can read that).
// Logs go to stderr only (stdout is the protocol).
import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

interface Options {
  server: string;
  key: string;
  /** No server: answer the handshake and tools/list locally; tool calls explain how to connect. */
  describe?: boolean;
}

function usage(msg: string): never {
  process.stderr.write(`sara-mcp: ${msg}\nUse: node sara-mcp.ts --server https://<her address> [--key-file <file>]  (or set SARA_URL and SARA_API_KEY), or --server <name> of a server saved by sara-chat\n`);
  process.exit(2);
}

/** sara-chat's config folder (the same rule as clients/cli/sara.ts configDir). */
export function chatConfigDir(env: NodeJS.ProcessEnv, os = platform()): string {
  if (env.SARA_CHAT_CONFIG_DIR) return env.SARA_CHAT_CONFIG_DIR;
  if (os === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'sara-chat');
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support', 'sara-chat');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sara-chat');
}

interface ChatProfile {
  id: string;
  name: string;
  url: string;
  token?: string;
}

/**
 * Phase 68: a server saved by `sara-chat servers add`, found by its id, name (any case), address
 * or host[:port] in sara-chat's config.json (1.8 list, or the older single-server file). Returns
 * its address and its own device token; the token is never paired with another address.
 */
export function chatProfile(want: string, env: NodeJS.ProcessEnv, os = platform()): { url: string; token: string; name: string } | undefined {
  let raw: { servers?: ChatProfile[]; server?: string; token?: string } = {};
  try {
    raw = JSON.parse(readFileSync(join(chatConfigDir(env, os), 'config.json'), 'utf8')) as typeof raw;
  } catch {
    return undefined;
  }
  const list: ChatProfile[] = Array.isArray(raw.servers) ? raw.servers.filter((p) => p && typeof p.url === 'string') : raw.server ? [{ id: 's1', name: '', url: raw.server, ...(raw.token ? { token: raw.token } : {}) }] : [];
  const w = want.trim();
  const lower = w.toLowerCase();
  const host = (u: string): string => {
    try {
      return new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`).host.toLowerCase();
    } catch {
      return '';
    }
  };
  const one = <T,>(xs: T[]): T | undefined => (xs.length === 1 ? xs[0] : undefined);
  const p =
    list.find((x) => x.id === w) ??
    one(list.filter((x) => String(x.name ?? '').toLowerCase() === lower)) ??
    list.find((x) => x.url.replace(/\/+$/, '') === w.replace(/\/+$/, '')) ??
    one(list.filter((x) => host(x.url) && host(x.url) === host(w)));
  if (!p || !p.token) return undefined;
  return { url: p.url, token: p.token, name: p.name || host(p.url) };
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
  if (argv.includes('--describe')) return { server: '', key: '', describe: true };
  let server = env.SARA_URL ?? env.SARA_SERVER ?? '';
  let keyFile = env.SARA_API_KEY_FILE ?? '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server' || a === '--url') server = argv[++i] ?? '';
    else if (a === '--key-file') keyFile = argv[++i] ?? '';
    else if (a === '--key') usage("don't put the key on the command line: use SARA_API_KEY or --key-file.");
    else if (a === '--help' || a === '-h') usage('a bridge from stdio to Sara’s MCP server.');
    else usage(`unknown option ${a}`);
  }
  let key = (env.SARA_API_KEY ?? '').trim();
  if (!key && keyFile) {
    try {
      key = readFileSync(keyFile.replace(/^~(?=$|[\\/])/, homedir()), 'utf8').trim();
    } catch (err) {
      usage(`can't read the key file: ${(err as Error).message}`);
    }
  }
  if (!server) usage('say which server (--server or SARA_URL).');
  // A name (not an address), or an address without a key: a server saved by sara-chat, with its
  // own sign-in. A key from SARA_API_KEY is only used with an address typed out in full.
  const isAddress = /^https?:\/\//i.test(server);
  if (!isAddress || !key) {
    const saved = chatProfile(server, env);
    if (saved) {
      process.stderr.write(`sara-mcp: using "${saved.name}" (${saved.url}) with sara-chat's sign-in for it.\n`);
      server = saved.url;
      key = saved.token;
    } else if (!isAddress) usage(`no server called "${server}" in sara-chat (sara-chat servers lists them), and it isn't an address starting with https://.`);
  }
  if (!key) usage('no API key (SARA_API_KEY or --key-file). Make one in Sara: Settings → Connections → Other apps.');
  let u: URL;
  try {
    u = new URL(server);
  } catch {
    usage(`"${server}" isn't a web address.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') usage('the server address must start with https:// (or http:// on your own network).');
  const endpoint = u.pathname.replace(/\/+$/, '').endsWith('/mcp') ? u.href.replace(/\/+$/, '') : `${u.origin}${u.pathname.replace(/\/+$/, '')}/mcp`;
  return { server: endpoint, key };
}

/** The JSON-RPC messages in an SSE body (each `data:` event). */
export function sseMessages(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data.trim()) out.push(data);
  }
  return out;
}

/**
 * Her MCP tools, as Sara's server lists them (all of them; a real server hides write tools unless the
 * owner allows changes). Kept identical to describeTools() in src/mcp-server.ts by a test.
 */
export const DESCRIBE_TOOLS = [
  {
    "name": "search_memory",
    "title": "Search her memory",
    "description": "Search Sara's long-term memory about the owner (facts, summaries of past conversations, decisions, promises, dates) by words and meaning. Use it for context about the owner's life, preferences and projects; use list_facts to browse all facts, search_library for documents, and list_recent_conversations for what was talked about lately. Returns plain text, one note per line: \"- [kind, YYYY-MM-DD] text\", best match first, or a line saying nothing was found. Read-only. Never includes other people's chats, private conversations or (while Adult mode is off) anything explicit.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Words to look for in her memory. Up to 200 characters.",
          "examples": [
            "sister",
            "deploy server",
            "favourite food"
          ]
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "default": 10,
          "description": "Most notes to return, 1 to 50 (default 10).",
          "examples": [
            10
          ]
        }
      },
      "required": [
        "query"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Search her memory",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "list_facts",
    "title": "List facts about the owner",
    "description": "List the facts Sara has learned about the owner (name, people, likes, habits, work), newest first. Use it to get a general picture of the owner; use search_memory to find something specific, and remember_fact to add a fact. Returns plain text, one fact per line: \"- [fact, YYYY-MM-DD] text\", or \"No notes yet.\" Read-only; facts from other people's chats and private conversations are never included.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 30,
          "description": "Most facts to return, 1 to 100 (default 30).",
          "examples": [
            30
          ]
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "title": "List facts about the owner",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "list_recent_conversations",
    "title": "List recent conversations",
    "description": "List the owner's most recent conversations with Sara, newest first, each with its title, when it was last active and a short summary when she has one. Use it to see what the owner has been talking about lately; use search_memory to look for a topic across all of her memory. Returns plain text, one conversation per line: \"- Title (last <date and time>): summary\", or \"No conversations yet.\" Read-only. Never lists other people's chats, private, archived or imported conversations.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 30,
          "default": 10,
          "description": "Most conversations to return, 1 to 30 (default 10).",
          "examples": [
            10
          ]
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "title": "List recent conversations",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "get_today",
    "title": "Get today's agenda",
    "description": "Get the owner's agenda for today in one view: to-dos due today or overdue (and high-priority ones without a date), reminders in the next 24 hours, calendar events when a calendar is connected, and birthdays or other dates that matter coming up. Use it for \"what's on today\"; use list_tasks for the whole to-do list with filters. Returns plain text: the date, then sections \"To-dos:\" (\"- #id title (due …)\"), \"Reminders:\", \"Calendar:\" and \"Coming up:\". The #ids work with complete_task, update_task and delete_task. Read-only; takes no input.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    "annotations": {
      "title": "Get today's agenda",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "list_tasks",
    "title": "List to-dos",
    "description": "List the to-dos in the owner's planner in Sara, optionally only open or done ones, or one project. Use it to see the whole to-do list or find a to-do's id; use get_today for just what's due today. Returns plain text, up to 100 lines, open ones first by priority and due date: \"- #id [ ] title (priority) due <date> [project]\" ([x] when done), or \"Nothing open.\" The #id is what complete_task, update_task and delete_task take. Read-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "open",
            "done",
            "all"
          ],
          "default": "open",
          "description": "Which to-dos: \"open\" (default), \"done\", or \"all\".",
          "examples": [
            "open"
          ]
        },
        "project": {
          "type": "string",
          "maxLength": 80,
          "description": "Only to-dos in this planner project (name, any case). Leave out for all projects.",
          "examples": [
            "Garden"
          ]
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "title": "List to-dos",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "search_library",
    "title": "Search her library",
    "description": "Search the documents the owner keeps in Sara's library (PDFs, Word files, spreadsheets, books, saved web pages) by words and meaning. Use it for questions answered by the owner's documents; use search_memory for what Sara remembers from conversations. Returns up to 6 passages (each up to 1,400 characters), each headed by \"[document title, place]\" (page or section), or a line saying nothing was found. Read-only; documents shared in a single chat only are left out.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300,
          "description": "What to look for, as words or a question. Up to 300 characters.",
          "examples": [
            "when does the lease end",
            "warranty period"
          ]
        }
      },
      "required": [
        "query"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Search her library",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "list_notes",
    "title": "List notes",
    "description": "List the notes in the owner's planner in Sara (titles only), newest first, or the ones matching some words. Use it to find a note's id; then read it with read_note, change it with update_note or remove it with delete_note. Returns plain text, up to 100 lines: \"- #id title [project] (updated YYYY-MM-DD)\", or \"No notes.\" Read-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "maxLength": 200,
          "description": "Only notes containing these words (title or text). Leave out to list the newest notes.",
          "examples": [
            "deploy",
            "recipe"
          ]
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "title": "List notes",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "read_note",
    "title": "Read a note",
    "description": "Read one note from the owner's planner in Sara, in full, by its id. Use list_notes first to find the id. Returns the note as Markdown: \"# Title\", a blank line, then the text. An unknown id returns an error. Read-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "integer",
          "minimum": 1,
          "description": "The note id: the number after # in list_notes's results (e.g. 12 for #12). An unknown id is refused with an error and nothing changes.",
          "examples": [
            12
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Read a note",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "ask_sara",
    "title": "Ask Sara",
    "description": "Send Sara a message and get her reply, as in a chat: she answers with her memory and personality in a conversation kept for this app, which the owner can read in Sara. Use it for questions, opinions or anything conversational; to store a fact on purpose use remember_fact, and to change the planner use the to-do and note tools. Returns her reply as plain text (with the AI notice when a new session starts). If her own tools are allowed for other apps and one needs the owner's OK, it returns a note that it is waiting for approval in Sara. Can take up to a few minutes; one key can have two replies running at once.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "message": {
          "type": "string",
          "minLength": 1,
          "maxLength": 20000,
          "description": "What to say to her, in plain words. Up to 20,000 characters.",
          "examples": [
            "What did we decide about the garden fence?"
          ]
        }
      },
      "required": [
        "message"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Ask Sara",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "add_task",
    "title": "Add a to-do",
    "description": "Add a new to-do to the owner's planner in Sara, with an optional due time, project and priority. Use update_task to change an existing one. Returns \"Added to-do #id: title\" (the #id works with complete_task, update_task and delete_task). A due time without an hour means 9:00 in the owner's time zone. Only listed when the owner turns on \"Let other apps change things\" in Sara. Follows the owner's approval setting for her todo tool (allowed, ask first, or off): when it asks first, it returns \"Waiting for approval in Sara\" and nothing changes until the owner presses Allow there; when it is off, it returns that it's turned off.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "What to do, short. Up to 200 characters.",
          "examples": [
            "Call the vet"
          ]
        },
        "due": {
          "type": "string",
          "maxLength": 80,
          "description": "When it is due, in words or as a date, read in the owner's time zone. Leave out for no due date.",
          "examples": [
            "tomorrow 9am",
            "friday",
            "2026-11-03"
          ]
        },
        "project": {
          "type": "string",
          "maxLength": 80,
          "description": "Planner project name to file it under, e.g. \"Garden\" or \"Sara\". Created if it doesn't exist. Up to 80 characters.",
          "examples": [
            "Garden"
          ]
        },
        "priority": {
          "type": "string",
          "enum": [
            "low",
            "normal",
            "high"
          ],
          "default": "normal",
          "description": "How important: \"low\", \"normal\" (default) or \"high\".",
          "examples": [
            "high"
          ]
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Add a to-do",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "complete_task",
    "title": "Complete a to-do",
    "description": "Mark one of the owner's to-dos in Sara as done, by its id (from list_tasks or get_today). Use update_task with status \"open\" to reopen one. Returns \"Done: to-do #id title\". Marking a to-do that is already done changes nothing. Only listed when the owner turns on \"Let other apps change things\" in Sara. Follows the owner's approval setting for her todo tool (allowed, ask first, or off): when it asks first, it returns \"Waiting for approval in Sara\" and nothing changes until the owner presses Allow there; when it is off, it returns that it's turned off.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "integer",
          "minimum": 1,
          "description": "The to-do id: the number after # in list_tasks or get_today's results (e.g. 12 for #12). An unknown id is refused with an error and nothing changes.",
          "examples": [
            12
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Complete a to-do",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "update_task",
    "title": "Change a to-do",
    "description": "Change one of the owner's to-dos in Sara by its id (from list_tasks or get_today): its title, due time, project, priority, details or status. Only the fields you give change; the rest stay as they are. Use complete_task to simply tick one off. Returns \"Changed to-do #id: title\" with the new due time. Only listed when the owner turns on \"Let other apps change things\" in Sara. Follows the owner's approval setting for her todo tool (allowed, ask first, or off): when it asks first, it returns \"Waiting for approval in Sara\" and nothing changes until the owner presses Allow there; when it is off, it returns that it's turned off.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "integer",
          "minimum": 1,
          "description": "The to-do id: the number after # in list_tasks or get_today's results (e.g. 12 for #12). An unknown id is refused with an error and nothing changes.",
          "examples": [
            12
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "New title. Up to 200 characters.",
          "examples": [
            "Call the vet about Biscuit"
          ]
        },
        "due": {
          "type": "string",
          "maxLength": 80,
          "description": "New due time in words or as a date, read in the owner's time zone; \"none\" removes the due date.",
          "examples": [
            "next monday 10am",
            "2026-11-03",
            "none"
          ]
        },
        "project": {
          "type": "string",
          "maxLength": 80,
          "description": "Move it to this planner project (created if new); an empty string takes it out of any project.",
          "examples": [
            "Garden",
            ""
          ]
        },
        "priority": {
          "type": "string",
          "enum": [
            "low",
            "normal",
            "high"
          ],
          "description": "New priority: \"low\", \"normal\" or \"high\".",
          "examples": [
            "high"
          ]
        },
        "notes": {
          "type": "string",
          "maxLength": 2000,
          "description": "New details for the to-do (replaces the old ones). Up to 2,000 characters.",
          "examples": [
            "Ask about the booster shot."
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "open",
            "done"
          ],
          "description": "\"done\" ticks it off; \"open\" reopens a done to-do.",
          "examples": [
            "open"
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Change a to-do",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "delete_task",
    "title": "Delete a to-do",
    "description": "Delete one of the owner's to-dos from Sara's planner for good, by its id (from list_tasks or get_today). This can't be undone; to tick a to-do off instead, use complete_task. Returns \"Deleted to-do #id: title\". Only listed when the owner turns on \"Let other apps change things\" in Sara. Deleting always waits for the owner: it returns \"Waiting for approval in Sara\" and nothing changes until the owner presses Allow there (even when her todo tool is set to allowed); when that tool is off, it returns that it's turned off.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "integer",
          "minimum": 1,
          "description": "The to-do id: the number after # in list_tasks or get_today's results (e.g. 12 for #12). An unknown id is refused with an error and nothing changes.",
          "examples": [
            12
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Delete a to-do",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "add_note",
    "title": "Add a note",
    "description": "Save a new note (a title and free text, Markdown welcome) in the owner's planner in Sara, optionally in a project. Use update_note to change an existing note and remember_fact for a single fact about the owner. Returns \"Saved note #id: title\" (the #id works with read_note, update_note and delete_note). Only listed when the owner turns on \"Let other apps change things\" in Sara. Follows the owner's approval setting for her note tool (allowed, ask first, or off): when it asks first, it returns \"Waiting for approval in Sara\" and nothing changes until the owner presses Allow there; when it is off, it returns that it's turned off.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The note's title. Up to 200 characters.",
          "examples": [
            "Deploy steps"
          ]
        },
        "body": {
          "type": "string",
          "maxLength": 20000,
          "description": "The note's text (Markdown is fine). Up to 20,000 characters.",
          "examples": [
            "ssh in, git pull, restart the service"
          ]
        },
        "project": {
          "type": "string",
          "maxLength": 80,
          "description": "Planner project name to file it under, e.g. \"Garden\" or \"Sara\". Created if it doesn't exist. Up to 80 characters.",
          "examples": [
            "Garden"
          ]
        }
      },
      "required": [
        "title",
        "body"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Add a note",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "update_note",
    "title": "Change a note",
    "description": "Change one of the owner's notes in Sara by its id (from list_notes): its title, its text (replaced as a whole) or its project. Only the fields you give change. Read the note with read_note first if you mean to edit part of the text. Returns \"Changed note #id: title\". Only listed when the owner turns on \"Let other apps change things\" in Sara. Follows the owner's approval setting for her note tool (allowed, ask first, or off): when it asks first, it returns \"Waiting for approval in Sara\" and nothing changes until the owner presses Allow there; when it is off, it returns that it's turned off.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "integer",
          "minimum": 1,
          "description": "The note id: the number after # in list_notes's results (e.g. 12 for #12). An unknown id is refused with an error and nothing changes.",
          "examples": [
            12
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "New title. Up to 200 characters.",
          "examples": [
            "Deploy steps (server 2)"
          ]
        },
        "body": {
          "type": "string",
          "maxLength": 20000,
          "description": "New text for the whole note; it replaces the old text. Up to 20,000 characters.",
          "examples": [
            "ssh in, git pull, npm ci, restart the service"
          ]
        },
        "project": {
          "type": "string",
          "maxLength": 80,
          "description": "Move it to this planner project (created if new); an empty string takes it out of any project.",
          "examples": [
            "Sara",
            ""
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Change a note",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "delete_note",
    "title": "Delete a note",
    "description": "Delete one of the owner's notes from Sara's planner for good, by its id (from list_notes). This can't be undone. Returns \"Deleted note #id: title\". Only listed when the owner turns on \"Let other apps change things\" in Sara. Deleting always waits for the owner: it returns \"Waiting for approval in Sara\" and nothing changes until the owner presses Allow there (even when her note tool is set to allowed); when that tool is off, it returns that it's turned off.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "integer",
          "minimum": 1,
          "description": "The note id: the number after # in list_notes's results (e.g. 12 for #12). An unknown id is refused with an error and nothing changes.",
          "examples": [
            12
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Delete a note",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "remember_fact",
    "title": "Remember a fact",
    "description": "Ask Sara to remember one fact about the owner in her long-term memory, marked as told by this app. Use it to store something on purpose (ask_sara is for conversation, and she may or may not keep what is said there); use add_note for longer text. Returns \"Remembered (#id): fact\" once the owner allows it. Only listed when the owner turns on \"Let other apps change things\" in Sara, and it always asks first: it returns \"Waiting for approval in Sara\" and nothing is stored until the owner presses Allow there.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fact": {
          "type": "string",
          "minLength": 1,
          "maxLength": 400,
          "description": "One short fact about the owner, as a sentence. Up to 400 characters.",
          "examples": [
            "Prefers tabs over spaces",
            "Works from home on Fridays"
          ]
        }
      },
      "required": [
        "fact"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "title": "Remember a fact",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    }
  }
];

const DESCRIBE_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** Sara's version, for --describe when no package.json is next to this file. Kept equal to package.json by a test. */
export const SARA_VERSION = '2.29.0';

/** Sara's real version: package.json next to the repo when this runs from a checkout, else SARA_VERSION. */
export function describeVersion(): string {
  try {
    const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name?: unknown; version?: unknown };
    if (p.name === 'sara' && typeof p.version === 'string' && /^\d+\.\d+\.\d+/.test(p.version)) return p.version;
  } catch {
    // a downloaded copy on its own: no package.json beside it
  }
  return SARA_VERSION;
}
const CONNECT_HINT = 'This is the Sara MCP bridge in --describe mode, with no Sara server behind it. Run your own Sara (https://github.com/farena-ai/sara), make an API key in Settings → Connections → Other apps, and start the bridge with --server https://<her address> and SARA_API_KEY.';

/** --describe: answers locally, never contacts anything. */
export function describeAnswer(msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> }): unknown {
  if (msg.id === undefined || msg.id === null) return undefined; // notifications need no answer
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': {
      const want = String(msg.params?.protocolVersion ?? '');
      return ok({ protocolVersion: DESCRIBE_VERSIONS.includes(want) ? want : DESCRIBE_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sara', title: 'Sara', version: describeVersion() }, instructions: CONNECT_HINT });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: DESCRIBE_TOOLS });
    case 'tools/call':
      return ok({ content: [{ type: 'text', text: CONNECT_HINT }], isError: true });
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${String(msg.method).slice(0, 60)}` } };
  }
}

export function startBridge(opts: Options, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, fetchFn: typeof fetch = fetch): Promise<void> {
  let version = ''; // from the initialize answer (handshake revisions)
  const pending = new Set<Promise<void>>();
  const send = (obj: unknown) => output.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  const fail = (id: unknown, message: string, code = -32603) => {
    if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code, message } });
  };
  const forward = async (line: string) => {
    let msg: { id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
    }
    if (opts.describe) {
      const answer = describeAnswer(msg);
      if (answer !== undefined) send(answer);
      return;
    }
    const meta = msg.params?._meta as Record<string, unknown> | undefined;
    const pv = typeof meta?.['io.modelcontextprotocol/protocolVersion'] === 'string' ? String(meta['io.modelcontextprotocol/protocolVersion']) : msg.method === 'initialize' ? '' : version;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${opts.key}`, 'user-agent': 'sara-mcp-bridge/1' };
    if (pv) headers['mcp-protocol-version'] = pv;
    if (typeof msg.method === 'string') headers['mcp-method'] = msg.method;
    const nm = msg.params?.name ?? msg.params?.uri;
    if (typeof nm === 'string' && /^[\x20-\x7e]*$/.test(nm)) headers['mcp-name'] = nm;
    let res: Response;
    try {
      res = await fetchFn(opts.server, { method: 'POST', headers, body: line });
    } catch (err) {
      return fail(msg.id, `Can't reach Sara at ${opts.server}: ${(err as Error).message}`);
    }
    if (res.status === 202) return;
    const type = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const messages = type.includes('text/event-stream') ? sseMessages(body) : body.trim() ? [body.trim()] : [];
    if (!messages.length) return fail(msg.id, `Sara answered ${res.status} with nothing.`);
    for (const m of messages) {
      try {
        const parsed = JSON.parse(m) as { id?: unknown; result?: { protocolVersion?: unknown }; error?: unknown };
        if (msg.method === 'initialize' && typeof parsed.result?.protocolVersion === 'string') version = parsed.result.protocolVersion;
        // An error without the request's id (401, 403…): give it the id so the app can show it.
        send(parsed.error && parsed.id === undefined && msg.id !== undefined ? { ...parsed, id: msg.id } : parsed);
      } catch {
        fail(msg.id, `Sara answered ${res.status}: ${m.slice(0, 200)}`);
      }
    }
  };
  return new Promise((resolve) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const p: Promise<void> = forward(line).then(
        () => undefined,
        (err: Error) => void process.stderr.write(`sara-mcp: ${err.message}\n`),
      );
      pending.add(p);
      void p.finally(() => pending.delete(p));
    });
    rl.on('close', () => void Promise.allSettled([...pending]).then(() => resolve()));
  });
}

if (process.argv[1] && /(sara-mcp|mcp-bridge)\.(ts|js|mjs)$/.test(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2), process.env);
  if (opts.describe) process.stderr.write('sara-mcp: --describe mode (no server): listing her tools only.\n');
  void startBridge(opts).then(() => process.exit(0));
}
