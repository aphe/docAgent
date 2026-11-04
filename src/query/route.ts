import type { Client } from "@libsql/client";
import type { Context } from "hono";
import { answer, type AnswerDeps } from "./answer";

const MODES: Record<string, true> = { answer: true, draft: true };
const MAX_QUERY_CHARS = 2000;

function badRequest(c: Context, message: string): Response {
  return c.json({ error: message }, 400);
}

/**
 * Builds the `POST /query` handler. The body is
 * `{ query: string, mode: "answer" | "draft" }`. Dependencies are injected so
 * tests and deployments can swap the embedding function.
 */
export function createQueryHandler(
  db: Client,
  deps: AnswerDeps = {},
): (c: Context) => Promise<Response> {
  return async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badRequest(c, "Body must be valid JSON");
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return badRequest(c, "Body must be a JSON object");
    }

    const { query, mode } = body as Record<string, unknown>;
    if (typeof query !== "string" || query.trim() === "") {
      return badRequest(c, "query must be a non-empty string");
    }
    if (query.length > MAX_QUERY_CHARS) {
      return badRequest(c, `query must be at most ${MAX_QUERY_CHARS} characters`);
    }
    if (typeof mode !== "string" || MODES[mode] !== true) {
      return badRequest(c, 'mode must be "answer" or "draft"');
    }

    try {
      const result = await answer(db, query.trim(), mode as "answer" | "draft", deps);
      return c.json(result);
    } catch (error) {
      console.error("query failed", error);
      return c.json({ error: "query failed" }, 500);
    }
  };
}
