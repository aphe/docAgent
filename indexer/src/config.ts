import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

export interface Config {
  root: string;
  rootId: string;
  openrouterKey: string;
  dbPath: string;
  minTextChars: number;
}

const DEFAULT_DB_PATH = "data/docs-agent.db";
const DEFAULT_MIN_TEXT_CHARS = 20;
const SCRIPT_NAMES: Record<string, true> = {
  node: true,
  tsx: true,
  "ts-node": true,
  vitest: true,
};
const COMMANDS: Record<string, true> = { index: true, measure: true };
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s)$/;

/**
 * Stable identifier for a corpus root: the hex sha256 of its absolute path.
 * Resolving first makes a relative root and its absolute form share an id.
 */
export function rootId(absRoot: string): string {
  return createHash("sha256").update(resolve(absRoot)).digest("hex");
}

/**
 * Reads the indexer configuration from CLI arguments and the environment.
 *
 * `argv` is the argument vector after the Node executable and script path
 * (i.e. `process.argv.slice(2)`); a full `process.argv` is also tolerated.
 * The first non-flag argument after an optional `index`/`measure` command is
 * the required root. Environment overrides: `MIN_TEXT_CHARS`, `DB_PATH`,
 * `OPENROUTER_API_KEY`.
 *
 * @throws if no root argument is supplied.
 */
export function loadConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): Config {
  const rootArg = findRoot(argv);
  if (!rootArg) {
    throw new Error(
      "Missing required root argument. Usage: indexer <root> [--dry-run]",
    );
  }

  const root = resolve(rootArg);
  const minTextChars = parsePositiveInt(
    env.MIN_TEXT_CHARS,
    DEFAULT_MIN_TEXT_CHARS,
  );

  return {
    root,
    rootId: rootId(root),
    openrouterKey: env.OPENROUTER_API_KEY ?? "",
    dbPath: env.DB_PATH ?? DEFAULT_DB_PATH,
    minTextChars,
  };
}

function findRoot(argv: string[]): string | undefined {
  let args = argv.slice();
  // Tolerate a full process.argv by dropping the runtime and script entries.
  while (
    args.length > 0 &&
    (SCRIPT_NAMES[basename(args[0])] === true || SCRIPT_EXTENSION.test(args[0]))
  ) {
    args = args.slice(1);
  }

  const commandIndex = args.findIndex((arg) => COMMANDS[arg] === true);
  const start = commandIndex >= 0 ? commandIndex + 1 : 0;
  for (let i = start; i < args.length; i++) {
    if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
