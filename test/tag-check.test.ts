import { describe, expect, it } from "vitest";
import { checkPolishedTags } from "../src/agent/tag-check";

describe("checkPolishedTags", () => {
  it("passes when the polished tag set equals the cited set", () => {
    const r = checkPolishedTags("Cuti diajukan dua hari kerja [a:1:0] dan disetujui [b:2:0].", ["a:1:0", "b:2:0"]);
    expect(r).toEqual({ status: "ok", missing: [], extra: [] });
  });

  it("reports a dropped citation", () => {
    const r = checkPolishedTags("Cuti diajukan [a:1:0].", ["a:1:0", "b:2:0"]);
    expect(r.status).toBe("mismatch");
    expect(r.missing).toEqual(["b:2:0"]);
  });

  it("reports an invented citation", () => {
    const r = checkPolishedTags("Cuti diajukan [a:1:0] [z:9:9].", ["a:1:0"]);
    expect(r.status).toBe("mismatch");
    expect(r.extra).toEqual(["z:9:9"]);
  });

  it("skipped only when the reply has no tags and nothing was cited", () => {
    const r = checkPolishedTags("Jawaban dari ingatan tanpa kutipan.", []);
    expect(r).toEqual({ status: "skipped", missing: [], extra: [] });
  });

  it("flags tags echoed from memory when no answer tool cited anything", () => {
    const r = checkPolishedTags("Jawaban dari ingatan [z:9:9].", []);
    expect(r.status).toBe("mismatch");
    expect(r.extra).toEqual(["z:9:9"]);
  });

  it("matches file-name labels that contain spaces and punctuation", () => {
    const label = "20260930-RKI-K-ITS-022-V03 - SOP Business Continuity Management_.pdf";
    const r = checkPolishedTags(`Pemulihan teknologi mengikuti DRP [${label}].`, [label]);
    expect(r).toEqual({ status: "ok", missing: [], extra: [] });
  });

  it("ignores page-number differences when the file matches", () => {
    const r = checkPolishedTags("Cuti diajukan [a.pdf, p. 5].", ["a.pdf, p. 2"]);
    expect(r).toEqual({ status: "ok", missing: [], extra: [] });
  });

  it("still reports a dropped file when page suffixes are present", () => {
    const r = checkPolishedTags("Cuti diajukan [a.pdf, p. 2].", ["a.pdf, p. 2", "b.pdf, p. 7"]);
    expect(r.status).toBe("mismatch");
    expect(r.missing).toEqual(["b.pdf"]);
  });

  it("still reports an invented file when page suffixes are present", () => {
    const r = checkPolishedTags("Cuti diajukan [a.pdf, p. 2] [z.pdf, p. 1].", ["a.pdf, p. 2"]);
    expect(r.status).toBe("mismatch");
    expect(r.extra).toEqual(["z.pdf"]);
  });

});
