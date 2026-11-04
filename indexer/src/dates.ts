export interface ExtractedDates {
  issued?: string;
  effective?: string;
  raw: string[];
  isLampiran: boolean;
}

/**
 * Indonesian month names mapped to their 1-based month number. Only the
 * full names are recognized; numeric separators carry the day-first and ISO
 * forms instead.
 */
const MONTHS: Record<string, number> = {
  januari: 1,
  februari: 2,
  maret: 3,
  april: 4,
  mei: 5,
  juni: 6,
  juli: 7,
  agustus: 8,
  september: 9,
  oktober: 10,
  november: 11,
  desember: 12,
};

const MONTH_PATTERN = Object.keys(MONTHS).join("|");

/**
 * ISO first so a leading four-digit year is never read as a day. The named
 * Indonesian month form follows. Other numeric day-first variants are not
 * part of the brief and are deliberately left unparsed.
 */
const DATE_PATTERN =
  "(?<!\\d)(?:" +
  "(?<isoYear>\\d{4})-(?<isoMonth>\\d{2})-(?<isoDay>\\d{2})" +
  "|(?<namedDay>\\d{1,2})\\s+(?<namedMonth>" +
  MONTH_PATTERN +
  ")\\s+(?<namedYear>\\d{4})" +
  ")(?!\\d)";

const ISSUED_LABEL = /(?:tanggal\s+ditetapkan|ditetapkan)/i;
const EFFECTIVE_LABEL = /(?:tanggal\s+diundangkan|diundangkan|mulai\s+berlaku)/i;

/**
 * A LAMPIRAN heading is a line that is exactly "LAMPIRAN", optionally followed
 * by a roman numeral or number. An inline mention such as "Lampiran ini ..."
 * is not a heading and does not mark the document as an annex.
 */
const LAMPIRAN_HEADING =
  /(?:^|\r?\n)[ \t]*LAMPIRAN(?:[ \t]+[IVXLCDM\d]+)?[ \t\r]*(?=\r?\n|$)/i;

/**
 * Converts a candidate date to ISO `YYYY-MM-DD`, rejecting out-of-range
 * values. A date that does not exist (e.g. 31 February) is not parsable and
 * therefore contributes no raw string.
 */
function toIso(
  year: number,
  month: number,
  day: number,
): string | undefined {
  if (year < 1000 || year > 9999) return undefined;
  if (month < 1 || month > 12) return undefined;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return undefined;
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isoFromMatch(match: RegExpExecArray): string | undefined {
  const groups = match.groups;
  if (!groups) return undefined;
  if (groups.isoYear !== undefined) {
    return toIso(
      Number(groups.isoYear),
      Number(groups.isoMonth),
      Number(groups.isoDay),
    );
  }
  if (groups.namedYear !== undefined) {
    const month = MONTHS[groups.namedMonth.toLowerCase()];
    return toIso(Number(groups.namedYear), month, Number(groups.namedDay));
  }
  return undefined;
}

/**
 * Returns the sentence-like text immediately before a date so the nearest
 * issued/effective label can be attached. Newlines are flattened because
 * Indonesian legal documents often wrap "pada tanggal" onto its own line.
 */
function labelContext(text: string, dateIndex: number): string {
  const before = text
    .slice(Math.max(0, dateIndex - 200), dateIndex)
    .replace(/\s+/g, " ");
  const boundary = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "));
  return boundary >= 0 ? before.slice(boundary + 1) : before;
}

/**
 * Extracts issued and effective dates from Indonesian document text.
 *
 * Only labeled dates populate `issued` or `effective`:
 * - `tanggal ditetapkan` (or a nearby `ditetapkan`) -> issued
 * - `tanggal diundangkan`, `diundangkan`, or `mulai berlaku` -> effective
 *
 * Every recognized date is returned in `raw` in document order. A `LAMPIRAN`
 * heading sets `isLampiran`; callers treat an annex as unparsable regardless
 * of any date it carries. The first date of each labeled kind wins when more
 * than one appears.
 */
export function extractDates(text: string): ExtractedDates {
  const raw: string[] = [];
  let issued: string | undefined;
  let effective: string | undefined;

  const dateRe = new RegExp(DATE_PATTERN, "gi");
  for (;;) {
    const match = dateRe.exec(text);
    if (match === null) break;
    const iso = isoFromMatch(match);
    if (iso === undefined) continue;
    raw.push(match[0].trim());

    const context = labelContext(text, match.index);
    const issuedIndex = context.search(ISSUED_LABEL);
    const effectiveIndex = context.search(EFFECTIVE_LABEL);
    if (issuedIndex < 0 && effectiveIndex < 0) continue;

    if (effectiveIndex > issuedIndex) {
      effective ??= iso;
    } else if (issuedIndex > effectiveIndex) {
      issued ??= iso;
    }
  }

  return {
    ...(issued === undefined ? {} : { issued }),
    ...(effective === undefined ? {} : { effective }),
    raw,
    isLampiran: LAMPIRAN_HEADING.test(text),
  };
}
