import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { UnsupportedFormatError, parseFile } from "../src/parse";

// Resolve fixtures relative to this file so the test works from any CWD.
const corpus = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));
const digital = join(corpus, "digital.pdf");
const noText = join(corpus, "no-text.pdf");
const restricted = join(corpus, "copy-restricted.pdf");

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("parseFile", () => {
  test("digital pdf yields pages with text", async () => {
    const doc = await parseFile(digital);
    expect(doc.unreadable).toBe(false);
    expect(doc.reason).toBeUndefined();
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0].page).toBe(1);
    expect(doc.pages[0].text).toContain("Digital fixture page one");
    expect(doc.pages[1].text).toContain("Digital fixture page two");
  });

  test("pdf with no text layer is flagged, not indexed as empty", async () => {
    const doc = await parseFile(noText);
    expect(doc.unreadable).toBe(true);
    expect(doc.reason).toBe("no-text-layer");
    // The empty page is kept so the document's page structure survives.
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].page).toBe(1);
    expect(doc.pages[0].text.trim()).toBe("");
  });

  test("copy-restricted pdf is flagged unreadable and returns no text", async () => {
    const doc = await parseFile(restricted);
    expect(doc.unreadable).toBe(true);
    expect(doc.reason).toBe("copy-restricted");
    // The text layer exists but copying is not permitted; never return it.
    expect(doc.pages).toEqual([]);
  });

  test("non-pdf path throws UnsupportedFormatError", async () => {
    await expect(parseFile(join(corpus, "one.docx"))).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });

  test("corrupt pdf is flagged parse-failed and logs the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parse-test-"));
    tempDirs.push(dir);
    const corrupt = join(dir, "broken.pdf");
    await writeFile(corrupt, "this is not a pdf");

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = await parseFile(corrupt);

    expect(doc.unreadable).toBe(true);
    expect(doc.reason).toBe("parse-failed");
    expect(doc.pages).toEqual([]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("broken.pdf"));
  });

  test("explicit minTextChars overrides the configured threshold", async () => {
    const doc = await parseFile(digital, 10_000);
    expect(doc.unreadable).toBe(true);
    expect(doc.reason).toBe("no-text-layer");
  });

  test("the default minTextChars comes from loadConfig", async () => {
    const previous = process.env.MIN_TEXT_CHARS;
    process.env.MIN_TEXT_CHARS = "10000";
    try {
      const doc = await parseFile(digital);
      expect(doc.unreadable).toBe(true);
      expect(doc.reason).toBe("no-text-layer");
    } finally {
      if (previous === undefined) delete process.env.MIN_TEXT_CHARS;
      else process.env.MIN_TEXT_CHARS = previous;
    }
  });
});
