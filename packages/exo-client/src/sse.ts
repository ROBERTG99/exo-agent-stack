export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Parses a text/event-stream body into frames. Comments (": ...") and data-less frames are dropped. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SseFrame | null => {
    const frame = data.length > 0 ? { id, event, data: data.join("\n") } : null;
    id = undefined;
    event = undefined;
    data = [];
    return frame;
  };

  const handleLine = (line: string): SseFrame | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "event") event = value;
    return null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(buffer.startsWith("\r\n", nl) ? nl + 2 : nl + 1);
        const frame = handleLine(line);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
