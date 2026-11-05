import type { Client } from "@libsql/client";
import { type Hit, type HitStatus, hybridSearch, type StatusConfidence } from "./search";

export interface Citation {
  chunkId: string;
  docId: string;
  path: string;
  page: number;
  charStart: number;
  charEnd: number;
  status: HitStatus;
  statusConfidence: StatusConfidence;
  stale: boolean;
}

export interface AlternateDoc {
  docId: string;
  path: string;
}

export interface AnswerResponse {
  text: string;
  citations: Citation[];
  alternates: AlternateDoc[];
  warnings: string[];
  draft?: string;
}

export interface AnswerDeps {
  /** Injected embedding function; see `hybridSearch`. */
  embed?: (texts: string[], key: string) => Promise<number[][]>;
  /** OpenRouter key for embeddings. Defaults to `OPENROUTER_API_KEY`. */
  key?: string;
}

const NO_SOURCE_TEXT = "Sumber tidak ditemukan untuk pertanyaan ini.";
const TOP_K = 8;
/** Number of top-ranked chunks quoted verbatim in an answer. */
const ANSWER_HITS = 3;

async function documentPaths(
  db: Client,
  docIds: string[],
): Promise<Map<string, string>> {
  if (docIds.length === 0) return new Map();
  const placeholders = docIds.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT doc_id, path FROM documents WHERE doc_id IN (${placeholders})`,
    args: docIds,
  });
  const paths = new Map<string, string>();
  for (const row of result.rows) {
    paths.set(String(row.doc_id), String(row.path));
  }
  return paths;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toCitations(hits: Hit[], paths: Map<string, string>): Citation[] {
  return hits.map((hit) => ({
    chunkId: hit.chunkId,
    docId: hit.docId,
    path: paths.get(hit.docId) ?? "",
    page: hit.page,
    charStart: hit.charStart,
    charEnd: hit.charEnd,
    status: hit.status,
    statusConfidence: hit.statusConfidence,
    stale: hit.stale,
  }));
}

function buildWarnings(
  alternates: AlternateDoc[],
  paths: Map<string, string>,
  citedHits: Hit[],
): string[] {
  const warnings: string[] = [];
  const pathOf = (hit: Hit): string => paths.get(hit.docId) ?? hit.docId;
  const stemOf = (hit: Hit): string => pathOf(hit).replace(/\.pdf$/i, "");

  const staleStems = unique(citedHits.filter((hit) => hit.stale).map(stemOf));
  for (const stem of staleStems) {
    warnings.push(`${stem} — stale citation, document changed since indexing`);
  }

  const lowConfidenceStems = unique(
    citedHits.filter((hit) => hit.statusConfidence === "low").map(stemOf),
  );
  for (const stem of lowConfidenceStems) {
    warnings.push(`${stem} — low status confidence`);
  }

  const inactiveStems = unique(
    citedHits
      .filter((hit) => hit.status === "superseded" || hit.status === "unparsable")
      .map(stemOf),
  );
  for (const stem of inactiveStems) {
    warnings.push(`${stem} — cited, not active`);
  }

  for (const alternate of alternates) {
    const stem = (alternate.path || alternate.docId).replace(/\.pdf$/i, "");
    warnings.push(`${stem} — alternate, check needed`);
  }

  return warnings;
}

export interface SearchStepResult {
  hits: Hit[];
  warnings: string[];
}

/** Retrieval step: hybrid search. */
export async function searchStep(
  db: Client,
  query: string,
  deps: AnswerDeps = {},
): Promise<SearchStepResult> {
  const warnings: string[] = [];
  const hits = await hybridSearch(db, query, {
    topK: TOP_K,
    ...(deps.embed === undefined ? {} : { embed: deps.embed }),
    ...(deps.key === undefined ? {} : { key: deps.key }),
    warnings,
  });
  return { hits, warnings };
}

/**
 * Builds the reply from retrieved chunk text only. No LLM generates any text.
 * The top `ANSWER_HITS` chunks are quoted verbatim, each followed by its
 * `[chunkId]`. Citations are exactly the quoted chunks. Draft mode returns the
 * same quoted excerpts in `draft`; it does not rewrite them, and it never
 * writes anywhere.
 */
export async function answerFromHits(
  db: Client,
  mode: "answer" | "draft",
  search: SearchStepResult,
): Promise<AnswerResponse> {
  const { hits, warnings: searchWarnings } = search;

  if (hits.length === 0) {
    return {
      text: NO_SOURCE_TEXT,
      citations: [],
      alternates: [],
      warnings: searchWarnings,
    };
  }

  const citedHits = hits.slice(0, ANSWER_HITS);
  const alternateIds = unique(citedHits.flatMap((hit) => hit.alternates)).slice(0, ANSWER_HITS);
  const paths = await documentPaths(
    db,
    unique([...hits.map((hit) => hit.docId), ...alternateIds]),
  );
  const alternates: AlternateDoc[] = alternateIds.map((docId) => ({
    docId,
    path: paths.get(docId) ?? "",
  }));

  const text = citedHits
    .map((hit) => `${hit.text} [${hit.chunkId}]`)
    .join("\n\n");
  const citations = toCitations(citedHits, paths);
  const warnings = [
    ...searchWarnings,
    ...buildWarnings(alternates, paths, citedHits),
  ];

  if (mode === "draft") {
    return { text, citations, alternates, warnings, draft: text };
  }
  return { text, citations, alternates, warnings };
}

/** One-shot pipeline used by `/query`: search, then answer. */
export async function answer(
  db: Client,
  query: string,
  mode: "answer" | "draft",
  deps: AnswerDeps = {},
): Promise<AnswerResponse> {
  return answerFromHits(db, mode, await searchStep(db, query, deps));
}
