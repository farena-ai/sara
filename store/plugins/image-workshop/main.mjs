import { plugin } from './native.mjs';
import { only, text, number, result, tool } from './workflow.mjs';
const styles = { product: 'Studio product photograph, neutral background, soft light', illustration: 'Editorial illustration, clear shapes, balanced composition', cinematic: 'Cinematic composition, controlled lighting, rich detail' };
function preset(args, stored = false) {
  only(args, stored ? ['version', 'brief', 'style', 'aspect', 'avoid', 'seed'] : ['action', 'brief', 'style', 'aspect', 'avoid', 'seed']);
  if (stored && args.version !== 1) throw new Error('Unsupported stored preset version.');
  const brief = text(args.brief, 'brief', 600), style = text(args.style, 'style', 20), aspect = text(args.aspect, 'aspect', 5), avoid = text(args.avoid, 'avoid', 200, true);
  if (stored && typeof args.avoid !== 'string') throw new Error('Stored avoid must be a string.');
  if (!Object.hasOwn(styles, style) || !['1:1', '16:9', '9:16'].includes(aspect)) throw new Error('Choose a supported style and aspect ratio.');
  const seed = args.seed === undefined && !stored || args.seed === null && stored ? null : number(args.seed, 'seed', 0, 2147483647);
  if (seed !== null && !Number.isInteger(seed)) throw new Error('seed must be an integer.');
  return { version: 1, brief, style, aspect, avoid, seed };
}
async function read(sara) {
  const value = await sara.kv.get('brief');
  if (value === null) return null;
  try { return preset(value, true); } catch { throw new Error('Stored preset is corrupt or unsupported; preserved unchanged. Export or repair it separately.'); }
}
function presentation(p) {
  const { brief, style, aspect, avoid } = p;
  return { ...p, prompt: `${styles[style]}. ${brief}. Aspect ${aspect}.${avoid ? ` Avoid: ${avoid}.` : ''}`, generated: false, status: 'preparation only', prerequisite: 'Install and review an image MCP server; verify its exact MCP tool name, input schema and output receipt. Run it separately in Sara with approval. No native generator or discovery API exists here.' };
}
async function persist(sara, value) {
  const receipt = await sara.kv.set('brief', value);
  if (receipt?.ok !== true) throw new Error('Persistence was not confirmed; no saved or cleared claim.');
  const actual = await read(sara);
  if (JSON.stringify(actual) !== JSON.stringify(value)) throw new Error('Stored preset readback did not match; no saved or cleared claim.');
}
// Serialize mutations so a validated state cannot be overwritten by another in-process operation.
let queue = Promise.resolve();
function serial(fn) { const next = queue.then(fn); queue = next.catch(() => {}); return next; }
plugin({ tools: [tool('Prepare, save, load or clear one structured image brief and reproducible prompt. Does not generate images or connect a generator.', async (args, sara) => {
  only(args, ['action', 'brief', 'style', 'aspect', 'avoid', 'seed']);
  if (['load', 'clear'].includes(args.action)) {
    if (Object.keys(args).length !== 1) throw new Error('Load and clear take only action.');
    if (args.action === 'clear') return serial(async () => { await read(sara); await persist(sara, null); return result({ cleared: true, generated: false }); });
    const saved = await read(sara);
    return result(saved === null ? { status: 'empty', generated: false } : presentation(saved));
  }
  if (!['save', 'prepare'].includes(args.action)) throw new Error('Choose prepare, save, load or clear.');
  const p = preset(args), value = presentation(p);
  if (args.action === 'save') return serial(async () => { const out = result({ ...value, saved: true }); await read(sara); await persist(sara, p); return out; });
  return result(value);
})] });
