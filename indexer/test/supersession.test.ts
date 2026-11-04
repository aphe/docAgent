import { describe, expect, test } from "vitest";
import { deriveSupersession } from "../src/supersession.js";

describe("deriveSupersession", () => {
  test("latest effective date is active, earlier is superseded", () => {
    const result = deriveSupersession([
      {
        docId: "a",
        topicKey: "sop",
        issued: "2024-01-01",
        effective: "2024-02-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "b",
        topicKey: "sop",
        issued: "2025-01-01",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
    ]);
    expect(result.byDoc.b).toEqual({
      status: "active",
      statusConfidence: "high",
      alternates: [],
    });
    expect(result.byDoc.a.status).toBe("superseded");
    expect(result.supersedes).toContainEqual({
      docId: "b",
      supersedesDocId: "a",
    });
  });

  test("equal latest effective date is low confidence with alternates", () => {
    const result = deriveSupersession([
      {
        docId: "a",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "b",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
    ]);
    expect(result.byDoc.a.statusConfidence).toBe("low");
    expect(result.byDoc.a.alternates).toEqual(["b"]);
    expect(result.byDoc.b.alternates).toEqual(["a"]);
    expect(result.supersedes).toEqual([]);
  });

  test("undated lampiran is unparsable, never newest", () => {
    const result = deriveSupersession([
      {
        docId: "a",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
      { docId: "l", topicKey: "sop", raw: [], isLampiran: true },
    ]);
    expect(result.byDoc.l).toEqual({
      status: "unparsable",
      statusConfidence: "low",
      alternates: [],
    });
    expect(result.byDoc.a.status).toBe("active");
  });

  test("lampiran with dates is still unparsable", () => {
    const result = deriveSupersession([
      {
        docId: "l",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: ["1 Februari 2025"],
        isLampiran: true,
      },
      {
        docId: "a",
        topicKey: "sop",
        effective: "2024-02-01",
        raw: [],
        isLampiran: false,
      },
    ]);
    expect(result.byDoc.l.status).toBe("unparsable");
    expect(result.byDoc.a.status).toBe("active");
  });

  test("tie among three documents lists the others", () => {
    const result = deriveSupersession([
      {
        docId: "a",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "b",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "c",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
    ]);
    expect(result.byDoc.a.statusConfidence).toBe("low");
    expect(result.byDoc.a.alternates).toEqual(["b", "c"]);
    expect(result.byDoc.b.alternates).toEqual(["a", "c"]);
    expect(result.byDoc.c.alternates).toEqual(["a", "b"]);
    expect(result.supersedes).toEqual([]);
  });

  test("a tie records edges to older documents from every tied winner", () => {
    const result = deriveSupersession([
      {
        docId: "a",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "b",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "old",
        topicKey: "sop",
        effective: "2024-01-01",
        raw: [],
        isLampiran: false,
      },
    ]);
    expect(result.byDoc.old.status).toBe("superseded");
    expect(result.supersedes).toContainEqual({
      docId: "a",
      supersedesDocId: "old",
    });
    expect(result.supersedes).toContainEqual({
      docId: "b",
      supersedesDocId: "old",
    });
    expect(result.supersedes).not.toContainEqual({
      docId: "a",
      supersedesDocId: "b",
    });
    expect(result.supersedes).not.toContainEqual({
      docId: "b",
      supersedesDocId: "a",
    });
    expect(result.supersedes).toHaveLength(2);
  });

  test("issued-date fallback winner with another effective date is low", () => {
    const result = deriveSupersession([
      {
        docId: "effective",
        topicKey: "sop",
        effective: "2024-02-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "issued",
        topicKey: "sop",
        issued: "2025-01-01",
        raw: [],
        isLampiran: false,
      },
    ]);
    expect(result.byDoc.issued.status).toBe("active");
    expect(result.byDoc.issued.statusConfidence).toBe("low");
    expect(result.byDoc.issued.alternates).toEqual(["effective"]);
    expect(result.byDoc.effective.status).toBe("superseded");
    expect(result.byDoc.effective.statusConfidence).toBe("low");
    expect(result.supersedes).toContainEqual({
      docId: "issued",
      supersedesDocId: "effective",
    });
  });

  test("a winner with only an issued date is low confidence", () => {
    const result = deriveSupersession([
      {
        docId: "old",
        topicKey: "sop",
        issued: "2024-01-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "new",
        topicKey: "sop",
        issued: "2025-01-01",
        raw: [],
        isLampiran: false,
      },
    ]);
    expect(result.byDoc.new.status).toBe("active");
    expect(result.byDoc.new.statusConfidence).toBe("low");
    expect(result.byDoc.new.alternates).toEqual(["old"]);
  });

  test("groups by topicKey and ranks each group independently", () => {
    const result = deriveSupersession([
      {
        docId: "sop-old",
        topicKey: "sop",
        effective: "2024-01-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "sop-new",
        topicKey: "sop",
        effective: "2025-01-01",
        raw: [],
        isLampiran: false,
      },
      {
        docId: "agreement",
        topicKey: "agreement",
        effective: "2024-06-01",
        raw: [],
        isLampiran: false,
      },
    ]);
    expect(result.byDoc["sop-new"].status).toBe("active");
    expect(result.byDoc["sop-old"].status).toBe("superseded");
    expect(result.byDoc.agreement.status).toBe("active");
    expect(result.byDoc.agreement.statusConfidence).toBe("high");
    expect(result.supersedes).toContainEqual({
      docId: "sop-new",
      supersedesDocId: "sop-old",
    });
    expect(result.supersedes).not.toContainEqual({
      docId: "sop-new",
      supersedesDocId: "agreement",
    });
  });

  test("single dated document is active without alternates", () => {
    const result = deriveSupersession([
      {
        docId: "only",
        topicKey: "sop",
        effective: "2025-02-01",
        raw: [],
        isLampiran: false,
      },
    ]);
    expect(result.byDoc.only).toEqual({
      status: "active",
      statusConfidence: "high",
      alternates: [],
    });
    expect(result.supersedes).toEqual([]);
  });

  test("all undated documents are unparsable", () => {
    const result = deriveSupersession([
      { docId: "a", topicKey: "sop", raw: [], isLampiran: false },
      { docId: "b", topicKey: "sop", raw: [], isLampiran: true },
    ]);
    expect(result.byDoc.a.status).toBe("unparsable");
    expect(result.byDoc.b.status).toBe("unparsable");
    expect(result.supersedes).toEqual([]);
  });
});
