import { describe, expect, test } from "vitest";
import { matchFiles } from "../src/identity";

describe("matchFiles", () => {
  test("rename with same bytes is a move, keeps doc_id", () => {
    const plan = matchFiles(
      [{ doc_id: "d1", root_id: "R", path: "a/old.docx", version_key: "v1" }],
      [{ path: "a/new.docx", versionKey: "v1", sha256: "v1" }],
      "R",
    );
    expect(plan.moved).toEqual([
      {
        docId: "d1",
        oldPath: "a/old.docx",
        file: expect.objectContaining({ path: "a/new.docx" }),
      },
    ]);
    expect(plan.pruned).toEqual([]);
    expect(plan.added).toEqual([]);
  });

  test("rows from another root are never pruned", () => {
    const plan = matchFiles(
      [{ doc_id: "d2", root_id: "OTHER", path: "x.pdf", version_key: "v9" }],
      [],
      "R",
    );
    expect(plan.pruned).toEqual([]);
  });

  test("same path, changed bytes is newVersion", () => {
    const plan = matchFiles(
      [{ doc_id: "d1", root_id: "R", path: "a.docx", version_key: "v1" }],
      [{ path: "a.docx", versionKey: "v2", sha256: "v2" }],
      "R",
    );
    expect(plan.newVersion.map((n) => n.docId)).toEqual(["d1"]);
  });

  test("second identical file in one run is a duplicate", () => {
    const plan = matchFiles(
      [],
      [
        { path: "a.docx", versionKey: "v1", sha256: "v1" },
        { path: "b.docx", versionKey: "v1", sha256: "v1" },
      ],
      "R",
    );
    expect(plan.added).toEqual([
      { file: expect.objectContaining({ path: "a.docx" }), isDuplicate: false },
      { file: expect.objectContaining({ path: "b.docx" }), isDuplicate: true },
    ]);
  });

  test("same path and same bytes is unchanged", () => {
    const plan = matchFiles(
      [{ doc_id: "d1", root_id: "R", path: "a.docx", version_key: "v1" }],
      [{ path: "a.docx", versionKey: "v1", sha256: "v1" }],
      "R",
    );
    expect(plan.unchanged).toEqual(["d1"]);
    expect(plan.newVersion).toEqual([]);
    expect(plan.moved).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.pruned).toEqual([]);
  });

  test("path match takes priority over move match", () => {
    const plan = matchFiles(
      [{ doc_id: "d1", root_id: "R", path: "a.docx", version_key: "v1" }],
      [
        { path: "b.docx", versionKey: "v1", sha256: "v1" },
        { path: "a.docx", versionKey: "v2", sha256: "v2" },
      ],
      "R",
    );
    expect(plan.newVersion).toEqual([
      { docId: "d1", file: expect.objectContaining({ path: "a.docx" }) },
    ]);
    expect(plan.moved).toEqual([]);
    expect(plan.added).toEqual([
      { file: expect.objectContaining({ path: "b.docx" }), isDuplicate: false },
    ]);
    expect(plan.pruned).toEqual([]);
  });

  test("a file matching a row from another root is added, not moved", () => {
    const plan = matchFiles(
      [{ doc_id: "d2", root_id: "OTHER", path: "x.pdf", version_key: "v9" }],
      [{ path: "y.pdf", versionKey: "v9", sha256: "v9" }],
      "R",
    );
    expect(plan.added).toEqual([
      { file: expect.objectContaining({ path: "y.pdf" }), isDuplicate: false },
    ]);
    expect(plan.moved).toEqual([]);
    expect(plan.pruned).toEqual([]);
  });

  test("mixed plan: unchanged, moved, added, pruned", () => {
    const plan = matchFiles(
      [
        { doc_id: "d1", root_id: "R", path: "a.docx", version_key: "v1" },
        { doc_id: "d2", root_id: "R", path: "b.docx", version_key: "v2" },
        { doc_id: "d3", root_id: "R", path: "c.docx", version_key: "v3" },
      ],
      [
        { path: "a.docx", versionKey: "v1", sha256: "v1" },
        { path: "x.docx", versionKey: "v2", sha256: "v2" },
        { path: "d.docx", versionKey: "v4", sha256: "v4" },
      ],
      "R",
    );
    expect(plan.unchanged).toEqual(["d1"]);
    expect(plan.newVersion).toEqual([]);
    expect(plan.moved).toEqual([
      {
        docId: "d2",
        oldPath: "b.docx",
        file: expect.objectContaining({ path: "x.docx" }),
      },
    ]);
    expect(plan.added).toEqual([
      { file: expect.objectContaining({ path: "d.docx" }), isDuplicate: false },
    ]);
    expect(plan.pruned).toEqual(["d3"]);
  });

  test("a file matching an already matched row is added", () => {
    const plan = matchFiles(
      [{ doc_id: "d1", root_id: "R", path: "a.docx", version_key: "v1" }],
      [
        { path: "a.docx", versionKey: "v1", sha256: "v1" },
        { path: "b.docx", versionKey: "v1", sha256: "v1" },
      ],
      "R",
    );
    expect(plan.unchanged).toEqual(["d1"]);
    expect(plan.moved).toEqual([]);
    expect(plan.added).toEqual([
      { file: expect.objectContaining({ path: "b.docx" }), isDuplicate: true },
    ]);
    expect(plan.pruned).toEqual([]);
  });

  test("only later files with an already-seen version are duplicates", () => {
    const plan = matchFiles(
      [],
      [
        { path: "a.docx", versionKey: "v1", sha256: "v1" },
        { path: "b.docx", versionKey: "v2", sha256: "v2" },
        { path: "c.docx", versionKey: "v1", sha256: "v1" },
      ],
      "R",
    );
    expect(plan.added).toEqual([
      { file: expect.objectContaining({ path: "a.docx" }), isDuplicate: false },
      { file: expect.objectContaining({ path: "b.docx" }), isDuplicate: false },
      { file: expect.objectContaining({ path: "c.docx" }), isDuplicate: true },
    ]);
  });
});
