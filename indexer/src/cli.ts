#!/usr/bin/env node
import { stat } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { embedTexts } from "./embed.js";
import {
  DEFAULT_CHUNK_MAX_CHARS,
  runIndex,
  scanPdfFiles,
} from "./index-run.js";
import { measureCorpus } from "./measure.js";
import { parseFile } from "./parse/index.js";
import { LibsqlVectorStore } from "./vector-store.js";

const USAGE = `usage:
  cli.ts measure <root>
  cli.ts index --root <root> [--dry-run]`;

interface IndexOptions {
  root: string;
  dryRun: boolean;
}

/**
 * `index` takes its root only through `--root <path>` (or `--root=<path>`),
 * so a folder literally named "index" or "measure" can never be mistaken for
 * the subcommand. `measure` keeps its positional root.
 */
function parseIndexArgs(args: string[]): IndexOptions {
  let root: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--root") {
      root = args[++i];
      if (root === undefined) throw new Error("--root requires a value");
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      if (root === "") throw new Error("--root requires a value");
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (root === undefined) throw new Error("--root is required");
  return { root, dryRun };
}

/**
 * A dry run must not create or modify the index database. When the database
 * does not exist yet it is treated as empty and opened in memory; an existing
 * database is opened normally and only read.
 */
async function openIndexDb(dbPath: string, dryRun: boolean): Promise<Client> {
  if (!dryRun) return openDb(dbPath);

  if (dbPath === ":memory:") return openDb(dbPath);

  const isPlainPath = !dbPath.startsWith("file:") && !dbPath.includes("://");
  if (isPlainPath) {
    const exists = await stat(dbPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) return openDb(":memory:");
    return openDb(dbPath, { readOnly: true });
  }

  // file: and remote URLs cannot be stat()ed; pass them straight to openDb
  // and skip the schema bootstrap so an existing database is never written.
  return openDb(dbPath, { readOnly: true });
}

async function runIndexCommand(options: IndexOptions): Promise<void> {
  const config = loadConfig(["index", "--root", options.root], process.env);

  const info = await stat(config.root).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`Not a directory: ${config.root}`);
  }

  const db = await openIndexDb(config.dbPath, options.dryRun);
  try {
    const summary = await runIndex({
      root: config.root,
      dryRun: options.dryRun,
      deps: {
        db,
        store: new LibsqlVectorStore(db),
        scan: scanPdfFiles,
        parse: parseFile,
        embed: embedTexts,
        minTextChars: config.minTextChars,
        chunkMaxChars: DEFAULT_CHUNK_MAX_CHARS,
        openrouterKey: config.openrouterKey,
      },
    });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    db.close();
  }
}

async function runMeasureCommand(root: string): Promise<void> {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }
  const report = await measureCorpus(root);
  console.log(JSON.stringify(report, null, 2));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === "index") {
    await runIndexCommand(parseIndexArgs(rest));
    return;
  }
  if (command === "measure" && rest.length === 1) {
    await runMeasureCommand(rest[0]);
    return;
  }

  console.error(USAGE);
  process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
