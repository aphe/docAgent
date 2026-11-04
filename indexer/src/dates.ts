export interface ExtractedDates {
  issued?: string;
  effective?: string;
  raw: string[];
  isLampiran: boolean;
  issuedSource?: "label" | "filename";
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

/**
 * Extracts an issued date from an eight-digit YYYYMMDD basename prefix. The
 * prefix must be exactly eight leading digits and a real calendar date.
 */
function filenameDate(basename: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?!\d)/.exec(basename);
  if (match === null) return undefined;
  return toIso(Number(match[1]), Number(match[2]), Number(match[3]));
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
 * Bounds of the sentence containing a date, using periods, semicolons, and
 * paragraph breaks as separators. Real PDF text often places the label in a
 * different sentence from the date, so callers fall back to a wider window.
 */
const MAX_LABEL_DISTANCE = 400;
const SENTENCE_BOUNDARIES = [". ", "; ", "\n\n", "\r\n\r\n"];

function sentenceBounds(text: string, dateIndex: number): [number, number] {
  const before = text.slice(0, dateIndex);
  let start = 0;
  for (const boundary of SENTENCE_BOUNDARIES) {
    const pos = before.lastIndexOf(boundary);
    if (pos + boundary.length > start) start = pos + boundary.length;
  }
  const after = text.slice(dateIndex);
  let end = text.length;
  for (const boundary of SENTENCE_BOUNDARIES) {
    const pos = after.indexOf(boundary);
    if (pos >= 0 && dateIndex + pos + boundary.length < end) {
      end = dateIndex + pos + boundary.length;
    }
  }
  return [start, end];
}

function nearestLabelIn(
  text: string,
  dateIndex: number,
  searchStart: number,
  searchEnd: number,
): { kind: "issued" | "effective"; distance: number } | undefined {
  let best: { kind: "issued" | "effective"; distance: number } | undefined;
  const searchText = text.slice(searchStart, searchEnd);
  for (const [kind, re] of [
    ["issued", ISSUED_LABEL],
    ["effective", EFFECTIVE_LABEL],
  ] as const) {
    const globalRe = new RegExp(re.source, "gi");
    for (;;) {
      const match = globalRe.exec(searchText);
      if (match === null) break;
      const matchIndex = searchStart + match.index;
      const distance = Math.abs(matchIndex - dateIndex);
      if (best === undefined || distance < best.distance) {
        best = { kind, distance };
      }
    }
  }
  return best;
}

/**
 * Extracts issued and effective dates from Indonesian document text.
 *
 * Only labeled dates populate `issued` or `effective`:
 * - `tanggal ditetapkan` (or a nearby `ditetapkan`) -> issued
 * - `tanggal diundangkan`, `diundangkan`, or `mulai berlaku` -> effective
 *
 * A label may appear before or after the date in the extracted text order.
 *
 * Every recognized date is returned in `raw` in document order. A `LAMPIRAN`
 * heading sets `isLampiran`; callers treat an annex as unparsable regardless
 * of any date it carries. The first date of each labeled kind wins when more
 * than one appears.
 */
export function extractDates(
  text: string,
  basename?: string,
): ExtractedDates {
  const raw: string[] = [];
  let issued: string | undefined;
  let effective: string | undefined;
  let issuedSource: "label" | "filename" | undefined;

  const dateRe = new RegExp(DATE_PATTERN, "gi");
  for (;;) {
    const match = dateRe.exec(text);
    if (match === null) break;
    const iso = isoFromMatch(match);
    if (iso === undefined) continue;
    raw.push(match[0].trim());

    const [sentenceStart, sentenceEnd] = sentenceBounds(text, match.index);
    let label = nearestLabelIn(text, match.index, sentenceStart, sentenceEnd);
    if (label === undefined) {
      const windowStart = Math.max(0, match.index - MAX_LABEL_DISTANCE);
      const windowEnd = Math.min(text.length, match.index + MAX_LABEL_DISTANCE);
      label = nearestLabelIn(text, match.index, windowStart, windowEnd);
    }
    if (label === undefined) continue;

    if (label.kind === "issued") {
      issued ??= iso;
    } else {
      effective ??= iso;
    }
  }

  if (issued !== undefined) {
    issuedSource = "label";
  } else if (basename !== undefined) {
    const fromFilename = filenameDate(basename);
    if (fromFilename !== undefined) {
      issued = fromFilename;
      issuedSource = "filename";
    }
  }

  return {
    ...(issued === undefined ? {} : { issued }),
    ...(effective === undefined ? {} : { effective }),
    ...(issuedSource === undefined ? {} : { issuedSource }),
    raw,
    isLampiran: LAMPIRAN_HEADING.test(text),
  };
}
