import { extname } from "node:path";
import { loadConfig } from "../config.js";
import {
  type ParsedDoc,
  type ParsedPage,
  type ReadErrorReason,
  parsePdfFile,
} from "./pdf.js";

export type { ParsedDoc, ParsedPage, ReadErrorReason };

export class UnsupportedFormatError extends Error {
  constructor(absPath: string) {
    super(`Unsupported file format (expected .pdf): ${absPath}`);
    this.name = "UnsupportedFormatError";
  }
}

/**
 * Parses one document. Only `.pdf` is supported; the scanner filters other
 * extensions out before this point, so a non-PDF path is a guard violation.
 * The parser returns data only and never writes to the database or the source
 * file.
 *
 * The no-text-layer threshold comes from the indexer configuration (default
 * 20 non-whitespace characters), not from a parser-local constant. Callers
 * such as the indexing pipeline should pass `config.minTextChars`; the
 * fallback keeps direct calls and tests honest to the same source.
 */
export async function parseFile(
  absPath: string,
  minTextChars: number = loadConfig(["index", process.cwd()], process.env)
    .minTextChars,
): Promise<ParsedDoc> {
  if (extname(absPath).toLowerCase() !== ".pdf") {
    throw new UnsupportedFormatError(absPath);
  }
  return parsePdfFile(absPath, minTextChars);
}
