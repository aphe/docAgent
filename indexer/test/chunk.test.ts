import { expect, test } from "vitest";
import { chunkDoc } from "../src/chunk.js";
import type { ParsedDoc } from "../src/parse/index.js";

test("chunk ids are doc_id:page:index and offsets map back into page text", () => {
  const chunks = chunkDoc(
    "d1",
    { pages: [{ page: 1, text: "A".repeat(10) }], unreadable: false },
    { maxChars: 4 },
  );
  expect(chunks.map((c) => c.chunkId)).toEqual(["d1:1:0", "d1:1:1", "d1:1:2"]);
  expect(chunks[1].charStart).toBe(4);
  expect(chunks[1].charEnd).toBe(8);
  expect(chunks.map((c) => c.text)).toEqual(["AAAA", "AAAA", "AA"]);
});

test("unreadable doc returns empty array", () => {
  const doc: ParsedDoc = { pages: [], unreadable: true };
  expect(chunkDoc("d2", doc, { maxChars: 4 })).toEqual([]);
});

test("empty page text produces no chunks", () => {
  const doc: ParsedDoc = {
    pages: [{ page: 1, text: "" }],
    unreadable: false,
  };
  expect(chunkDoc("d3", doc, { maxChars: 4 })).toEqual([]);
});

test("multiple pages produce independent indices", () => {
  const doc: ParsedDoc = {
    pages: [
      { page: 1, text: "A".repeat(5) },
      { page: 2, text: "B".repeat(3) },
    ],
    unreadable: false,
  };
  const chunks = chunkDoc("d4", doc, { maxChars: 4 });
  expect(chunks.map((c) => c.chunkId)).toEqual(["d4:1:0", "d4:1:1", "d4:2:0"]);
  expect(chunks.map((c) => c.page)).toEqual([1, 1, 2]);
  expect(chunks.map((c) => c.idx)).toEqual([0, 1, 0]);
  expect(chunks.map((c) => c.text)).toEqual(["AAAA", "A", "BBB"]);
  expect(chunks.map((c) => [c.charStart, c.charEnd])).toEqual([
    [0, 4],
    [4, 5],
    [0, 3],
  ]);
});
