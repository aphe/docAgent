import type { Client } from "@libsql/client";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { openDb } from "../src/db";
import { type IndexDeps, runIndex, scanPdfFiles } from "../src/index-run";
import type { ParsedDoc } from "../src/parse/index";
import type { VectorStore } from "../src/vector-store";

const corpus = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));
const DATED_TEXT =
  "Ditetapkan pada tanggal 1 Januari 2024 oleh pejabat yang berwenang. " +
  "Diundangkan pada tanggal 2 Januari 2024 di Jakarta.";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docs-agent-index-"));
  tempDirs.push(dir);
  return dir;
}

/** Parses fixtures by name so the tests never run pdfjs or touch the network. */
async function stubParse(absPath: string): Promise<ParsedDoc> {
  const name = basename(absPath);
  if (name.includes("no-text")) {
    return {
      pages: [{ page: 1, text: "" }],
      unreadable: true,
      reason: "no-text-layer",
    };
  }
  if (name.includes("copy-restricted")) {
    return { pages: [], unreadable: true, reason: "copy-restricted" };
  }
  if (name === "lampiran.pdf") {
    return {
      pages: [
        {
          page: 1,
          text: "LAMPIRAN\nDitetapkan pada tanggal 1 Januari 2024 oleh pejabat yang berwenang.",
        },
      ],
      unreadable: false,
    };
  }
  if (name === "c.pdf") {
    return {
      pages: [{ page: 2, text: "Edited content on page 2." }],
      unreadable: false,
    };
  }
  return { pages: [{ page: 1, text: DATED_TEXT }], unreadable: false };
}

function fakeVector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_value, index) => seed + index * 0.001);
}

interface State {
  batches: number;
  writes: string[];
  upserts: number;
  upsertedIds: string[];
  deleted: string[][];
  embedCalls: string[][];
  parseCalls: string[];
}

function trackWrites(db: Client, state: State): Client {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return async (statement: Parameters<Client["execute"]>[0]) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (/^\s*(insert|update|delete)/i.test(sql)) state.writes.push(sql);
          return target.execute(statement);
        };
      }
      if (prop === "batch") {
        return async (
          statements: Parameters<Client["batch"]>[0],
          mode?: Parameters<Client["batch"]>[1],
        ) => {
          state.batches++;
          for (const statement of statements) {
            state.writes.push(
              typeof statement === "string" ? statement : statement.sql,
            );
          }
          return target.batch(statements, mode);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function makeDeps(db: Client, state: State): IndexDeps {
  const store: VectorStore = {
    upsert: async (vectors) => {
      state.upserts += vectors.length;
      for (const vector of vectors) state.upsertedIds.push(vector.id);
    },
    deleteByIds: async (ids) => {
      state.deleted.push(ids);
    },
  };
  return {
    db: trackWrites(db, state),
    store,
    scan: scanPdfFiles,
    parse: async (absPath) => {
      state.parseCalls.push(absPath);
      return stubParse(absPath);
    },
    embed: async (texts) => {
      state.embedCalls.push(texts);
      return texts.map((_text, index) => fakeVector(index));
    },
    minTextChars: 20,
    chunkMaxChars: 200,
    openrouterKey: "sk-test",
  };
}

function newState(): State {
  return {
    batches: 0,
    writes: [],
    upserts: 0,
    upsertedIds: [],
    deleted: [],
    embedCalls: [],
    parseCalls: [],
  };
}

async function getRowCounts(
  db: Client,
  tables: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await db.execute(`SELECT COUNT(*) AS count FROM ${table}`);
    counts[table] = Number(result.rows[0].count);
  }
  return counts;
}

test("dry run reports counts and writes nothing", async () => {
  const db = await openDb(":memory:");
  try {
    const populateState = newState();
    await runIndex({
      root: corpus,
      dryRun: false,
      deps: makeDeps(db, populateState),
    });

    const tables = [
      "documents",
      "chunks",
      "chunks_fts",
      "chunk_vectors",
      "supersedes",
      "ingest_log",
    ];
    const before = await getRowCounts(db, tables);

    const state = newState();
    const summary = await runIndex({
      root: corpus,
      dryRun: true,
      deps: makeDeps(db, state),
    });

    expect(summary.added).toBe(0);
    expect(summary.newVersion).toBe(0);
    expect(summary.moved).toBe(0);
    expect(summary.pruned).toBe(0);
    expect(summary.duplicates).toBe(0);
    expect(summary.noTextLayerPdfs).toBe(0);
    expect(summary.unparsable).toBe(2);
    expect(summary.skippedNonPdf).toBe(1);

    expect(state.parseCalls).toHaveLength(0);
    expect(state.embedCalls).toHaveLength(0);
    expect(state.upserts).toBe(0);
    expect(state.deleted).toHaveLength(0);
    expect(state.batches).toBe(0);
    expect(state.writes).toHaveLength(0);

    const after = await getRowCounts(db, tables);
    expect(after).toEqual(before);
  } finally {
    db.close();
  }
});

test("scan skips hidden entries and keys files by their content hash", async () => {
  const scan = await scanPdfFiles(corpus);

  expect(scan.files.map((file) => file.path)).toEqual([
    "copy-restricted.pdf",
    "digital.pdf",
    "no-text.pdf",
  ]);
  expect(scan.skippedNonPdf).toBe(1);
  for (const file of scan.files) {
    expect(file.versionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(file.sha256).toBe(file.versionKey);
  }
});

test("real run writes the index and a repeat run reports no changes", async () => {
  const db = await openDb(":memory:");
  try {
    const state = newState();
    const deps = makeDeps(db, state);

    const first = await runIndex({ root: corpus, dryRun: false, deps });
    expect(first.added).toBe(3);
    expect(first.noTextLayerPdfs).toBe(1);
    expect(first.unparsable).toBe(2);
    expect(state.batches).toBe(1);

    const chunkRows = await db.execute("SELECT chunk_id FROM chunks");
    const chunkIds = chunkRows.rows.map((row) => String(row.chunk_id));
    expect(state.upsertedIds.sort()).toEqual(chunkIds.sort());

    const docs = await db.execute(
      "SELECT path, status, status_confidence, read_error FROM documents",
    );
    expect(docs.rows).toHaveLength(3);
    const byPath = new Map(
      docs.rows.map((row) => [String(row.path), row]),
    );
    expect(byPath.get("digital.pdf")?.status).toBe("active");
    expect(byPath.get("digital.pdf")?.status_confidence).toBe("high");
    expect(byPath.get("copy-restricted.pdf")?.read_error).toBe(
      "copy-restricted",
    );
    expect(byPath.get("no-text.pdf")?.status).toBe("unparsable");

    const second = await runIndex({ root: corpus, dryRun: false, deps });
    expect(second.added).toBe(0);
    expect(second.newVersion).toBe(0);
    expect(second.moved).toBe(0);
    expect(second.pruned).toBe(0);
    expect(second.unparsable).toBe(2);
  } finally {
    db.close();
  }
});

test("identical files in one run are ingested and the second is flagged", async () => {
  const dir = await makeTempDir();
  await copyFile(join(corpus, "digital.pdf"), join(dir, "a.pdf"));
  await copyFile(join(corpus, "digital.pdf"), join(dir, "b.pdf"));

  const db = await openDb(":memory:");
  try {
    const state = newState();
    const summary = await runIndex({
      root: dir,
      dryRun: false,
      deps: makeDeps(db, state),
    });

    expect(summary.added).toBe(2);
    expect(summary.duplicates).toBe(1);

    const rows = await db.execute(
      "SELECT is_duplicate FROM documents ORDER BY path",
    );
    expect(rows.rows.map((row) => Number(row.is_duplicate))).toEqual([0, 1]);
  } finally {
    db.close();
  }
});

test("rename keeps the doc id, deleted files prune rows, edits create versions", async () => {
  const dir = await makeTempDir();
  await copyFile(join(corpus, "digital.pdf"), join(dir, "a.pdf"));
  await copyFile(join(corpus, "no-text.pdf"), join(dir, "b.pdf"));

  const db = await openDb(":memory:");
  try {
    const state = newState();
    const deps = makeDeps(db, state);

    const first = await runIndex({ root: dir, dryRun: false, deps });
    expect(first.added).toBe(2);

    const before = await db.execute(
      "SELECT doc_id, path, topic_key FROM documents ORDER BY path",
    );
    const idOfA = String(
      before.rows.find((row) => row.path === "a.pdf")?.doc_id,
    );
    const idOfB = String(
      before.rows.find((row) => row.path === "b.pdf")?.doc_id,
    );
    expect(
      String(before.rows.find((row) => row.path === "a.pdf")?.topic_key),
    ).toBe("");

    await mkdir(join(dir, "nested"), { recursive: true });
    await rename(join(dir, "a.pdf"), join(dir, "nested", "c.pdf"));
    await unlink(join(dir, "b.pdf"));

    const second = await runIndex({ root: dir, dryRun: false, deps });
    expect(second.moved).toBe(1);
    expect(second.pruned).toBe(1);
    expect(second.added).toBe(0);
    expect(second.newVersion).toBe(0);

    const afterMove = await db.execute(
      "SELECT doc_id, path, topic_key FROM documents ORDER BY path",
    );
    expect(afterMove.rows).toHaveLength(1);
    expect(afterMove.rows[0].path).toBe("nested/c.pdf");
    expect(String(afterMove.rows[0].doc_id)).toBe(idOfA);
    expect(String(afterMove.rows[0].topic_key)).toBe("nested");
    expect(String(afterMove.rows[0].topic_key)).not.toBe("");

    const oldChunks = await db.execute(
      "SELECT chunk_id FROM chunks WHERE doc_id = ?",
      [idOfA],
    );
    const oldChunkIds = oldChunks.rows.map((row) => String(row.chunk_id));
    expect(oldChunkIds.length).toBeGreaterThan(0);

    const oldChunksB = await db.execute(
      "SELECT chunk_id FROM chunks WHERE doc_id = ?",
      [idOfB],
    );
    expect(oldChunksB.rows).toHaveLength(0);
    expect(state.deleted.flat().some((id) => id.startsWith(idOfB))).toBe(true);

    await appendFile(join(dir, "nested", "c.pdf"), "\n% changed\n");
    const third = await runIndex({ root: dir, dryRun: false, deps });
    expect(third.newVersion).toBe(1);
    expect(third.added).toBe(0);

    for (const oldId of oldChunkIds) {
      const chunkRow = await db.execute(
        "SELECT chunk_id FROM chunks WHERE chunk_id = ?",
        [oldId],
      );
      expect(chunkRow.rows).toHaveLength(0);
      const ftsRow = await db.execute(
        "SELECT chunk_id FROM chunks_fts WHERE chunk_id = ?",
        [oldId],
      );
      expect(ftsRow.rows).toHaveLength(0);
      expect(state.deleted.flat()).toContain(oldId);
    }

    const afterEdit = await db.execute(
      "SELECT doc_id, path FROM documents ORDER BY path",
    );
    expect(afterEdit.rows).toHaveLength(1);
    expect(String(afterEdit.rows[0].doc_id)).toBe(idOfA);
  } finally {
    db.close();
  }
});

test("lampiran stays unparsable across unchanged and moved runs", async () => {
  const dir = await makeTempDir();
  await copyFile(join(corpus, "digital.pdf"), join(dir, "lampiran.pdf"));

  const db = await openDb(":memory:");
  try {
    const state = newState();
    const deps = makeDeps(db, state);

    const first = await runIndex({ root: dir, dryRun: false, deps });
    expect(first.added).toBe(1);
    expect(first.unparsable).toBe(1);

    const rows = await db.execute("SELECT status, topic_key FROM documents");
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0].status)).toBe("unparsable");
    expect(String(rows.rows[0].topic_key)).toBe("");

    const second = await runIndex({ root: dir, dryRun: false, deps });
    expect(second.added).toBe(0);
    expect(second.unparsable).toBe(1);
    const rows2 = await db.execute("SELECT status, topic_key FROM documents");
    expect(String(rows2.rows[0].status)).toBe("unparsable");

    await mkdir(join(dir, "nested"), { recursive: true });
    await rename(join(dir, "lampiran.pdf"), join(dir, "nested", "lampiran.pdf"));
    const third = await runIndex({ root: dir, dryRun: false, deps });
    expect(third.moved).toBe(1);
    expect(third.unparsable).toBe(1);
    const rows3 = await db.execute("SELECT status, topic_key FROM documents");
    expect(String(rows3.rows[0].status)).toBe("unparsable");
    expect(String(rows3.rows[0].topic_key)).toBe("nested");
  } finally {
    db.close();
  }
});

test("filename date fallback does not date read_error documents", async () => {
  const dir = await makeTempDir();
  await copyFile(
    join(corpus, "copy-restricted.pdf"),
    join(dir, "20240101-copy-restricted.pdf"),
  );

  const db = await openDb(":memory:");
  try {
    const state = newState();
    const summary = await runIndex({
      root: dir,
      dryRun: false,
      deps: makeDeps(db, state),
    });

    expect(summary.added).toBe(1);
    expect(summary.unparsable).toBe(1);

    const rows = await db.execute(
      "SELECT status, issued_date, read_error FROM documents",
    );
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0].status)).toBe("unparsable");
    expect(rows.rows[0].issued_date).toBeNull();
    expect(String(rows.rows[0].read_error)).toBe("copy-restricted");
  } finally {
    db.close();
  }
});
