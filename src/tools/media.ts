// U4.28 (docs/PICTURES.md "Editing pictures and short video"): her chat tools for the owner's local
// ComfyUI. picture_edit ("remove the person on the left", "make it 4k", "extend it to the right",
// "make it look like a watercolor") waits for the result and shows it; video_make starts a short
// clip and waits a few minutes (it keeps going in the Library's Pictures and video view after that).
// Never for kids (not in KID_TOOLS) or household members (the studio is the owner's).
import type { AppContext } from '../chat.ts';
import { mediaFor, REGIONS, regionMask, type EditOp, type MediaJob, type Region } from '../media-studio.ts';
import { measure } from '../documents/images.ts';
import type { Tool } from './types.ts';
import { ToolError } from './types.ts';

const WHAT: Record<string, EditOp> = { remove: 'inpaint', replace: 'inpaint', extend: 'outpaint', upscale: 'upscale', remove_background: 'background', restyle: 'restyle' };

/** The newest picture in the Library (when the ask names none). */
function newestPicture(app: AppContext): number | undefined {
  return app.library?.list().find((d) => d.kind === 'image' && d.status === 'ready')?.id;
}

function ended(j: MediaJob, what: string): string {
  if (j.status === 'done') return `${what} is ready and saved in the Library (item #${j.libraryId}). It is a new version; the original is kept.`;
  if (j.status === 'cancelled') return 'Stopped; nothing was saved.';
  if (j.status === 'failed') throw new ToolError(j.error ?? 'ComfyUI failed.');
  return `${what} is still being made in ComfyUI. It will be in the Library under Pictures and video when it is done (they can watch its progress or cancel it there).`;
}

export function createMediaTools(getApp: () => AppContext): Tool[] {
  const studio = () => mediaFor(getApp());
  const on = () => {
    const app = getApp();
    const s = studio();
    return Boolean(s && !app.member?.child?.() && s.ready());
  };
  return [
    {
      spec: {
        name: 'picture_edit',
        description:
          'Edit a picture from the Library with ComfyUI on this computer; the result is a new Library item (the original is kept). what: remove (erase something: give the region it is in), replace (paint something else into a region; say what in instruction), extend (outpaint: give side), upscale (size 2x, 4x or 4k), remove_background, restyle (img2img: instruction = the new style, strength 0.1 slight to 0.9 nearly new). For a precise area, tell them to open the picture in the Library and paint over it with Edit picture. Never sexual or nude edits of a photo; never anything involving minors.',
        parameters: {
          type: 'object',
          properties: {
            picture: { type: 'number', description: 'The Library item id of the picture; leave out for the newest picture.' },
            what: { type: 'string', enum: Object.keys(WHAT) },
            instruction: { type: 'string', description: 'What to remove / paint / the new style, in their words.' },
            region: { type: 'string', enum: [...REGIONS], description: 'remove/replace: where in the picture.' },
            side: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'all'], description: 'extend: which side.' },
            size: { type: 'string', enum: ['2x', '4x', '4k'], description: 'upscale: how big.' },
            strength: { type: 'number', description: 'restyle: 0.1-0.9.' },
          },
          required: ['what'],
        },
      },
      defaultPermission: 'ask',
      isAvailable: on,
      summarize: (a) => `Edit picture ${a.picture ? `#${String(a.picture)}` : '(the newest)'}: ${String(a.what)}${a.instruction ? ` (${String(a.instruction).slice(0, 80)})` : ''}`,
      async run(args, ctx) {
        const app = getApp();
        const s = studio();
        if (!s) throw new ToolError('Picture editing is the owner’s.');
        const op = WHAT[String(args.what)];
        if (!op) throw new ToolError(`what must be one of: ${Object.keys(WHAT).join(', ')}.`);
        const id = Number(args.picture) || newestPicture(app);
        if (!id) throw new ToolError('There is no picture in the Library yet: ask them to add one (Library → Add) first.');
        const doc = app.library?.get(id);
        const bytes = doc ? app.library!.file(doc) : undefined;
        const pic = bytes ? measure(bytes) : undefined;
        if (!pic) throw new ToolError(`There is no picture #${id} in the Library.`);
        const region = (REGIONS as readonly string[]).includes(String(args.region)) ? (args.region as Region) : 'center';
        const instruction = String(args.instruction ?? '').slice(0, 500);
        const prompt = op === 'inpaint' && args.what === 'remove' ? `remove ${instruction}` : instruction;
        const side = String(args.side ?? 'right');
        const px = 256;
        const pad = op === 'outpaint' ? { left: side === 'left' || side === 'all' ? px : 0, right: side === 'right' || side === 'all' ? px : 0, top: side === 'top' || side === 'all' ? px : 0, bottom: side === 'bottom' || side === 'all' ? px : 0 } : undefined;
        const job = await s.startEdit({ libraryId: id, op, prompt, strength: args.strength === undefined ? undefined : Number(args.strength), mask: op === 'inpaint' ? regionMask(pic.width, pic.height, region) : undefined, pad, scale: (['2x', '4x', '4k'] as const).find((x) => x === args.size), conversationId: ctx.conversationId });
        const j = await s.wait(job.id, 5 * 60_000, ctx.signal);
        const text = ended(j, 'The edited picture');
        if (j.status === 'done' && ctx.saveImage && ctx.attachImage) {
          const out = app.library?.get(j.libraryId!);
          const b = out ? app.library!.file(out) : undefined;
          if (b) ctx.attachImage(ctx.saveImage(b));
        }
        return op === 'inpaint' ? `${text} The area was a rough "${region}" region; for an exact area they can paint it in Library → the picture → Edit picture.` : text;
      },
    },
    {
      spec: {
        name: 'video_make',
        description:
          'Make a short video clip (2-5 seconds) with ComfyUI on this computer, from words or from a Library picture (image-to-video), only with video models already installed. Saved to the Library. It can take minutes; they can watch progress or cancel in Library → Pictures and video. Explicit only when adult mode is on, never from a real photo, never anything involving minors.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What the clip shows: subject, motion, camera, setting.' },
            picture: { type: 'number', description: 'A Library picture id to start from (image-to-video).' },
            seconds: { type: 'number', enum: [2, 3, 5] },
          },
          required: ['prompt'],
        },
      },
      defaultPermission: 'ask',
      isAvailable: on,
      summarize: (a) => `Make a short video: ${String(a.prompt ?? '').slice(0, 100)}`,
      async run(args, ctx) {
        const s = studio();
        if (!s) throw new ToolError('Video is the owner’s.');
        const job = await s.startVideo({ prompt: String(args.prompt ?? ''), libraryId: args.picture === undefined || args.picture === null ? undefined : Number(args.picture), seconds: Number(args.seconds) || undefined, conversationId: ctx.conversationId });
        const j = await s.wait(job.id, 4 * 60_000, ctx.signal);
        return ended(j, 'The clip');
      },
    },
  ];
}
