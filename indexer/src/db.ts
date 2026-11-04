import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Client, createClient } from "@libsql/client";

/**
 * Schema statements for the docs-agent database. Every statement is
 * idempotent (`IF NOT EXISTS`) so `openDb` can run on every process start.
 */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    path TEXT NOT NULL,
    topic_key TEXT NOT NULL,
    version_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    drive_file_id TEXT,
    document_number TEXT,
    issued_date TEXT,
    effective_date TEXT,
    raw_date_strings TEXT,
    status TEXT NOT NULL,
    status_confidence TEXT NOT NULL,
    alternate_candidates TEXT,
    is_duplicate INTEGER NOT NULL DEFAULT 0,
    read_error TEXT,
    last_seen_run TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    page INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    text TEXT NOT NULL,
    version_key TEXT NOT NULL
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (
    chunk_id UNINDEXED,
    text
  )`,
  `CREATE TABLE IF NOT EXISTS chunk_vectors (
    chunk_id TEXT PRIMARY KEY,
    embedding F32_BLOB(1536) NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS chunk_vectors_idx
    ON chunk_vectors(libsql_vector_idx(embedding, 'metric=cosine'))`,
  `CREATE TABLE IF NOT EXISTS supersedes (
    doc_id TEXT NOT NULL,
    supersedes_doc_id TEXT NOT NULL,
    PRIMARY KEY (doc_id, supersedes_doc_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ingest_log (
    run_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    root_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT
  )`,
];

/**
 * Open (or create) the libsql database at `path` and ensure the schema exists.
 * `path` may be a plain file path, an explicit `file:` URL, or `:memory:`.
 */
export async function openDb(path: string): Promise<Client> {
  const memory = path === ":memory:";
  const filePath = path.startsWith("file:") ? path.slice("file:".length) : path;
  const remote = !memory && !path.startsWith("file:") && path.includes("://");
  const url = memory || remote ? path : `file:${filePath}`;

  if (!memory && !remote) {
    await mkdir(dirname(filePath), { recursive: true });
  }

  const client = createClient({ url });
  await client.batch(SCHEMA_STATEMENTS, "write");
  return client;
}
