import type { Client } from "@libsql/client";
import { afterEach, expect, test } from "vitest";
import { openDb } from "../indexer/src/db";
import { hybridSearch } from "../src/query/search";

const clients: Client[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function makeDb(): Promise<Client> {
  const db = await openDb(":memory:");
  clients.push(db);
  return db;
}

interface DocInput {
  docId: string;
  path: string;
  status?: "active" | "superseded" | "unparsable";
  confidence?: "high" | "low";
  alternates?: string[];
  versionKey?: string;
  readError?: string | null;
}

async function insertDoc(db: Client, input: DocInput): Promise<void> {
  await db.execute({
    sql: `INSERT INTO documents (
            doc_id, root_id, path, topic_key, version_key, sha256,
            drive_file_id, document_number, issued_date, effective_date,
            raw_date_strings, status, status_confidence, alternate_candidates,
            is_duplicate, read_error, last_seen_run
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 0, ?, ?)`,
    args: [
      input.docId,
      "root-1",
      input.path,
      input.path.includes("/") ? input.path.slice(0, input.path.lastIndexOf("/")) : "",
      input.versionKey ?? "v1",
      "sha-1",
      "[]",
      input.status ?? "active",
      input.confidence ?? "high",
      JSON.stringify(input.alternates ?? []),
      input.readError ?? null,
      "run-1",
    ],
  });
}

interface ChunkInput {
  chunkId: string;
  docId: string;
  text: string;
  page?: number;
  idx?: number;
  versionKey?: string;
}

async function insertChunk(db: Client, input: ChunkInput): Promise<void> {
  const page = input.page ?? 1;
  const idx = input.idx ?? 0;
  await db.execute({
    sql: `INSERT INTO chunks (chunk_id, doc_id, page, idx, char_start, char_end, text, version_key)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    args: [
      input.chunkId,
      input.docId,
      page,
      idx,
      input.text.length,
      input.text,
      input.versionKey ?? "v1",
    ],
  });
  await db.execute({
    sql: "INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)",
    args: [input.chunkId, input.text],
  });
}

function unitVector(index: number): number[] {
  const values = new Array<number>(1536).fill(0);
  values[index] = 1;
  return values;
}

async function insertVector(
  db: Client,
  chunkId: string,
  values: number[],
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, vector32(?))",
    args: [chunkId, JSON.stringify(values)],
  });
}

test("hybrid search merges FTS5 and vector hits", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "NEW SOP/cuti.pdf" });
  await insertDoc(db, { docId: "doc-b", path: "NEW SOP/libur.pdf" });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "prosedur cuti tahunan",
  });
  await insertChunk(db, {
    chunkId: "doc-b:1:0",
    docId: "doc-b",
    text: "libur bersama akhir tahun",
  });
  // doc-a has no vector row: it can only come from the FTS leg.
  await insertVector(db, "doc-b:1:0", unitVector(0));

  const hits = await hybridSearch(db, "cuti", {
    topK: 2,
    embed: async () => [unitVector(0)],
    key: "test-key",
  });

  const ids = hits.map((hit) => hit.chunkId).sort();
  expect(ids).toEqual(["doc-a:1:0", "doc-b:1:0"]);
  expect(hits.find((hit) => hit.chunkId === "doc-b:1:0")?.text).toContain("libur");
});

test("stale citation is marked stale", async () => {
  const db = await makeDb();
  await insertDoc(db, {
    docId: "doc-a",
    path: "NEW SOP/cuti.pdf",
    versionKey: "v2",
  });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "prosedur cuti",
    versionKey: "v1",
  });

  const hits = await hybridSearch(db, "cuti", { topK: 5 });
  expect(hits.find((hit) => hit.stale)).toBeDefined();
});

test("unreadable documents are never returned as hits", async () => {
  const db = await makeDb();
  await insertDoc(db, {
    docId: "doc-bad",
    path: "NEW SOP/rusak.pdf",
    readError: "copy-restricted",
  });
  await insertChunk(db, {
    chunkId: "doc-bad:1:0",
    docId: "doc-bad",
    text: "prosedur cuti",
  });

  const hits = await hybridSearch(db, "cuti", { topK: 5 });
  expect(hits).toEqual([]);
});
