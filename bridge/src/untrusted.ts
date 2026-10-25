// Text an agent wrote reaches the delegating model only inside this fence, cut to the event-text
// limit, so that it reads as data and not as an instruction (BUILD.md §15.3). The fence markers
// themselves are removed from the text, so the last marker line is always the bridge's own.
import { clipText } from "./limits.ts";

export const OPEN = "<<untrusted agent output>>";
export const CLOSE = "<<end untrusted agent output>>";

export interface Untrusted {
  untrusted: true;
  text: string;
}

const MARKER = /<<\s*(end\s+)?untrusted\s+agent\s+output\s*>>/gi;

export function fence(text: string): Untrusted {
  const clipped = clipText(text.replace(MARKER, "[marker removed]"));
  return { untrusted: true, text: `${OPEN}\n${clipped.text}\n${CLOSE}` };
}
