import "dotenv/config";
import { VoltAgent, VoltOpsClient, Agent, Memory, VoltAgentObservability } from "@voltagent/core";
import { LibSQLMemoryAdapter, LibSQLObservabilityAdapter } from "@voltagent/libsql";
import { createPinoLogger } from "@voltagent/logger";
import { honoServer } from "@voltagent/server-hono";
import { DEFAULT_DB_PATH } from "../indexer/src/config";
import { openDb } from "../indexer/src/db";
import { createQueryHandler } from "./query/route";
import { expenseApprovalWorkflow } from "./workflows";
import { weatherTool } from "./tools";

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

const agent = new Agent({
  name: "docAgent",
  instructions: "A helpful assistant that can check weather and help with various tasks",
  model: "openai/gpt-4o-mini",
  tools: [weatherTool],
  memory,
});

const db = await openDb(process.env.DB_PATH ?? DEFAULT_DB_PATH);

new VoltAgent({
  agents: {
    agent,
  },
  workflows: {
    expenseApprovalWorkflow,
  },
  server: honoServer({
    configureApp: (app) => {
      app.post(
        "/query",
        createQueryHandler(db, { key: process.env.OPENROUTER_API_KEY ?? "" }),
      );
    },
  }),
  logger,
  observability,
  voltOpsClient: new VoltOpsClient({
    publicKey: process.env.VOLTAGENT_PUBLIC_KEY || "",
    secretKey: process.env.VOLTAGENT_SECRET_KEY || "",
  }),
});
