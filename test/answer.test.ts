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

function unitVector(index: number): number[] {
  const values = new Array<number>(1536).fill(0);
  values[index] = 1;
  return values;
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

test("no hits yields no citations and no invented source", async () => {
  const db = await makeDb();
  const r = await answer(db, "prosedur cuti", "answer", {
    key: "test-key",
    embed: async () => [unitVector(0)],
    chat: async () => {
      throw new Error("LLM must not be called without hits");
    },
  });
  expect(r.citations).toEqual([]);
  expect(r.text).toMatch(/tidak ditemukan|no source/i);
  expect(r.draft).toBeUndefined();
  expect(Object.keys(r).sort()).toEqual(["alternates", "citations", "text", "warnings"]);
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
    key: "test-key",
    embed: async () => [unitVector(0)],
    chat: async () => "Menurut [doc-a:1:0], cuti tahunan diajukan ke atasan.",
  });

  expect(r.alternates).toEqual([
    { docId: "doc-b", path: "NEW SOP/cuti-lama.pdf" },
  ]);
  expect(r.warnings.some((warning) => warning.includes("NEW SOP/cuti.pdf"))).toBe(true);
  expect(r.warnings.some((warning) => warning.includes("NEW SOP/cuti-lama.pdf"))).toBe(true);
  expect(r.text).toContain("doc-a:1:0");
  expect(r.citations.map((citation) => citation.chunkId)).toEqual(["doc-a:1:0"]);
  expect(r.draft).toBeUndefined();
  expect(Object.keys(r).sort()).toEqual(["alternates", "citations", "text", "warnings"]);
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
    key: "test-key",
    embed: async () => [unitVector(0)],
    chat: async () => "Menurut [doc-a:1:0], cuti diajukan.",
  });

  expect(r.citations[0].stale).toBe(true);
  expect(r.warnings.some((warning) => /stale/i.test(warning))).toBe(true);
  expect(r.warnings.some((warning) => warning.includes("NEW SOP/cuti.pdf"))).toBe(true);
});

test("draft mode returns text and draft with no Drive field", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "NEW SOP/cuti.pdf" });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "prosedur cuti tahunan",
  });

  const r = await answer(db, "cuti", "draft", {
    key: "test-key",
    embed: async () => [unitVector(0)],
    chat: async () => "Draf: cuti tahunan diajukan paling lambat tiga hari kerja [doc-a:1:0].",
  });

  expect(typeof r.draft).toBe("string");
  expect(r.draft).toContain("Draf");
  expect(Object.keys(r).sort()).toEqual([
    "alternates",
    "citations",
    "draft",
    "text",
    "warnings",
  ]);
});

test("only citations the model text cites are kept", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "NEW SOP/cuti.pdf" });
  await insertDoc(db, { docId: "doc-b", path: "NEW SOP/cuti-lama.pdf" });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "prosedur cuti tahunan",
  });
  await insertChunk(db, {
    chunkId: "doc-b:1:0",
    docId: "doc-b",
    text: "prosedur cuti lama",
  });

  const r = await answer(db, "cuti", "answer", {
    key: "test-key",
    embed: async () => [unitVector(0)],
    chat: async () => "Menurut [doc-a:1:0], cuti tahunan diajukan.",
  });

  expect(r.citations.map((citation) => citation.chunkId)).toEqual(["doc-a:1:0"]);
});

test("model text without a citation returns no source and no citations", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "NEW SOP/cuti.pdf" });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "prosedur cuti tahunan",
  });

  const r = await answer(db, "cuti", "answer", {
    key: "test-key",
    embed: async () => [unitVector(0)],
    chat: async () => "Tidak ada kutipan yang cocok.",
  });

  expect(r.text).toMatch(/tidak ditemukan|no source/i);
  expect(r.citations).toEqual([]);
});

test("far vector with no keyword match returns no source", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "NEW SOP/cuti.pdf" });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "prosedur cuti tahunan",
  });
  await insertVector(db, "doc-a:1:0", unitVector(0));

  const r = await answer(db, "xyz", "answer", {
    key: "test-key",
    embed: async () => [unitVector(1)],
    chat: async () => {
      throw new Error("LLM must not be called without hits");
    },
  });

  expect(r.text).toMatch(/tidak ditemukan|no source/i);
  expect(r.citations).toEqual([]);
});

test("embedding failure warns and still answers from FTS hits", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "NEW SOP/cuti.pdf" });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "prosedur cuti tahunan",
  });

  const r = await answer(db, "cuti", "answer", {
    key: "test-key",
    embed: async () => {
      throw new Error("embedding service down");
    },
    chat: async () => "Menurut [doc-a:1:0], cuti diajukan.",
  });

  expect(r.citations.map((citation) => citation.chunkId)).toEqual(["doc-a:1:0"]);
  expect(r.warnings).toContain("vector search unavailable");
});

test("passages carry status and confidence and inactive citations warn by path", async () => {
  const db = await makeDb();
  await insertDoc(db, {
    docId: "doc-a",
    path: "NEW SOP/cuti.pdf",
    status: "active",
  });
  await insertDoc(db, {
    docId: "doc-b",
    path: "NEW SOP/cuti-lama.pdf",
    status: "superseded",
  });
  await insertChunk(db, {
    chunkId: "doc-a:1:0",
    docId: "doc-a",
    text: "prosedur cuti tahunan",
  });
  await insertChunk(db, {
    chunkId: "doc-b:1:0",
    docId: "doc-b",
    text: "prosedur cuti lama",
  });

  let messages: Array<{ role: string; content: string }> = [];
  const r = await answer(db, "cuti", "answer", {
    key: "test-key",
    embed: async () => [unitVector(0)],
    chat: async (msgs) => {
      messages = msgs;
      return "Menurut [doc-b:1:0], cuti lama berlaku.";
    },
  });

  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const user = messages.find((message) => message.role === "user")?.content ?? "";
  expect(system).toContain("data");
  expect(system).toContain("active");
  expect(user).toContain('<passage id="doc-b:1:0">');
  expect(user).toContain("status: superseded");
  expect(user).toContain("confidence: high");
  expect(r.citations.map((citation) => citation.chunkId)).toEqual(["doc-b:1:0"]);
  expect(r.warnings.some((warning) => warning.includes("NEW SOP/cuti-lama.pdf"))).toBe(true);
});
