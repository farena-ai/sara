import { plugin as sdkPlugin } from './sara-plugin.mjs';
import { initLocale, readyDescription, nativeCard, localizedError } from './locale.mjs';
// Use the current SDK init lifecycle: descriptions are localized BEFORE ready is emitted.
export function plugin(def) {
  for (const t of def.tools ?? []) {
    const run = t.run;
    t.run = async (args, sara) => {
      let out;
      try { out = await run(args, sara); } catch (error) { throw localizedError(error); }
      // Return presentation with the tool result so the host attaches it to this invocation.
      return { ...(typeof out === 'string' ? { content: out } : out), card: nativeCard() };
    };
  }
  const init = def.init;
  return sdkPlugin({ ...def, init: async sara => {
    initLocale(sara.lang);
    for (const t of def.tools ?? []) t.description = readyDescription(t.description);
    await init?.(sara);
  } });
}
