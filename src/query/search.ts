import type { Client } from "@libsql/client";
import { embedTexts as defaultEmbedTexts } from "../../indexer/src/embed";

export type HitStatus = "active" | "superseded" | "unparsable";
export type StatusConfidence = "high" | "low";

export interface Hit {
  chunkId: string;
  docId: string;
  page: number;
  charStart: number;
  charEnd: number;
  text: string;
  score: number;
  status: HitStatus;
  statusConfidence: StatusConfidence;
  alternates: string[];
  stale: boolean;
}

export type EmbedTexts = (texts: string[], key: string) => Promise<number[][]>;

export interface SearchDeps {
  /**
   * Injected embedding function. Tests and callers that must not reach
   * OpenRouter supply a stub here. When omitted and `key` is empty, the
   * vector leg is skipped and the search degrades to FTS5 only.
   */
  embed?: EmbedTexts;
  key?: string;
}

/** Reciprocal rank fusion constant from the common RRF recipe. */
const RRF_K = 60;

interface ChunkRow {
  chunk_id: string;
  doc_id: string;
  page: number;
  char_start: number;
  char_end: number;
  text: string;
  chunk_version_key: string;
  doc_status: string;
  doc_status_confidence: string;
  doc_alternate_candidates: string | null;
  doc_version_key: string;
  doc_read_error: string | null;
}

/**
 * Turns a user query into an FTS5 MATCH expression. Tokens are lowercased,
 * deduplicated and quoted; tokens are OR-ed so partial matches still count.
 * An empty token list yields an empty expression and the FTS leg is skipped.
 */
function toFtsQuery(query: string): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = Array.from(new Set(tokens)).slice(0, 24);
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

function parseAlternates(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

async function keywordHits(
  db: Client,
  query: string,
  limit: number,
): Promise<string[]> {
  const match = toFtsQuery(query);
  if (match === "" || limit <= 0) return [];
  const result = await db.execute({
    sql: `SELECT chunk_id FROM chunks_fts
          WHERE chunks_fts MATCH ?
          ORDER BY bm25(chunks_fts)
          LIMIT ?`,
    args: [match, limit],
  });
  return result.rows.map((row) => String(row.chunk_id));
}

async function vectorHits(
  db: Client,
  vector: number[],
  limit: number,
): Promise<string[]> {
  if (limit <= 0) return [];
  const top = await db.execute({
    sql: "SELECT id FROM vector_top_k('chunk_vectors_idx', vector32(?), ?)",
    args: [JSON.stringify(vector), limit],
  });
  const rowIds = top.rows.map((row) => Number(row.id));
  if (rowIds.length === 0) return [];

  const placeholders = rowIds.map(() => "?").join(", ");
  const rows = await db.execute({
    sql: `SELECT rowid, chunk_id FROM chunk_vectors WHERE rowid IN (${placeholders})`,
    args: rowIds,
  });
  const byRowId = new Map<number, string>();
  for (const row of rows.rows) {
    byRowId.set(Number(row.rowid), String(row.chunk_id));
  }
  return rowIds
    .map((rowId) => byRowId.get(rowId))
    .filter((chunkId): chunkId is string => chunkId !== undefined);
}

async function queryVector(
  query: string,
  deps: SearchDeps,
): Promise<number[] | null> {
  const key = deps.key ?? process.env.OPENROUTER_API_KEY ?? "";
  const embed = deps.embed ?? defaultEmbedTexts;
  if (deps.embed === undefined && key.trim() === "") return null;
  const [vector] = await embed([query], key);
  return vector ?? null;
}

function fuse(rankedLists: string[][]): Array<{ chunkId: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((chunkId, index) => {
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  return Array.from(scores.entries())
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
}

async function loadChunkRows(
  db: Client,
  chunkIds: string[],
): Promise<Map<string, ChunkRow>> {
  if (chunkIds.length === 0) return new Map();
  const placeholders = chunkIds.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT c.chunk_id, c.doc_id, c.page, c.char_start, c.char_end, c.text,
                 c.version_key AS chunk_version_key,
                 d.status AS doc_status,
                 d.status_confidence AS doc_status_confidence,
                 d.alternate_candidates AS doc_alternate_candidates,
                 d.version_key AS doc_version_key,
                 d.read_error AS doc_read_error
          FROM chunks c
          JOIN documents d ON d.doc_id = c.doc_id
          WHERE c.chunk_id IN (${placeholders})`,
    args: chunkIds,
  });
  const byChunkId = new Map<string, ChunkRow>();
  for (const row of result.rows) {
    byChunkId.set(String(row.chunk_id), {
      chunk_id: String(row.chunk_id),
      doc_id: String(row.doc_id),
      page: Number(row.page),
      char_start: Number(row.char_start),
      char_end: Number(row.char_end),
      text: String(row.text),
      chunk_version_key: String(row.chunk_version_key),
      doc_status: String(row.doc_status),
      doc_status_confidence: String(row.doc_status_confidence),
      doc_alternate_candidates:
        row.doc_alternate_candidates === null
          ? null
          : String(row.doc_alternate_candidates),
      doc_version_key: String(row.doc_version_key),
      doc_read_error:
        row.doc_read_error === null ? null : String(row.doc_read_error),
    });
  }
  return byChunkId;
}

function toHit(row: ChunkRow, score: number): Hit {
  return {
    chunkId: row.chunk_id,
    docId: row.doc_id,
    page: row.page,
    charStart: row.char_start,
    charEnd: row.char_end,
    text: row.text,
    score,
    status: row.doc_status as HitStatus,
    statusConfidence: row.doc_status_confidence as StatusConfidence,
    alternates: parseAlternates(row.doc_alternate_candidates),
    stale: row.chunk_version_key !== row.doc_version_key,
  };
}

/**
 * Hybrid search over the local index.
 *
 * Runs FTS5 top-K for exact names and numbers and vector top-K over
 * `chunk_vectors` for semantic matches, then merges both ranked lists with
 * reciprocal rank fusion. Documents with a read error are never returned.
 *
 * The vector leg needs an embedding. Pass `opts.embed` to inject one (tests
 * use a stub); otherwise `opts.key` or `OPENROUTER_API_KEY` must be set.
 * Without either, the search is FTS5-only instead of failing.
 */
export async function hybridSearch(
  db: Client,
  query: string,
  opts: { topK: number } & SearchDeps,
): Promise<Hit[]> {
  const topK = Math.max(0, Math.trunc(opts.topK));
  if (topK === 0) return [];

  const [keywordIds, vector] = await Promise.all([
    keywordHits(db, query, topK),
    queryVector(query, opts),
  ]);
  const vectorIds = vector ? await vectorHits(db, vector, topK) : [];

  const fused = fuse([keywordIds, vectorIds]).slice(0, topK);
  const rows = await loadChunkRows(
    db,
    fused.map(({ chunkId }) => chunkId),
  );

  const hits: Hit[] = [];
  for (const { chunkId, score } of fused) {
    const row = rows.get(chunkId);
    if (row === undefined) continue;
    if (row.doc_read_error !== null) continue;
    hits.push(toHit(row, score));
  }
  return hits;
}
