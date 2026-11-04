import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Client } from "@libsql/client";
import { type Chunk, chunkDoc } from "./chunk.js";
import { rootId as computeRootId } from "./config.js";
import { extractDates } from "./dates.js";
import { type DocRow, matchFiles, type ScannedFile } from "./identity.js";
import type { ParsedDoc } from "./parse/index.js";
import { type DocDates, deriveSupersession } from "./supersession.js";
import type { VectorStore } from "./vector-store.js";
import { type ApplyPlan, applyRun } from "./write.js";

/** Character window used when the caller does not override it. */
export const DEFAULT_CHUNK_MAX_CHARS = 1000;

/** Counts of one indexing run. `unparsable` is a date-derived status count. */
export interface RunSummary {
  runId: string;
  added: number;
  newVersion: number;
  moved: number;
  pruned: number;
  duplicates: number;
  unparsable: number;
  noTextLayerPdfs: number;
  skippedNonPdf: number;
}

export interface ScanResult {
  files: ScannedFile[];
  skippedNonPdf: number;
}

/**
 * I/O boundary of one indexing run. The CLI wires the real implementations;
 * tests replace the parsers, embedder, database and vector store so no
 * network call is made and no file outside the test root is touched.
 */
export interface IndexDeps {
  db: Client;
  store: VectorStore;
  scan(root: string): Promise<ScanResult>;
  parse(absPath: string, minTextChars: number): Promise<ParsedDoc>;
  embed(texts: string[], key: string): Promise<number[][]>;
  minTextChars: number;
  chunkMaxChars: number;
  openrouterKey: string;
}

interface StoredDocRow extends DocRow {
  topic_key: string;
  document_number: string | null;
  issued_date: string | null;
  effective_date: string | null;
  raw_date_strings: string | null;
  status: string;
}

interface PreparedDoc {
  parsed: ParsedDoc;
  dates: DocDates;
  chunks: Chunk[];
}

/**
 * Recursively scans `root` for PDFs. Hidden files and directories are skipped.
 * `path` is relative to the root with forward slashes; `versionKey` and
 * `sha256` are both the hex sha256 of the file bytes (spec decision 5: the
 * version key is the content hash). Non-PDF files are counted, never parsed.
 */
export async function scanPdfFiles(root: string): Promise<ScanResult> {
  const absoluteRoot = resolve(root);
  const files: ScannedFile[] = [];
  let skippedNonPdf = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extname(entry.name).toLowerCase() !== ".pdf") {
        skippedNonPdf++;
        continue;
      }
      const bytes = await readFile(fullPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      files.push({
        path: relative(absoluteRoot, fullPath).split(sep).join("/"),
        versionKey: digest,
        sha256: digest,
      });
    }
  }

  await walk(absoluteRoot);
  return { files, skippedNonPdf };
}

function topicKeyFor(relativePath: string): string {
  const dir = dirname(relativePath);
  return dir === "." ? "" : dir;
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

async function readStoredRows(
  db: Client,
  rootId: string,
): Promise<StoredDocRow[]> {
  const result = await db.execute({
    sql: `SELECT doc_id, root_id, path, topic_key, version_key, document_number,
                 issued_date, effective_date, raw_date_strings, status
          FROM documents
          WHERE root_id = ?`,
    args: [rootId],
  });

  return result.rows.map((row) => ({
    doc_id: String(row.doc_id),
    root_id: String(row.root_id),
    path: String(row.path),
    topic_key: String(row.topic_key),
    version_key: String(row.version_key),
    document_number: stringOrNull(row.document_number),
    issued_date: stringOrNull(row.issued_date),
    effective_date: stringOrNull(row.effective_date),
    raw_date_strings: stringOrNull(row.raw_date_strings),
    status: String(row.status),
  }));
}

function freshDates(
  docId: string,
  relativePath: string,
  parsed: ParsedDoc,
): DocDates {
  const text = parsed.pages.map((page) => page.text).join("\n");
  const extracted = extractDates(text, basename(relativePath));
  return {
    docId,
    topicKey: topicKeyFor(relativePath),
    ...(extracted.issued === undefined ? {} : { issued: extracted.issued }),
    ...(extracted.effective === undefined
      ? {}
      : { effective: extracted.effective }),
    ...(extracted.issuedSource === undefined
      ? {}
      : { issuedSource: extracted.issuedSource }),
    raw: extracted.raw,
    isLampiran: extracted.isLampiran,
  };
}

function parseRawDates(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/**
 * Rebuilds the date metadata of an unchanged or moved row. An undated row and
 * a previously unparsable row that carries dates (i.e. a lampiran) keep their
 * status, because the database does not store `isLampiran` separately.
 */
function storedDates(row: StoredDocRow, topicKey: string): DocDates {
  const issued = row.issued_date ?? undefined;
  const effective = row.effective_date ?? undefined;
  return {
    docId: row.doc_id,
    topicKey,
    ...(row.document_number === null
      ? {}
      : { documentNumber: row.document_number }),
    ...(issued === undefined ? {} : { issued }),
    ...(effective === undefined ? {} : { effective }),
    raw: parseRawDates(row.raw_date_strings),
    isLampiran:
      row.status === "unparsable" &&
      (issued !== undefined || effective !== undefined),
  };
}

async function prepareDoc(
  deps: IndexDeps,
  rootPath: string,
  docId: string,
  file: ScannedFile,
): Promise<PreparedDoc> {
  const parsed = await deps.parse(
    join(rootPath, file.path),
    deps.minTextChars,
  );
  return {
    parsed,
    dates: freshDates(docId, file.path, parsed),
    chunks: chunkDoc(docId, parsed, { maxChars: deps.chunkMaxChars }),
  };
}

async function embedChunks(
  deps: IndexDeps,
  chunksByDoc: Map<string, Chunk[]>,
): Promise<Map<string, number[]>> {
  const chunks: Chunk[] = [];
  for (const docChunks of chunksByDoc.values()) chunks.push(...docChunks);
  if (chunks.length === 0) return new Map();

  const values = await deps.embed(
    chunks.map((chunk) => chunk.text),
    deps.openrouterKey,
  );
  if (values.length !== chunks.length) {
    throw new Error(
      `embedding returned ${values.length} vectors for ${chunks.length} chunks`,
    );
  }

  const vectors = new Map<string, number[]>();
  chunks.forEach((chunk, index) => vectors.set(chunk.chunkId, values[index]));
  return vectors;
}

/**
 * Runs one indexing pass over `root`.
 *
 * Order: scan -> match against stored rows -> parse, chunk and extract dates
 * for added and new-version files -> embed (real runs only) -> derive
 * supersession over every document of this root -> apply the run.
 *
 * A dry run performs the scan, matching and parsing so the counts are real,
 * then stops before embedding and before any database or vector-store write.
 */
export async function runIndex(opts: {
  root: string;
  dryRun: boolean;
  deps: IndexDeps;
}): Promise<RunSummary> {
  const { root, dryRun, deps } = opts;
  if (!Number.isFinite(deps.chunkMaxChars) || deps.chunkMaxChars <= 0) {
    throw new Error("chunkMaxChars must be a positive number");
  }

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const rootPath = resolve(root);
  const rootId = computeRootId(rootPath);

  const scan = await deps.scan(rootPath);
  const stored = await readStoredRows(deps.db, rootId);
  const plan = matchFiles(stored, scan.files, rootId);

  const added: ApplyPlan["added"] = [];
  const newVersion: ApplyPlan["newVersion"] = [];
  const chunksByDoc = new Map<string, Chunk[]>();
  const docDates: DocDates[] = [];
  let noTextLayerPdfs = 0;

  const record = (prepared: PreparedDoc): void => {
    docDates.push(prepared.dates);
    chunksByDoc.set(prepared.dates.docId, prepared.chunks);
    if (prepared.parsed.reason === "no-text-layer") noTextLayerPdfs++;
  };

  for (const entry of plan.added) {
    const docId = randomUUID();
    const prepared = await prepareDoc(deps, rootPath, docId, entry.file);
    added.push({ ...entry, docId, parsed: prepared.parsed, dates: prepared.dates });
    record(prepared);
  }

  for (const entry of plan.newVersion) {
    const prepared = await prepareDoc(
      deps,
      rootPath,
      entry.docId,
      entry.file,
    );
    newVersion.push({
      docId: entry.docId,
      file: entry.file,
      parsed: prepared.parsed,
      dates: prepared.dates,
    });
    record(prepared);
  }

  const rowByDocId = new Map(stored.map((row) => [row.doc_id, row]));
  for (const docId of plan.unchanged) {
    const row = rowByDocId.get(docId);
    if (row) docDates.push(storedDates(row, row.topic_key));
  }
  for (const entry of plan.moved) {
    const row = rowByDocId.get(entry.docId);
    if (row) docDates.push(storedDates(row, topicKeyFor(entry.file.path)));
  }

  const vectors = dryRun
    ? new Map<string, number[]>()
    : await embedChunks(deps, chunksByDoc);
  const supersession = deriveSupersession(docDates);
  const unparsable = Object.values(supersession.byDoc).filter(
    (status) => status.status === "unparsable",
  ).length;

  const summary: RunSummary = {
    runId,
    added: added.length,
    newVersion: newVersion.length,
    moved: plan.moved.length,
    pruned: plan.pruned.length,
    duplicates: added.filter((entry) => entry.isDuplicate).length,
    unparsable,
    noTextLayerPdfs,
    skippedNonPdf: scan.skippedNonPdf,
  };

  if (dryRun) return summary;

  await applyRun(
    deps.db,
    deps.store,
    { unchanged: plan.unchanged, newVersion, moved: plan.moved, added, pruned: plan.pruned },
    chunksByDoc,
    vectors,
    supersession,
    runId,
    rootId,
    rootPath,
    startedAt,
  );

  return summary;
}
