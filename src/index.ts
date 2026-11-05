import "dotenv/config";
import { VoltAgent, VoltOpsClient, Memory, VoltAgentObservability } from "@voltagent/core";
import { LibSQLMemoryAdapter, LibSQLObservabilityAdapter } from "@voltagent/libsql";
import { createPinoLogger } from "@voltagent/logger";
import { honoServer } from "@voltagent/server-hono";
import { DEFAULT_DB_PATH } from "../indexer/src/config";
import { openDb } from "../indexer/src/db";
import { checkPolishedTags } from "./agent/tag-check";
import { createDocAgent, getLastCitedLabels, resetLastCitedLabels } from "./agent/doc-agent";
import { stripProviderMetadataFromSSE } from "./streaming/strip-provider-metadata";
import { createQueryHandler } from "./query/route";

// Create a logger instance
const logger = createPinoLogger({
  name: "docAgent",
  level: "info",
});

// Configure persistent memory (LibSQL / SQLite)
const memory = new Memory({
  storage: new LibSQLMemoryAdapter({
    url: "file:./.voltagent/memory.db",
    logger: logger.child({ component: "libsql" }),
  }),
});

// Configure persistent observability (LibSQL / SQLite)
const observability = new VoltAgentObservability({
  storage: new LibSQLObservabilityAdapter({
    url: "file:./.voltagent/observability.db",
  }),
});

const db = await openDb(process.env.DB_PATH ?? DEFAULT_DB_PATH);
const key = process.env.OPENROUTER_API_KEY ?? "";

const agent = createDocAgent(db, memory, { key });

new VoltAgent({
  agents: {
    agent,
  },
  server: honoServer({
    configureFullApp: ({ app, routes, middlewares }) => {
      middlewares.cors();
      middlewares.auth();
      middlewares.landingPage();
      // VoltOps console cannot validate providerMetadata on stream chunks.
      // Must be registered before routes.agents() to wrap agent routes.
      app.use("/agents/*", async (c, next) => {
        if (c.req.path === "/agents/docAgent/text") resetLastCitedLabels();
        await next();
        const contentType = c.res.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream") && c.res.body) {
          c.res = new Response(stripProviderMetadataFromSSE(c.res.body), {
            status: c.res.status,
            headers: c.res.headers,
          });
        }
        if (c.req.path === "/agents/docAgent/text" && contentType.includes("application/json")) {
          const body = (await c.res.clone().json()) as { data?: { text?: unknown } };
          if (typeof body.data?.text === "string") {
            const tagCheck = checkPolishedTags(body.data.text, getLastCitedLabels());
            if (tagCheck.status === "mismatch") logger.warn(`polish citation drift on ${c.req.path}: ${JSON.stringify(tagCheck)}`);
            const headers = new Headers(c.res.headers);
            headers.delete("content-length");
            c.res = new Response(JSON.stringify({ ...body, data: { ...body.data, tagCheck } }), {
              status: c.res.status,
              headers,
            });
          }
        }
      });
      routes.agents();
      routes.workflows();
      routes.logs();
      routes.updates();
      routes.observability();
      routes.memory();
      routes.tools();
      routes.triggers();
      routes.mcp();
      routes.a2a();
      routes.doc();
      routes.ui();
      app.post("/query", createQueryHandler(db, { key }));
    },
  }),
  logger,
  observability,
  voltOpsClient: new VoltOpsClient({
    publicKey: process.env.VOLTAGENT_PUBLIC_KEY || "",
    secretKey: process.env.VOLTAGENT_SECRET_KEY || "",
  }),
});
