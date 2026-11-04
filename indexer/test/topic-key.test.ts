import { describe, expect, test } from "vitest";
import { topicKeyFor } from "../src/topic-key.js";

describe("topicKeyFor", () => {
  test("copies of one SOP in different folders share a key", () => {
    const a = topicKeyFor(
      "OPR - Operation/20210908-RKI-P-OPR-010-SOP Perlindungan Konsumen.pdf",
    );
    const b = topicKeyFor(
      "NEW SOP/20260101-RKI-P-OPR-010-V04 - SOP Perlindungan Konsumen.pdf",
    );
    const c = topicKeyFor(
      "OPR - Operation/archive/20220906-RKI-P-OPR-010-V03-SOP_Perlindungan_Konsumen.pdf",
    );
    expect(a).toBe("perlindungan konsumen");
    expect(b).toBe("perlindungan konsumen");
    expect(c).toBe("perlindungan konsumen");
  });

  test("different titles get different keys", () => {
    expect(
      topicKeyFor("NEW SOP/20260101-RKI-P-OPR-010-V02 - SOP Pengembangan Open API.pdf"),
    ).not.toBe(topicKeyFor("OPR - Operation/20210908-RKI-P-OPR-010-SOP Perlindungan Konsumen.pdf"));
  });

  test("a file without a title falls back to the normalized name", () => {
    expect(topicKeyFor("lampiran.pdf")).toBe("lampiran");
  });
});
