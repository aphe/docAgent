import type { Client } from "@libsql/client";
import { afterEach, expect, test } from "vitest";
import { openDb } from "../indexer/src/db";
import { answer } from "../src/query/answer";

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
}

async function insertDoc(db: Client, input: DocInput): Promise<void> {
  await db.execute({
    sql: `INSERT INTO documents (
            doc_id, root_id, path, topic_key, version_key, sha256,
            drive_file_id, document_number, issued_date, effective_date,
            raw_date_strings, status, status_confidence, alternate_candidates,
            is_duplicate, read_error, last_seen_run
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 0, NULL, ?)`,
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
      "run-1",
    ],
  });
}

async function insertChunk(
  db: Client,
  input: { chunkId: string; docId: string; text: string; versionKey?: string },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO chunks (chunk_id, doc_id, page, idx, char_start, char_end, text, version_key)
          VALUES (?, ?, 1, 0, 0, ?, ?, ?)`,
    args: [input.chunkId, input.docId, input.text.length, input.text, input.versionKey ?? "v1"],
  });
  await db.execute({
    sql: "INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)",
    args: [input.chunkId, input.text],
  });
}

test("no hits yields no citations and no invented source", async () => {
  const db = await makeDb();
  const r = await answer(db, "prosedur cuti", "answer", {
    chat: async () => {
      throw new Error("LLM must not be called without hits");
    },
  });
  expect(r.citations).toEqual([]);
  expect(r.text).toMatch(/tidak ditemukan|no source/i);
});

test("low-confidence active doc surfaces alternates as a warning", async () => {
  const db = await makeDb();
  await insertDoc(db, {
    docId: "doc-a",
    path: "NEW SOP/cuti.pdf",
    status: "active",
    confidence: "low",
    alternates: ["doc-b"],
  });
  await insertDoc(db, {
    docId: "doc-b",
    path: "NEW SOP/cuti-lama.pdf",
    status: "active",
    confidence: "low",
    alternates: ["doc-a"],
  });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "SOP cuti tahunan bagi pegawai",
  });

  const r = await answer(db, "SOP cuti", "answer", {
    chat: async () => "Menurut [doc-a:1:0], cuti tahunan diajukan ke atasan.",
  });

  expect(r.alternates).toEqual(["doc-b"]);
  expect(r.warnings.length).toBeGreaterThan(0);
  expect(r.text).toContain("doc-a:1:0");
  expect(r.citations.map((citation) => citation.chunkId)).toEqual(["doc-a:1:0"]);
});

test("stale hit produces a stale warning", async () => {
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

  const r = await answer(db, "cuti", "answer", {
    chat: async () => "Menurut [doc-a:1:0], cuti diajukan.",
  });

  expect(r.citations[0].stale).toBe(true);
  expect(r.warnings.some((warning) => /stale/i.test(warning))).toBe(true);
});

test("draft mode returns text only with no Drive reference", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "NEW SOP/cuti.pdf" });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "prosedur cuti tahunan",
  });

  const r = await answer(db, "cuti", "draft", {
    chat: async () => "Draf: cuti tahunan diajukan paling lambat tiga hari kerja.",
  });

  expect(typeof r.draft).toBe("string");
  expect(r.draft).toContain("Draf");
  expect(JSON.stringify(r).toLowerCase()).not.toContain("drive");
});
