// EC22: server-sent events from a fetch body (no EventSource: it can't POST or send a token).

/** Each `data:` block of an event stream as parsed JSON (`[DONE]` and comments are skipped). */
export async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = function* (block: string): Generator<unknown> {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') return;
    try {
      yield JSON.parse(data);
    } catch {
      /* not JSON: skipped */
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(buf.slice(i).match(/^\r?\n\r?\n/)![0].length + i);
        yield* flush(block);
      }
    }
    buf += dec.decode();
    if (buf.trim()) yield* flush(buf);
  } finally {
    reader.releaseLock();
  }
}
