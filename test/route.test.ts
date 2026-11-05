import type { Client } from "@libsql/client";
import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { openDb } from "../indexer/src/db";
import { createQueryHandler } from "../src/query/route";

const clients: Client[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
});

function unitVector(index: number): number[] {
  const values = new Array<number>(1536).fill(0);
  values[index] = 1;
  return values;
}

const deps = {
  key: "test-key",
  embed: async () => [unitVector(0)],
};

async function makeApp(): Promise<Hono> {
  const db = await openDb(":memory:");
  clients.push(db);
  const app = new Hono();
  app.post("/query", createQueryHandler(db, deps));
  return app;
}

async function postJson(app: Hono, body: string): Promise<Response> {
  return app.request("/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

test("invalid JSON returns 400", async () => {
  const app = await makeApp();
  const response = await postJson(app, "{");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Body must be valid JSON" });
});

test("missing query returns 400", async () => {
  const app = await makeApp();
  const response = await postJson(app, JSON.stringify({ mode: "answer" }));
  expect(response.status).toBe(400);
});

test("bad mode returns 400", async () => {
  const app = await makeApp();
  const response = await postJson(
    app,
    JSON.stringify({ query: "cuti", mode: "summary" }),
  );
  expect(response.status).toBe(400);
});

test("query over 2000 characters returns 400", async () => {
  const app = await makeApp();
  const response = await postJson(
    app,
    JSON.stringify({ query: "a".repeat(2001), mode: "answer" }),
  );
  expect(response.status).toBe(400);
});

test("valid request returns 200 with the documented body shape", async () => {
  const app = await makeApp();
  const response = await postJson(
    app,
    JSON.stringify({ query: "cuti", mode: "answer" }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    "alternates",
    "citations",
    "text",
    "warnings",
  ]);
  expect(body.text).toMatch(/tidak ditemukan|no source/i);
});

test("internal errors return 500 without leaking upstream text", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const failingDb = {
    execute: async () => {
      throw new Error("secret upstream text");
    },
    close: () => {},
  } as unknown as Client;
  const app = new Hono();
  app.post("/query", createQueryHandler(failingDb, deps));

  const response = await postJson(
    app,
    JSON.stringify({ query: "cuti", mode: "answer" }),
  );
  expect(response.status).toBe(500);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ error: "query failed" });
  expect(body).not.toContain("secret upstream text");
});
