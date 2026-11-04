#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { measureCorpus } from "./measure.js";

const [command, root] = process.argv.slice(2);

if (command !== "measure" || !root) {
  console.error("usage: cli.ts measure <root>");
  process.exit(1);
}

const info = await stat(root).catch(() => null);
if (!info?.isDirectory()) {
  console.error(`Not a directory: ${root}`);
  process.exit(1);
}

try {
  const report = await measureCorpus(root);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
