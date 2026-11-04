import type { Client } from "@libsql/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Chunk } from "../src/chunk.js";
import { openDb } from "../src/db.js";
import { embedTexts } from "../src/embed.js";
import type { VectorStore } from "../src/vector-store.js";
import { type ApplyPlan, applyRun } from "../src/write.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeVector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_v, i) => seed + i * 0.001);
}

async function seedDoc(
  db: Client,
  docId: string,
  rootId: string,
  versionKey: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO documents (
            doc_id, root_id, path, topic_key, version_key, sha256,
            status, status_confidence, last_seen_run
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      docId,
      rootId,
      "a.pdf",
      "",
      versionKey,
      `sha-${versionKey}`,
      "active",
      "high",
      "old",
    ],
  });
}

async function seedChunk(
  db: Client,
  chunkId: string,
  docId: string,
  versionKey: string,
  text: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO chunks (
            chunk_id, doc_id, page, idx, char_start, char_end, text,
            version_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [chunkId, docId, 1, 0, 0, text.length, text, versionKey],
  });
  await db.execute({
    sql: "INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)",
    args: [chunkId, text],
  });
}

test("pruned docs remove their chunk vectors and rows", async () => {
  const db = await openDb(":memory:");
  try {
    await seedDoc(db, "d1", "R", "v1");
    await seedChunk(db, "d1:1:0", "d1", "v1", "old text");

    const deleted: string[][] = [];
    const store: VectorStore = {
      upsert: async () => {},
      deleteByIds: async (ids) => {
        deleted.push(ids);
      },
    };

    await applyRun(
      db,
      store,
      { unchanged: [], newVersion: [], moved: [], added: [], pruned: ["d1"] },
      new Map(),
      new Map(),
      { byDoc: {}, supersedes: [] },
      "run1",
      "R",
      "/root",
      "2025-01-01T00:00:00Z",
    );

    expect(deleted).toEqual([["d1:1:0"]]);

    const docs = await db.execute({
      sql: "SELECT doc_id FROM documents WHERE doc_id = ?",
      args: ["d1"],
    });
    expect(docs.rows).toHaveLength(0);

    const chunks = await db.execute({
      sql: "SELECT chunk_id FROM chunks WHERE chunk_id = ?",
      args: ["d1:1:0"],
    });
    expect(chunks.rows).toHaveLength(0);

    const fts = await db.execute({
      sql: "SELECT chunk_id FROM chunks_fts WHERE chunk_id = ?",
      args: ["d1:1:0"],
    });
    expect(fts.rows).toHaveLength(0);

    const log = await db.execute({
      sql: "SELECT run_id, finished_at FROM ingest_log WHERE run_id = ?",
      args: ["run1"],
    });
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].finished_at).toBeTruthy();
  } finally {
    db.close();
  }
});

test("added docs write rows, chunks, FTS and read_error", async () => {
  const db = await openDb(":memory:");
  try {
    const upserted: Array<
      Array<{ id: string; values: number[]; metadata: { docId: string } }>
    > = [];
    const store: VectorStore = {
      upsert: async (vectors) => {
        upserted.push(vectors);
      },
      deleteByIds: async () => {},
    };

    const chunk: Chunk = {
      chunkId: "d2:1:0",
      docId: "d2",
      page: 1,
      idx: 0,
      charStart: 0,
      charEnd: 4,
      text: "text",
    };
    const plan: ApplyPlan = {
      unchanged: [],
      newVersion: [],
      moved: [],
      added: [
        {
          file: { path: "sop/a.pdf", versionKey: "v2", sha256: "sha2" },
          isDuplicate: false,
          docId: "d2",
          parsed: { pages: [], unreadable: true, reason: "no-text-layer" },
          dates: {
            docId: "d2",
            topicKey: "sop",
            raw: [],
            isLampiran: false,
          },
        },
      ],
      pruned: [],
    };
    const chunksByDoc = new Map<string, Chunk[]>([["d2", [chunk]]]);
    const vectors = new Map<string, number[]>([["d2:1:0", fakeVector(0.1)]]);

    await applyRun(
      db,
      store,
      plan,
      chunksByDoc,
      vectors,
      {
        byDoc: {
          d2: { status: "unparsable", statusConfidence: "low", alternates: [] },
        },
        supersedes: [],
      },
      "run2",
      "R",
      "/root",
      "2025-01-01T00:00:00Z",
    );

    const docs = await db.execute({
      sql: "SELECT * FROM documents WHERE doc_id = ?",
      args: ["d2"],
    });
    expect(docs.rows).toHaveLength(1);
    expect(docs.rows[0].read_error).toBe("no-text-layer");
    expect(docs.rows[0].path).toBe("sop/a.pdf");
    expect(docs.rows[0].topic_key).toBe("sop");
    expect(docs.rows[0].is_duplicate).toBe(0);

    const chunks = await db.execute({
      sql: "SELECT text FROM chunks WHERE chunk_id = ?",
      args: ["d2:1:0"],
    });
    expect(chunks.rows).toHaveLength(0);

    const fts = await db.execute({
      sql: "SELECT text FROM chunks_fts WHERE chunk_id = ?",
      args: ["d2:1:0"],
    });
    expect(fts.rows).toHaveLength(0);

    expect(upserted).toEqual([]);
  } finally {
    db.close();
  }
});

test("newVersion replaces chunks and updates read_error", async () => {
  const db = await openDb(":memory:");
  try {
    await seedDoc(db, "d1", "R", "v1");
    await seedChunk(db, "d1:1:0", "d1", "v1", "old text");

    const deleted: string[][] = [];
    const upserted: Array<
      Array<{ id: string; values: number[]; metadata: { docId: string } }>
    > = [];
    const store: VectorStore = {
      upsert: async (vectors) => {
        upserted.push(vectors);
      },
      deleteByIds: async (ids) => {
        deleted.push(ids);
      },
    };

    const chunk: Chunk = {
      chunkId: "d1:1:0",
      docId: "d1",
      page: 1,
      idx: 0,
      charStart: 0,
      charEnd: 8,
      text: "new text",
    };
    const plan: ApplyPlan = {
      unchanged: [],
      newVersion: [
        {
          docId: "d1",
          file: { path: "a.pdf", versionKey: "v2", sha256: "sha2" },
          parsed: { pages: [{ page: 1, text: "new text" }], unreadable: false },
          dates: {
            docId: "d1",
            topicKey: "",
            raw: [],
            isLampiran: false,
          },
        },
      ],
      moved: [],
      added: [],
      pruned: [],
    };
    const chunksByDoc = new Map<string, Chunk[]>([["d1", [chunk]]]);
    const vectors = new Map<string, number[]>([["d1:1:0", fakeVector(0.3)]]);

    await applyRun(
      db,
      store,
      plan,
      chunksByDoc,
      vectors,
      {
        byDoc: {
          d1: { status: "active", statusConfidence: "high", alternates: [] },
        },
        supersedes: [],
      },
      "run3",
      "R",
      "/root",
      "2025-01-01T00:00:00Z",
    );

    expect(deleted).toEqual([]);
    expect(upserted).toEqual([
      [{ id: "d1:1:0", values: fakeVector(0.3), metadata: { docId: "d1" } }],
    ]);

    const docs = await db.execute({
      sql: "SELECT version_key, read_error FROM documents WHERE doc_id = ?",
      args: ["d1"],
    });
    expect(docs.rows).toHaveLength(1);
    expect(docs.rows[0].version_key).toBe("v2");
    expect(docs.rows[0].read_error).toBeNull();

    const chunks = await db.execute({
      sql: "SELECT text FROM chunks WHERE chunk_id = ?",
      args: ["d1:1:0"],
    });
    expect(chunks.rows).toHaveLength(1);
    expect(chunks.rows[0].text).toBe("new text");

    const fts = await db.execute({
      sql: "SELECT text FROM chunks_fts WHERE chunk_id = ?",
      args: ["d1:1:0"],
    });
    expect(fts.rows).toHaveLength(1);
    expect(fts.rows[0].text).toBe("new text");
  } finally {
    db.close();
  }
});

test("embedTexts rejects an empty key without a network call", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(embedTexts(["a"], "")).rejects.toThrow("OPENROUTER_API_KEY");
    await expect(embedTexts(["a"], "   ")).rejects.toThrow(
      "OPENROUTER_API_KEY",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("embedTexts batches up to 96 texts and keeps order", async () => {
  const calls: string[][] = [];
  const fetchMock = vi.fn(
    async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      calls.push(body.input);
      return new Response(
        JSON.stringify({
          data: body.input.map((_text, index) => ({
            embedding: [index, index + 1],
            index,
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const texts = Array.from({ length: 97 }, (_v, i) => `t${i}`);
    const result = await embedTexts(texts, "key");
    expect(calls.map((batch) => batch.length)).toEqual([96, 1]);
    expect(result).toHaveLength(97);
    expect(result[0]).toEqual([0, 1]);
    expect(result[95]).toEqual([95, 96]);
    expect(result[96]).toEqual([0, 1]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("applyRun throws on vector length mismatch before any write", async () => {
  const db = await openDb(":memory:");
  try {
    const upserted: unknown[] = [];
    const deleted: string[][] = [];
    const store: VectorStore = {
      upsert: async (vectors) => {
        upserted.push(vectors);
      },
      deleteByIds: async (ids) => {
        deleted.push(ids);
      },
    };
    const chunk: Chunk = {
      chunkId: "d3:1:0",
      docId: "d3",
      page: 1,
      idx: 0,
      charStart: 0,
      charEnd: 4,
      text: "text",
    };
    const plan: ApplyPlan = {
      unchanged: [],
      newVersion: [],
      moved: [],
      added: [
        {
          file: { path: "a.pdf", versionKey: "v3", sha256: "sha3" },
          isDuplicate: false,
          docId: "d3",
          parsed: { pages: [{ page: 1, text: "text" }], unreadable: false },
          dates: { docId: "d3", topicKey: "", raw: [], isLampiran: false },
        },
      ],
      pruned: [],
    };

    await expect(
      applyRun(
        db,
        store,
        plan,
        new Map([["d3", [chunk]]]),
        new Map([["d3:1:0", [0.1, 0.2]]]),
        { byDoc: {}, supersedes: [] },
        "run4",
        "R",
        "/root",
        "2025-01-01T00:00:00Z",
      ),
    ).rejects.toThrow("1536");

    expect(upserted).toHaveLength(0);
    expect(deleted).toHaveLength(0);

    const docs = await db.execute({
      sql: "SELECT doc_id FROM documents",
      args: [],
    });
    expect(docs.rows).toHaveLength(0);
    const chunks = await db.execute({
      sql: "SELECT chunk_id FROM chunks",
      args: [],
    });
    expect(chunks.rows).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("newVersion shrink deletes only dropped chunk IDs after batch success", async () => {
  const db = await openDb(":memory:");
  try {
    await seedDoc(db, "d1", "R", "v1");
    await seedChunk(db, "d1:1:0", "d1", "v1", "old 0");
    await seedChunk(db, "d1:1:1", "d1", "v1", "old 1");

    const deleted: string[][] = [];
    const upserted: unknown[] = [];
    const store: VectorStore = {
      upsert: async (vectors) => {
        upserted.push(vectors);
      },
      deleteByIds: async (ids) => {
        deleted.push(ids);
      },
    };

    const chunk: Chunk = {
      chunkId: "d1:1:0",
      docId: "d1",
      page: 1,
      idx: 0,
      charStart: 0,
      charEnd: 5,
      text: "new 0",
    };
    const plan: ApplyPlan = {
      unchanged: [],
      newVersion: [
        {
          docId: "d1",
          file: { path: "a.pdf", versionKey: "v2", sha256: "sha2" },
          parsed: { pages: [{ page: 1, text: "new 0" }], unreadable: false },
          dates: { docId: "d1", topicKey: "", raw: [], isLampiran: false },
        },
      ],
      moved: [],
      added: [],
      pruned: [],
    };

    await applyRun(
      db,
      store,
      plan,
      new Map([["d1", [chunk]]]),
      new Map([["d1:1:0", fakeVector(0.3)]]),
      {
        byDoc: {
          d1: { status: "active", statusConfidence: "high", alternates: [] },
        },
        supersedes: [],
      },
      "run5",
      "R",
      "/root",
      "2025-01-01T00:00:00Z",
    );

    expect(deleted).toEqual([["d1:1:1"]]);
    expect(upserted).toHaveLength(1);

    const dropped = await db.execute({
      sql: "SELECT chunk_id FROM chunks WHERE chunk_id = ?",
      args: ["d1:1:1"],
    });
    expect(dropped.rows).toHaveLength(0);

    const db2 = await openDb(":memory:");
    try {
      await seedDoc(db2, "d1", "R", "v1");
      await seedChunk(db2, "d1:1:0", "d1", "v1", "old 0");
      await seedChunk(db2, "d1:1:1", "d1", "v1", "old 1");

      const deletedAfterFailure: string[][] = [];
      const storeFail: VectorStore = {
        upsert: async () => {},
        deleteByIds: async (ids) => {
          deletedAfterFailure.push(ids);
        },
      };
      const failingDb = {
        execute: db2.execute.bind(db2),
        batch: async () => {
          throw new Error("batch failed");
        },
      } as unknown as Client;

      await expect(
        applyRun(
          failingDb,
          storeFail,
          plan,
          new Map([["d1", [chunk]]]),
          new Map([["d1:1:0", fakeVector(0.3)]]),
          {
            byDoc: {
              d1: {
                status: "active",
                statusConfidence: "high",
                alternates: [],
              },
            },
            supersedes: [],
          },
          "run6",
          "R",
          "/root",
          "2025-01-01T00:00:00Z",
        ),
      ).rejects.toThrow("batch failed");

      expect(deletedAfterFailure).toHaveLength(0);
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }
});
