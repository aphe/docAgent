import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { measureCorpus } from "../src/measure";

// Resolve fixtures relative to this file so the test works from any CWD.
const corpusRoot = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));

test("counts extensions and reports no-text-layer share", async () => {
  const r = await measureCorpus(corpusRoot, { sampleLimit: 10 });
  expect(r.byExtension[".docx"]).toBe(1);
  expect(r.byExtension[".pdf"]).toBe(3);
  expect(r.pdfSampled).toBe(3);
  expect(r.noTextLayerPdfs).toBe(1);
  expect(r.noTextLayerShare).toBeCloseTo(1 / 3);
});

test("skips hidden files and hidden directories", async () => {
  const r = await measureCorpus(corpusRoot, { sampleLimit: 10 });
  expect(r.totalFiles).toBe(4);
});

test("respects the sample limit", async () => {
  const r = await measureCorpus(corpusRoot, { sampleLimit: 2 });
  expect(r.pdfSampled).toBe(2);
  expect(r.avgPagesPerPdf).toBeGreaterThan(0);
});
