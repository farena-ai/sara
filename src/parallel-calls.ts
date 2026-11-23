// Y6: run several tool calls of one step at the same time. A step where the model asks for three
// pages, or a file and a search, used to run them one after another; each waited on the network or
// the disk in turn. Only calls that just read are run together (PARALLEL_READS), and only when every
// call of the step is one: anything that changes something, asks for approval by nature or drives a
// computer still runs alone, in the order the model wrote it.
//
// Each call keeps its own checks (permission, the loop guard, admission); the events of the calls are
// passed on as they come, and the results are returned in the order of the calls.

/** Tools that only read and are safe to run beside each other in one step. */
export const PARALLEL_READS: ReadonlySet<string> = new Set([
  'web_fetch', 'web_search',
  'read_file', 'list_dir', 'search',
  'recall', 'memory_search', 'search_conversations',
  'weather', 'get_time',
]);

/** At most this many run at once (the rest of the step's calls start as these finish). */
export const PARALLEL_MAX = 4;

/** True when this step's calls may run together: more than one, and every one a read. */
export function runsTogether(calls: readonly { name: string }[]): boolean {
  return calls.length > 1 && calls.every((c) => PARALLEL_READS.has(c.name));
}

/**
 * Drives several generators at once: yields what any of them yields, as it comes, and returns their
 * return values in the order they were given. `start(i)` makes the i-th generator when its turn comes
 * (at most `max` run at a time). If one throws, the others are closed and the error is passed on; if
 * the caller stops early, all are closed.
 */
export async function* runTogether<E, R>(count: number, start: (i: number) => AsyncGenerator<E, R>, max: number = PARALLEL_MAX): AsyncGenerator<E, R[]> {
  const results: R[] = new Array(count);
  const gens = new Map<number, AsyncGenerator<E, R>>();
  const waiting = new Map<number, Promise<{ i: number; r: IteratorResult<E, R> }>>();
  let next = 0;
  const pull = (i: number) => waiting.set(i, gens.get(i)!.next().then((r) => ({ i, r })));
  const fill = () => {
    while (next < count && gens.size < Math.max(1, max)) {
      const i = next++;
      gens.set(i, start(i));
      pull(i);
    }
  };
  try {
    fill();
    while (waiting.size) {
      const { i, r } = await Promise.race(waiting.values());
      if (r.done) {
        results[i] = r.value;
        waiting.delete(i);
        gens.delete(i);
        fill();
      } else {
        // Ask this one for its next event before handing this event on, so it keeps working meanwhile.
        pull(i);
        yield r.value;
      }
    }
    return results;
  } finally {
    // An error or an early stop: nothing is left running behind the caller's back.
    for (const [i, g] of gens) {
      waiting.get(i)?.catch(() => undefined);
      void g.return(undefined as never).catch(() => undefined);
    }
  }
}
