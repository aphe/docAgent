import { describe, expect, test } from "vitest";
import { loadConfig, rootId } from "../src/config";

describe("rootId", () => {
  test("rootId is stable for the same absolute path and differs across paths", () => {
    expect(rootId("/a/b")).toBe(rootId("/a/b"));
    expect(rootId("/a/b")).not.toBe(rootId("/a/c"));
  });

  test("rootId is a 64-character hex sha256", () => {
    expect(rootId("/a/b")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("loadConfig", () => {
  test("throws when no root argument is given", () => {
    expect(() => loadConfig([], {})).toThrow(/root argument/i);
    expect(() => loadConfig(["index"], {})).toThrow(/root argument/i);
  });

  test("reads the root argument after the command", () => {
    const config = loadConfig(["index", "/tmp/corpus"], {});
    expect(config.root).toBe("/tmp/corpus");
    expect(config.rootId).toBe(rootId("/tmp/corpus"));
  });

  test("reads the root argument without a command", () => {
    expect(loadConfig(["/tmp/corpus"], {}).root).toBe("/tmp/corpus");
  });

  test("defaults dbPath and minTextChars", () => {
    const config = loadConfig(["index", "/tmp/corpus"], {});
    expect(config.dbPath).toBe("data/docs-agent.db");
    expect(config.minTextChars).toBe(20);
    expect(config.openrouterKey).toBe("");
  });

  test("allows environment overrides", () => {
    const config = loadConfig(["index", "/tmp/corpus"], {
      MIN_TEXT_CHARS: "5",
      DB_PATH: "custom/db.sqlite",
      OPENROUTER_API_KEY: "sk-test",
    });
    expect(config.minTextChars).toBe(5);
    expect(config.dbPath).toBe("custom/db.sqlite");
    expect(config.openrouterKey).toBe("sk-test");
  });

  test("ignores a full process.argv runtime and script prefix", () => {
    const config = loadConfig(
      ["/usr/bin/node", "/repo/indexer/src/cli.ts", "index", "/tmp/corpus"],
      {},
    );
    expect(config.root).toBe("/tmp/corpus");
  });
});
