// Minimal Server-Sent Events parser for streaming model responses.

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* sseEvents(body: ReadableStream<Uint8Array>, maxBytes?: number): AsyncGenerator<SseEvent> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error('Invalid stream byte bound.');
  let bytes = 0;
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];

  function* takeLines(): Generator<SseEvent> {
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') };
        event = undefined;
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
  }

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    // Throwing from this for-await also returns/cancels the stream reader.
    if (maxBytes !== undefined && bytes > maxBytes) throw new Error('Model stream exceeded its byte bound.');
    buf += decoder.decode(chunk, { stream: true });
    yield* takeLines();
  }
  buf += decoder.decode();
  if (buf.length) {
    buf += '\n';
    yield* takeLines();
  }
  if (data.length) yield { event, data: data.join('\n') };
}
