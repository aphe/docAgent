import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

export interface CorpusReport {
  root: string;
  totalFiles: number;
  byExtension: Record<string, number>;
  totalBytes: number;
  pdfSampled: number;
  noTextLayerPdfs: number;
  noTextLayerShare: number;
  avgPagesPerPdf: number;
}

const NO_TEXT_LAYER_CHAR_THRESHOLD = 20;
const DEFAULT_SAMPLE_LIMIT = 50;

/**
 * Measure a document corpus without parsing anything except the text layer of
 * sampled PDFs. Hidden files and hidden directories are skipped. The report is
 * counts only: no OCR estimate and no gating decision.
 */
export async function measureCorpus(
  root: string,
  opts: { sampleLimit?: number } = {},
): Promise<CorpusReport> {
  const sampleLimit = Math.max(0, opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT);
  const absoluteRoot = resolve(root);

  const files = await collectFiles(absoluteRoot);

  const byExtension: Record<string, number> = {};
  let totalBytes = 0;
  const pdfFiles: string[] = [];

  for (const file of files) {
    const info = await stat(file);
    totalBytes += info.size;
    const ext = extname(file).toLowerCase();
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    if (ext === ".pdf") pdfFiles.push(file);
  }

  const sample = pdfFiles.slice(0, sampleLimit);
  let totalPages = 0;
  let noTextLayerPdfs = 0;

  for (const file of sample) {
    let doc: PDFDocumentProxy | undefined;
    try {
      const data = new Uint8Array(await readFile(file));
      doc = await getDocument({
        data,
        verbosity: 0,
        isEvalSupported: false,
      }).promise;

      totalPages += doc.numPages;

      let nonWhitespaceChars = 0;
      for (
        let pageNumber = 1;
        pageNumber <= doc.numPages &&
        nonWhitespaceChars < NO_TEXT_LAYER_CHAR_THRESHOLD;
        pageNumber++
      ) {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        for (const item of content.items) {
          if ("str" in item && typeof item.str === "string") {
            nonWhitespaceChars += item.str.replace(/\s/g, "").length;
          }
        }
        page.cleanup();
      }

      if (nonWhitespaceChars < NO_TEXT_LAYER_CHAR_THRESHOLD) {
        noTextLayerPdfs++;
      }
    } catch {
      // A PDF we cannot open (for example one that requires a user password)
      // cannot yield a text layer either. Count it as no-text-layer so the
      // share reflects PDFs we cannot index as text. The report has no separate
      // unreadable counter.
      noTextLayerPdfs++;
    } finally {
      await doc?.destroy().catch(() => {});
    }
  }

  return {
    root: absoluteRoot,
    totalFiles: files.length,
    byExtension,
    totalBytes,
    pdfSampled: sample.length,
    noTextLayerPdfs,
    noTextLayerShare: sample.length === 0 ? 0 : noTextLayerPdfs / sample.length,
    avgPagesPerPdf: sample.length === 0 ? 0 : totalPages / sample.length,
  };
}

/**
 * Recursively collect file paths under `dir`, skipping hidden entries (names
 * starting with ".") and symlinks. Entries are sorted by name so the sample is
 * deterministic across runs and platforms.
 */
async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}
