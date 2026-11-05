import { readFile } from "node:fs/promises";
import {
  getDocument,
  PermissionFlag,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

export type ReadErrorReason =
  | "copy-restricted"
  | "no-text-layer"
  | "parse-failed";

export interface ParsedPage {
  page: number;
  text: string;
}

export interface ParsedDoc {
  pages: ParsedPage[];
  unreadable: boolean;
  reason?: ReadErrorReason;
}

const COPY_PERMISSION = PermissionFlag.COPY;

/**
 * Extracts the text layer of a PDF page by page. The source file is opened
 * read-only and never written, so signed PDFs stay intact.
 *
 * - Copy-restricted PDFs return no text: the copy permission flag is cleared.
 *   pdfjs does not fail on them, so the permission is checked explicitly.
 * - A document whose text layer holds fewer than `minTextChars` non-whitespace
 *   characters is flagged no-text-layer; its pages are kept so page numbers
 *   survive, but they carry no usable text.
 * - Unreadable or corrupt files are flagged parse-failed and the path is
 *   logged to stderr; errors are never swallowed silently.
 */
export async function parsePdfFile(
  absPath: string,
  minTextChars: number,
): Promise<ParsedDoc> {
  let doc: PDFDocumentProxy | null = null;
  try {
    const data = new Uint8Array(await readFile(absPath));
    doc = await getDocument({
      data,
      verbosity: 0,
      isEvalSupported: false,
    }).promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pdf parse-failed: ${absPath}: ${message}`);
    return { pages: [], unreadable: true, reason: "parse-failed" };
  }

  if (doc === null) {
    return { pages: [], unreadable: true, reason: "parse-failed" };
  }

  try {
    const permissions = await doc.getPermissions();
    if (permissions !== null && !permissions.includes(COPY_PERMISSION)) {
      return { pages: [], unreadable: true, reason: "copy-restricted" };
    }

    const pages: ParsedPage[] = [];
    let nonWhitespaceChars = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item && typeof item.str === "string" ? item.str : "",
        )
        .join(" ");
      pages.push({ page: pageNumber, text });
      nonWhitespaceChars += text.replace(/\s/g, "").length;
      page.cleanup();
    }

    if (nonWhitespaceChars < minTextChars) {
      return { pages, unreadable: true, reason: "no-text-layer" };
    }

    return { pages, unreadable: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pdf parse-failed: ${absPath}: ${message}`);
    return { pages: [], unreadable: true, reason: "parse-failed" };
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}
