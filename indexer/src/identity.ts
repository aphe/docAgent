export interface DocRow {
  doc_id: string;
  root_id: string;
  path: string;
  version_key: string;
}

export interface ScannedFile {
  path: string;
  versionKey: string;
  sha256: string;
}

export interface MatchPlan {
  unchanged: string[];
  newVersion: Array<{ docId: string; file: ScannedFile }>;
  moved: Array<{ docId: string; oldPath: string; file: ScannedFile }>;
  added: Array<{ file: ScannedFile; isDuplicate: boolean }>;
  pruned: string[];
}

/**
 * Pure matching of scanned files against existing document rows.
 *
 * Order:
 * 1. Path match under the current root: unchanged when the version key
 *    matches, a new version when it does not.
 * 2. Unmatched file whose version key equals an unmatched row: moved.
 * 3. Remaining files: added; a version key seen earlier in the run marks
 *    the file as a duplicate.
 * 4. Unmatched rows under the current root: pruned.
 */
export function matchFiles(
  existing: DocRow[],
  seen: ScannedFile[],
  currentRootId: string,
): MatchPlan {
  const unchanged: string[] = [];
  const newVersion: Array<{ docId: string; file: ScannedFile }> = [];
  const moved: Array<{ docId: string; oldPath: string; file: ScannedFile }> = [];
  const added: Array<{ file: ScannedFile; isDuplicate: boolean }> = [];
  const pruned: string[] = [];

  const relevantRows = existing.filter((r) => r.root_id === currentRootId);
  const rowMatched = new Set<number>();
  const fileMatched = new Set<number>();

  const rowByPath = new Map<string, number>();
  relevantRows.forEach((r, i) => {
    if (!rowByPath.has(r.path)) rowByPath.set(r.path, i);
  });

  // 1. Match by path.
  for (let i = 0; i < seen.length; i++) {
    const file = seen[i];
    const rowIdx = rowByPath.get(file.path);
    if (rowIdx !== undefined && !rowMatched.has(rowIdx)) {
      const row = relevantRows[rowIdx];
      if (row.version_key === file.versionKey) {
        unchanged.push(row.doc_id);
      } else {
        newVersion.push({ docId: row.doc_id, file });
      }
      rowMatched.add(rowIdx);
      fileMatched.add(i);
    }
  }

  // 2. Match remaining files to remaining rows by version key.
  const unmatchedByVersion = new Map<string, number[]>();
  relevantRows.forEach((r, i) => {
    if (!rowMatched.has(i)) {
      const list = unmatchedByVersion.get(r.version_key) ?? [];
      list.push(i);
      unmatchedByVersion.set(r.version_key, list);
    }
  });

  for (let i = 0; i < seen.length; i++) {
    if (fileMatched.has(i)) continue;
    const file = seen[i];
    const list = unmatchedByVersion.get(file.versionKey);
    if (list && list.length > 0) {
      const rowIdx = list.shift()!;
      const row = relevantRows[rowIdx];
      moved.push({ docId: row.doc_id, oldPath: row.path, file });
      rowMatched.add(rowIdx);
      fileMatched.add(i);
    }
  }

  // 3. Everything else is added; duplicate when the version key appeared
  //    earlier in this run (including files matched above).
  const seenVersionKeys = new Set<string>();
  for (let i = 0; i < seen.length; i++) {
    const file = seen[i];
    if (fileMatched.has(i)) {
      seenVersionKeys.add(file.versionKey);
      continue;
    }
    const isDuplicate = seenVersionKeys.has(file.versionKey);
    added.push({ file, isDuplicate });
    seenVersionKeys.add(file.versionKey);
  }

  // 4. Remaining rows are pruned.
  relevantRows.forEach((r, i) => {
    if (!rowMatched.has(i)) {
      pruned.push(r.doc_id);
    }
  });

  return { unchanged, newVersion, moved, added, pruned };
}
