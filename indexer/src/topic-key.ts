import { basename } from "node:path";

/**
 * Division, type and filler tokens removed before comparing titles. These
 * codes vary between copies of the same SOP (e.g. `RKI-P-OPR-010` vs
 * `RKI-OPR-026`), so they must not split a topic.
 */
const DROP_TOKENS = new Set([
  "rki",
  "rko",
  "p",
  "k",
  "opr",
  "adi",
  "iti",
  "its",
  "cam",
  "sop",
]);

/**
 * Topic key for supersession grouping: a normalized title taken from the
 * filename. Strips the extension, the leading YYYYMMDD date, version tokens,
 * document-number parts and the word SOP, then lowercases and removes
 * punctuation. Copies of one SOP in different folders share a key.
 */
export function topicKeyFor(relativePath: string): string {
  const name = basename(relativePath)
    .replace(/\.docx\.pdf$/i, "")
    .replace(/\.pdf$/i, "")
    .replace(/^\d{8}/, "");
  const normalized = name
    .replace(/[_\-,&]+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .toLowerCase();
  const tokens = normalized
    .split(/\s+/)
    .filter(
      (token) =>
        token !== "" &&
        !DROP_TOKENS.has(token) &&
        !/^v\d+$/.test(token) &&
        !/^\d{2,3}$/.test(token),
    );
  return tokens.length > 0 ? tokens.join(" ") : normalized.trim();
}
