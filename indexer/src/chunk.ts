import type { ParsedDoc } from "./parse/index.js";

export interface Chunk {
  chunkId: string;
  docId: string;
  page: number;
  idx: number;
  charStart: number;
  charEnd: number;
  text: string;
}

export function chunkDoc(
  docId: string,
  doc: ParsedDoc,
  opts: { maxChars: number },
): Chunk[] {
  if (doc.unreadable) return [];

  const chunks: Chunk[] = [];
  for (const page of doc.pages) {
    const text = page.text;
    if (text.length === 0) continue;

    let idx = 0;
    for (let i = 0; i < text.length; i += opts.maxChars) {
      const charStart = i;
      const charEnd = Math.min(i + opts.maxChars, text.length);
      chunks.push({
        chunkId: `${docId}:${page.page}:${idx}`,
        docId,
        page: page.page,
        idx,
        charStart,
        charEnd,
        text: text.slice(charStart, charEnd),
      });
      idx++;
    }
  }
  return chunks;
}
