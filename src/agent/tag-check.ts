/**
 * Compares the `[label]` markers in a polished agent reply with the cited
 * labels (`file, p. N`). Only the file part is compared: the model may repeat
 * or drop page numbers, which would make an exact-label check fire on nearly
 * every turn. A mismatch means the model dropped or invented a file (decision 26).
 *
 * `skipped` means no answer tool ran this turn and the reply has no tags, so
 * there is nothing to compare. A reply with tags but no cited set is a
 * `mismatch`: every tag is invented.
 */
export interface TagCheck {
  status: "ok" | "mismatch" | "skipped";
  missing: string[];
  extra: string[];
}

const TAG = /\[([^\[\]]+)\]/g;

export function checkPolishedTags(text: string, citedLabels: string[]): TagCheck {
  const fileOf = (label: string) => label.replace(/, p\. \d+$/, "").trim();
  const found = new Set([...text.matchAll(TAG)].map((m) => fileOf(m[1])));
  const cited = new Set(citedLabels.map(fileOf));
  const missing = [...cited].filter((file) => !found.has(file)).sort();
  const extra = [...found].filter((file) => !cited.has(file)).sort();
  if (cited.size === 0 && found.size === 0) return { status: "skipped", missing, extra };
  return { status: missing.length === 0 && extra.length === 0 ? "ok" : "mismatch", missing, extra };
}
