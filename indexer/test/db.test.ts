import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openDb } from "../src/db";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function makeDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docs-agent-db-"));
  tempDirs.push(dir);
  return join(dir, "nested", "test.db");
}

async function tableNames(dbPath: string): Promise<string[]> {
  const client = await openDb(dbPath);
  try {
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    return result.rows.map((row) => String(row.name));
  } finally {
    client.close();
  }
}

test("openDb creates a file database with every required table", async () => {
  const dbPath = await makeDbPath();
  const client = await openDb(dbPath);
  try {
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = result.rows.map((row) => String(row.name));
    for (const table of [
      "documents",
      "chunks",
      "chunks_fts",
      "chunk_vectors",
      "supersedes",
      "ingest_log",
    ]) {
      expect(names).toContain(table);
    }
  } finally {
    client.close();
  }
});

test("openDb creates the vector index", async () => {
  const dbPath = await makeDbPath();
  const client = await openDb(dbPath);
  try {
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'chunk_vectors_idx'",
    );
    expect(result.rows).toHaveLength(1);
  } finally {
    client.close();
  }
});

test("openDb is idempotent", async () => {
  const dbPath = await makeDbPath();
  const first = await openDb(dbPath);
  first.close();
  expect(await tableNames(dbPath)).toEqual(
    expect.arrayContaining(["documents", "chunks_fts"]),
  );
  const second = await openDb(dbPath);
  second.close();
});
