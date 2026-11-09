import { localize } from './locale.mjs';
import { parameters, contract } from './schema.mjs';
export function object(a) { if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Expected an object.'); if (JSON.stringify(a).length > 24000) throw new Error('Input exceeds 24000 characters.'); return a; }
export function text(x, name, max = 1500, optional = false) { if (optional && x === undefined) return ''; if (typeof x !== 'string' || (!optional && !x.trim()) || x.length > max) throw new Error(`${name}: expected ${optional ? '0' : '1'} to ${max} characters.`); return x; }
export function list(x, name, max = 8) { if (!Array.isArray(x) || x.length > max) throw new Error(`${name}: expected an array of at most ${max} items.`); return x; }
export function result(value, args) { const content = JSON.stringify(localize(value, args)); if (content.length > 3800) throw new Error('Result exceeds channel display limit; supply fewer or shorter items.'); return { content }; }
export function only(a, keys) { object(a); if (Object.keys(a).some(k => !keys.includes(k))) throw new Error('Unknown input field.'); }
export function number(x, name, min = 0, max = 10000000) { if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) throw new Error(`${name}: expected a finite number from ${min} to ${max}.`); return x; }
export function tool(description, run) { return { name: 'workflow', description: description + ' ' + contract, permission: 'ask', parameters, run }; }
