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

const nearEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => unitVector(0));

test("no chunks yields no citations and no invented source", async () => {
  const db = await makeDb();
  const r = await answer(db, "prosedur cuti", "answer", { embed: nearEmbed, key: "k" });
  expect(r.text).toBe("Sumber tidak ditemukan untuk pertanyaan ini.");
  expect(r.citations).toEqual([]);
});

test("answer is verbatim retrieved chunk text tagged with its chunkId", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "ADI/cuti.pdf" });
  await insertChunk(db, { chunkId: "doc-a:1:0", docId: "doc-a", text: "Cuti tahunan diajukan ke atasan." });
  await insertVector(db, "doc-a:1:0", unitVector(0));

  const r = await answer(db, "cuti", "answer", { embed: nearEmbed, key: "k" });

  expect(r.text).toBe("Cuti tahunan diajukan ke atasan. [doc-a:1:0]");
  expect(r.citations.map((c) => c.chunkId)).toEqual(["doc-a:1:0"]);
  expect(r.citations[0]?.path).toBe("ADI/cuti.pdf");
  expect(r.draft).toBeUndefined();
});

test("citations are exactly the quoted top chunks, capped at three", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "ADI/cuti.pdf" });
  for (const n of [0, 1, 2, 3]) {
    const chunkId = `doc-a:${n}:0`;
    await insertChunk(db, { chunkId, docId: "doc-a", text: `Cuti poin ${n}.` });
    await insertVector(db, chunkId, unitVector(0));
  }

  const r = await answer(db, "cuti", "answer", { embed: nearEmbed, key: "k" });

  expect(r.citations).toHaveLength(3);
  for (const citation of r.citations) {
    expect(r.text).toContain(`[${citation.chunkId}]`);
  }
  expect(r.text.split("[doc-a:").length - 1).toBe(3);
});

test("draft mode returns the same excerpts in text and draft", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "ADI/cuti.pdf" });
  await insertChunk(db, { chunkId: "doc-a:1:0", docId: "doc-a", text: "Cuti tahunan tiga hari kerja." });
  await insertVector(db, "doc-a:1:0", unitVector(0));

  const r = await answer(db, "cuti", "draft", { embed: nearEmbed, key: "k" });

  expect(r.draft).toBe(r.text);
  expect(r.text).toBe("Cuti tahunan tiga hari kerja. [doc-a:1:0]");
});

test("low-confidence active doc surfaces alternates as a warning", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "ADI/cuti.pdf", confidence: "low", alternates: ["doc-b"] });
  await insertDoc(db, { docId: "doc-b", path: "ADI/cuti-lama.pdf", status: "superseded" });
  await insertChunk(db, { chunkId: "doc-a:1:0", docId: "doc-a", text: "Cuti tahunan." });
  await insertVector(db, "doc-a:1:0", unitVector(0));

  const r = await answer(db, "cuti", "answer", { embed: nearEmbed, key: "k" });

  expect(r.alternates).toEqual([{ docId: "doc-b", path: "ADI/cuti-lama.pdf" }]);
  expect(r.warnings.some((w) => w === "ADI/cuti-lama — alternate, check needed")).toBe(true);
});

test("inactive cited document is named in a warning", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-old", path: "OPR/archive/cuti.pdf", status: "superseded" });
  await insertChunk(db, { chunkId: "doc-old:1:0", docId: "doc-old", text: "Cuti lama." });
  await insertVector(db, "doc-old:1:0", unitVector(0));

  const r = await answer(db, "cuti", "answer", { embed: nearEmbed, key: "k" });

  expect(r.warnings.some((w) => w === "OPR/archive/cuti — cited, not active")).toBe(true);
});

test("embedding failure still answers from keyword hits", async () => {
  const db = await makeDb();
  await insertDoc(db, { docId: "doc-a", path: "ADI/cuti.pdf" });
  await insertChunk(db, { chunkId: "doc-a:1:0", docId: "doc-a", text: "Cuti tahunan diajukan." });

  const r = await answer(db, "cuti", "answer", {
    embed: async () => {
      throw new Error("embedding down");
    },
    key: "k",
  });

  expect(r.citations.map((c) => c.chunkId)).toEqual(["doc-a:1:0"]);
  expect(r.text).toBe("Cuti tahunan diajukan. [doc-a:1:0]");
});
