import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Client } from "@libsql/client";
import type { Chunk } from "./chunk.js";
import type { MatchPlan } from "./identity.js";
import type { ParsedDoc } from "./parse/index.js";
import type {
  DocDates,
  DocSupersession,
  SupersessionResult,
} from "./supersession.js";
import type { VectorStore } from "./vector-store.js";

const IN_CHUNK_SIZE = 400;

export type PlanEntryMeta = {
  docId?: string;
  parsed?: ParsedDoc;
  dates?: DocDates;
};

export type ApplyPlan = {
  unchanged: MatchPlan["unchanged"];
  newVersion: Array<MatchPlan["newVersion"][number] & PlanEntryMeta>;
  moved: Array<MatchPlan["moved"][number] & PlanEntryMeta>;
  added: Array<MatchPlan["added"][number] & PlanEntryMeta>;
  pruned: MatchPlan["pruned"];
};

type NewChunk = {
  chunk: Chunk;
  versionKey: string;
};

type NewVector = {
  id: string;
  values: number[];
  metadata: { docId: string };
};

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function topicKeyFor(path: string): string {
  const dir = dirname(path);
  return dir === "." ? "" : dir;
}

function readErrorFor(parsed: ParsedDoc | undefined): string | null {
  if (!parsed) return null;
  return parsed.unreadable ? (parsed.reason ?? null) : null;
}

function statusFor(
  supersession: SupersessionResult,
  docId: string,
): DocSupersession {
  return (
    supersession.byDoc[docId] ?? {
      status: "unparsable",
      statusConfidence: "low",
      alternates: [],
    }
  );
}

/**
 * Applies one indexing run to the database and the vector store.
 *
 * Document, chunk, FTS, supersedes and ingest-log writes are sent in one
 * `client.batch(..., "write")` transaction. Chunks and their standalone FTS5
 * rows are deleted and inserted in that same batch. Vectors for removed
 * chunks are deleted from the store and vectors for changed chunks are
 * upserted after the relational batch succeeds.
 *
 * `documents.read_error` is copied from the parser result here; the parser
 * never writes the database. Added and new-version entries may carry the
 * parser result (`parsed`) and date metadata (`dates`) as extra properties on
 * the plan entries; without them, added rows get a null read error.
 */
export async function applyRun(
  db: Client,
  store: VectorStore,
  plan: MatchPlan,
  chunksByDoc: Map<string, Chunk[]>,
  vectors: Map<string, number[]>,
  supersession: SupersessionResult,
  runId: string,
  rootId: string,
): Promise<void> {
  const applyPlan = plan as ApplyPlan;
  const statements: Array<{ sql: string; args: Array<string | number | null> }> =
    [];

  const docsToClear = [
    ...applyPlan.newVersion.map((entry) => entry.docId),
    ...applyPlan.pruned,
  ];

  const oldChunkIds: string[] = [];
  for (const group of chunkArray(docsToClear, IN_CHUNK_SIZE)) {
    const result = await db.execute({
      sql: `SELECT chunk_id FROM chunks WHERE doc_id IN (${placeholders(group.length)})`,
      args: group,
    });
    for (const row of result.rows) {
      oldChunkIds.push(String(row.chunk_id));
    }
  }

  const newChunks: NewChunk[] = [];
  const newVectors: NewVector[] = [];
  const addedDocs: Array<{
    docId: string;
    entry: ApplyPlan["added"][number];
  }> = [];

  function collectChunks(
    docId: string,
    versionKey: string,
    chunks: Chunk[] | undefined,
  ): void {
    if (!chunks) return;
    for (const chunk of chunks) {
      if (chunk.docId !== docId) {
        throw new Error(
          `Chunk ${chunk.chunkId} belongs to ${chunk.docId}, expected ${docId}`,
        );
      }
      newChunks.push({ chunk, versionKey });
      const values = vectors.get(chunk.chunkId);
      if (!values) {
        throw new Error(`Missing embedding for chunk ${chunk.chunkId}`);
      }
      newVectors.push({
        id: chunk.chunkId,
        values,
        metadata: { docId },
      });
    }
  }

  for (const entry of applyPlan.newVersion) {
    collectChunks(
      entry.docId,
      entry.file.versionKey,
      chunksByDoc.get(entry.docId),
    );
  }

  for (const entry of applyPlan.added) {
    const byPath = chunksByDoc.get(entry.file.path);
    const docId = entry.docId ?? byPath?.[0]?.docId ?? randomUUID();
    const chunks = chunksByDoc.get(docId) ?? byPath ?? [];
    addedDocs.push({ docId, entry });
    collectChunks(docId, entry.file.versionKey, chunks);
  }

  const affectedDocIds = new Set<string>();
  for (const docId of applyPlan.unchanged) affectedDocIds.add(docId);
  for (const entry of applyPlan.newVersion) affectedDocIds.add(entry.docId);
  for (const entry of applyPlan.moved) affectedDocIds.add(entry.docId);
  for (const { docId } of addedDocs) affectedDocIds.add(docId);
  for (const docId of applyPlan.pruned) affectedDocIds.add(docId);

  for (const group of chunkArray([...affectedDocIds], IN_CHUNK_SIZE)) {
    const args = [...group, ...group];
    statements.push({
      sql: `DELETE FROM supersedes WHERE doc_id IN (${placeholders(group.length)}) OR supersedes_doc_id IN (${placeholders(group.length)})`,
      args,
    });
  }

  for (const group of chunkArray(oldChunkIds, IN_CHUNK_SIZE)) {
    statements.push({
      sql: `DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks_fts WHERE chunk_id IN (${placeholders(group.length)}))`,
      args: group,
    });
    statements.push({
      sql: `DELETE FROM chunks WHERE chunk_id IN (${placeholders(group.length)})`,
      args: group,
    });
  }

  for (const group of chunkArray(applyPlan.pruned, IN_CHUNK_SIZE)) {
    statements.push({
      sql: `DELETE FROM documents WHERE doc_id IN (${placeholders(group.length)}) AND root_id = ?`,
      args: [...group, rootId],
    });
  }

  for (const docId of applyPlan.unchanged) {
    const status = supersession.byDoc[docId];
    if (status) {
      statements.push({
        sql: `UPDATE documents
              SET last_seen_run = ?, status = ?, status_confidence = ?,
                  alternate_candidates = ?
              WHERE doc_id = ? AND root_id = ?`,
        args: [
          runId,
          status.status,
          status.statusConfidence,
          JSON.stringify(status.alternates),
          docId,
          rootId,
        ],
      });
    } else {
      statements.push({
        sql: "UPDATE documents SET last_seen_run = ? WHERE doc_id = ? AND root_id = ?",
        args: [runId, docId, rootId],
      });
    }
  }

  for (const entry of applyPlan.moved) {
    const topicKey = topicKeyFor(entry.file.path);
    const status = supersession.byDoc[entry.docId];
    if (status) {
      statements.push({
        sql: `UPDATE documents
              SET path = ?, topic_key = ?, sha256 = ?, version_key = ?,
                  last_seen_run = ?, status = ?, status_confidence = ?,
                  alternate_candidates = ?
              WHERE doc_id = ? AND root_id = ?`,
        args: [
          entry.file.path,
          topicKey,
          entry.file.sha256,
          entry.file.versionKey,
          runId,
          status.status,
          status.statusConfidence,
          JSON.stringify(status.alternates),
          entry.docId,
          rootId,
        ],
      });
    } else {
      statements.push({
        sql: `UPDATE documents
              SET path = ?, topic_key = ?, sha256 = ?, version_key = ?,
                  last_seen_run = ?
              WHERE doc_id = ? AND root_id = ?`,
        args: [
          entry.file.path,
          topicKey,
          entry.file.sha256,
          entry.file.versionKey,
          runId,
          entry.docId,
          rootId,
        ],
      });
    }
  }

  for (const entry of applyPlan.newVersion) {
    const topicKey = entry.dates?.topicKey ?? topicKeyFor(entry.file.path);
    const status = statusFor(supersession, entry.docId);
    const dates = entry.dates;
    statements.push({
      sql: `UPDATE documents
            SET path = ?, topic_key = ?, version_key = ?, sha256 = ?,
                document_number = ?, issued_date = ?, effective_date = ?,
                raw_date_strings = ?, status = ?, status_confidence = ?,
                alternate_candidates = ?, read_error = ?, last_seen_run = ?
            WHERE doc_id = ? AND root_id = ?`,
      args: [
        entry.file.path,
        topicKey,
        entry.file.versionKey,
        entry.file.sha256,
        dates?.documentNumber ?? null,
        dates?.issued ?? null,
        dates?.effective ?? null,
        dates ? JSON.stringify(dates.raw) : null,
        status.status,
        status.statusConfidence,
        JSON.stringify(status.alternates),
        readErrorFor(entry.parsed),
        runId,
        entry.docId,
        rootId,
      ],
    });
  }

  for (const { docId, entry } of addedDocs) {
    const topicKey = entry.dates?.topicKey ?? topicKeyFor(entry.file.path);
    const status = statusFor(supersession, docId);
    const dates = entry.dates;
    statements.push({
      sql: `INSERT INTO documents (
              doc_id, root_id, path, topic_key, version_key, sha256,
              drive_file_id, document_number, issued_date, effective_date,
              raw_date_strings, status, status_confidence,
              alternate_candidates, is_duplicate, read_error, last_seen_run
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        docId,
        rootId,
        entry.file.path,
        topicKey,
        entry.file.versionKey,
        entry.file.sha256,
        dates?.documentNumber ?? null,
        dates?.issued ?? null,
        dates?.effective ?? null,
        dates ? JSON.stringify(dates.raw) : null,
        status.status,
        status.statusConfidence,
        JSON.stringify(status.alternates),
        entry.isDuplicate ? 1 : 0,
        readErrorFor(entry.parsed),
        runId,
      ],
    });
  }

  for (const { chunk, versionKey } of newChunks) {
    statements.push({
      sql: `INSERT OR REPLACE INTO chunks (
              chunk_id, doc_id, page, idx, char_start, char_end, text,
              version_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        chunk.chunkId,
        chunk.docId,
        chunk.page,
        chunk.idx,
        chunk.charStart,
        chunk.charEnd,
        chunk.text,
        versionKey,
      ],
    });
    statements.push({
      sql: "INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)",
      args: [chunk.chunkId, chunk.text],
    });
  }

  for (const edge of supersession.supersedes) {
    statements.push({
      sql: "INSERT OR IGNORE INTO supersedes (doc_id, supersedes_doc_id) VALUES (?, ?)",
      args: [edge.docId, edge.supersedesDocId],
    });
  }

  const now = new Date().toISOString();
  statements.push({
    sql: `INSERT INTO ingest_log (run_id, root_id, root_path, started_at, finished_at)
          VALUES (?, ?, '', ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET finished_at = excluded.finished_at`,
    args: [runId, rootId, now, now],
  });

  await db.batch(statements, "write");

  if (oldChunkIds.length > 0) {
    await store.deleteByIds(oldChunkIds);
  }
  if (newVectors.length > 0) {
    await store.upsert(newVectors);
  }
}
