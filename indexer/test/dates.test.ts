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
});
