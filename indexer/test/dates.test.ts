import { describe, expect, test } from "vitest";
import { extractDates } from "../src/dates.js";

describe("extractDates", () => {
  test("extracts an issued date from tanggal ditetapkan", () => {
    const result = extractDates(
      "Ditetapkan di Jakarta pada tanggal 15 Januari 2024.",
    );
    expect(result.issued).toBe("2024-01-15");
    expect(result.effective).toBeUndefined();
    expect(result.raw).toEqual(["15 Januari 2024"]);
    expect(result.isLampiran).toBe(false);
  });

  test("extracts an effective date from tanggal diundangkan", () => {
    const result = extractDates(
      "Diundangkan di Jakarta pada tanggal 20 Januari 2024.",
    );
    expect(result.effective).toBe("2024-01-20");
    expect(result.issued).toBeUndefined();
  });

  test("extracts an effective date from mulai berlaku", () => {
    const result = extractDates("Mulai berlaku pada tanggal 1 Februari 2024.");
    expect(result.effective).toBe("2024-02-01");
  });

  test("parses ISO numeric dates", () => {
    const result = extractDates(
      "Tanggal ditetapkan: 2024-01-15. Diundangkan: 2024-02-20.",
    );
    expect(result.issued).toBe("2024-01-15");
    expect(result.effective).toBe("2024-02-20");
    expect(result.raw).toEqual(["2024-01-15", "2024-02-20"]);
  });

  test("does not parse removed day-first and slash ISO formats", () => {
    const result = extractDates(
      "Ditetapkan pada 12/03/2024. Diundangkan pada 12-03-2024. ISO slash 2024/02/20.",
    );
    expect(result.issued).toBeUndefined();
    expect(result.effective).toBeUndefined();
    expect(result.raw).toEqual([]);
  });

  test("recognizes every Indonesian month name", () => {
    const months = [
      ["Januari", "01"],
      ["Februari", "02"],
      ["Maret", "03"],
      ["April", "04"],
      ["Mei", "05"],
      ["Juni", "06"],
      ["Juli", "07"],
      ["Agustus", "08"],
      ["September", "09"],
      ["Oktober", "10"],
      ["November", "11"],
      ["Desember", "12"],
    ] as const;
    for (const [name, month] of months) {
      const result = extractDates(`Ditetapkan pada tanggal 5 ${name} 2024.`);
      expect(result.issued).toBe(`2024-${month}-05`);
    }
  });

  test("flags a LAMPIRAN heading", () => {
    expect(extractDates("LAMPIRAN I\nDaftar isi").isLampiran).toBe(true);
    expect(extractDates("LAMPIRAN\r\nDaftar isi").isLampiran).toBe(true);
  });

  test("does not flag an inline mention of lampiran", () => {
    expect(extractDates("Lampiran ini memuat daftar.").isLampiran).toBe(false);
  });

  test("returns no dates for undated text", () => {
    expect(extractDates("Tidak ada tanggal di sini.")).toEqual({
      raw: [],
      isLampiran: false,
    });
  });

  test("rejects impossible dates instead of emitting a raw string", () => {
    const result = extractDates("Ditetapkan pada 31 Februari 2024.");
    expect(result.issued).toBeUndefined();
    expect(result.raw).toEqual([]);
  });

  test("keeps the first date of each labeled kind", () => {
    const result = extractDates(
      "Ditetapkan pada tanggal 1 Januari 2024. Ditetapkan lagi pada tanggal 2 Januari 2024.",
    );
    expect(result.issued).toBe("2024-01-01");
    expect(result.raw).toEqual(["1 Januari 2024", "2 Januari 2024"]);
  });

  test("binds a label that follows the date across newlines and multi-space", () => {
    const text = "24 Juni 2009\n\nDitetapkan di Jakarta\npada tanggal   24 Juni 2009";
    const result = extractDates(text);
    expect(result.issued).toBe("2009-06-24");
    expect(result.raw).toEqual(["24 Juni 2009", "24 Juni 2009"]);
  });

  test("binds a label that precedes the date across newlines and multi-space", () => {
    const text = "Ditetapkan di Jakarta\npada tanggal   24 Juni 2009";
    const result = extractDates(text);
    expect(result.issued).toBe("2009-06-24");
    expect(result.raw).toEqual(["24 Juni 2009"]);
  });

  test("binds a label in a previous sentence", () => {
    const text = "Ditetapkan di Jakarta. Pada tanggal 24 Juni 2009.";
    const result = extractDates(text);
    expect(result.issued).toBe("2009-06-24");
  });

  test("binds a label in a following sentence", () => {
    const text = "24 Juni 2009. Ditetapkan di Jakarta.";
    const result = extractDates(text);
    expect(result.issued).toBe("2009-06-24");
  });

  test("binds an effective label that follows the date", () => {
    const text = "20 Januari 2024\n\nDiundangkan di Jakarta";
    const result = extractDates(text);
    expect(result.effective).toBe("2024-01-20");
  });

  test("falls back to filename date when no labeled issued date", () => {
    const result = extractDates(
      "Tidak ada label tanggal di sini.",
      "20220124-RKI-P-ADI-017-SOP Pengawasan Internal.pdf",
    );
    expect(result.issued).toBe("2022-01-24");
    expect(result.issuedSource).toBe("filename");
    expect(result.raw).toEqual([]);
  });

  test("labeled issued date wins over filename date", () => {
    const result = extractDates(
      "Ditetapkan pada tanggal 15 Januari 2024.",
      "20220124-RKI-P-ADI-017-SOP Pengawasan Internal.pdf",
    );
    expect(result.issued).toBe("2024-01-15");
    expect(result.issuedSource).toBe("label");
  });

  test("invalid filename date is ignored", () => {
    const result = extractDates(
      "Tidak ada label tanggal di sini.",
      "20261399-RKI-P-ADI-017-SOP Pengawasan Internal.pdf",
    );
    expect(result.issued).toBeUndefined();
    expect(result.issuedSource).toBeUndefined();
  });

  test("non-prefixed filename is ignored", () => {
    const result = extractDates(
      "Tidak ada label tanggal di sini.",
      "SOP Pengawasan Internal.pdf",
    );
    expect(result.issued).toBeUndefined();
    expect(result.issuedSource).toBeUndefined();
  });
});
