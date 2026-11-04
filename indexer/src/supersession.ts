export interface DocDates {
  docId: string;
  topicKey: string;
  documentNumber?: string;
  issued?: string;
  effective?: string;
  raw: string[];
  isLampiran: boolean;
  issuedSource?: "label" | "filename";
}

export type DocStatus = "active" | "superseded" | "unparsable";
export type StatusConfidence = "high" | "low";

export interface DocSupersession {
  status: DocStatus;
  statusConfidence: StatusConfidence;
  alternates: string[];
}

export interface SupersessionResult {
  byDoc: Record<string, DocSupersession>;
  supersedes: Array<{ docId: string; supersedesDocId: string }>;
}

function keyOf(doc: DocDates): string {
  return doc.effective ?? doc.issued ?? "";
}

/**
 * Derives document status from dates within each `topicKey` group. No LLM
 * call and no document-number tiebreak: ambiguity is reported, never hidden.
 *
 * - Lampiran or no issued/effective date -> `unparsable`, `low`.
 * - One latest winner with a real effective date -> `active`, `high`; the
 *   other dated documents are `superseded` and the winner's edges are
 *   recorded.
 * - A tie on the latest ranking key -> all tied documents `active`, `low`,
 *   each listing the others; no supersedes edge is invented.
 * - A winner that only has an issued date (including when another candidate
 *   has an effective date) -> `active`, `low`, with alternates listed; edges
 *   follow the fallback winner but remain visibly low-confidence.
 */
export function deriveSupersession(docs: DocDates[]): SupersessionResult {
  const byDoc: Record<string, DocSupersession> = {};
  const supersedes: Array<{ docId: string; supersedesDocId: string }> = [];

  const groups = new Map<string, DocDates[]>();
  for (const doc of docs) {
    const group = groups.get(doc.topicKey);
    if (group) group.push(doc);
    else groups.set(doc.topicKey, [doc]);
  }

  for (const group of groups.values()) {
    const undated: DocDates[] = [];
    const dated: DocDates[] = [];
    for (const doc of group) {
      if (doc.isLampiran || (!doc.issued && !doc.effective)) undated.push(doc);
      else dated.push(doc);
    }

    for (const doc of undated) {
      byDoc[doc.docId] = {
        status: "unparsable",
        statusConfidence: "low",
        alternates: [],
      };
    }
    if (dated.length === 0) continue;

    let maxKey = keyOf(dated[0]);
    for (const doc of dated) {
      const key = keyOf(doc);
      if (key > maxKey) maxKey = key;
    }
    const winners = dated.filter((doc) => keyOf(doc) === maxKey);
    const others = dated.filter((doc) => !winners.includes(doc));
    const datedIds = dated.map((doc) => doc.docId);

    if (winners.length > 1) {
      for (const doc of winners) {
        byDoc[doc.docId] = {
          status: "active",
          statusConfidence: "low",
          alternates: datedIds.filter((id) => id !== doc.docId),
        };
        for (const older of others) {
          supersedes.push({
            docId: doc.docId,
            supersedesDocId: older.docId,
          });
        }
      }
      for (const doc of others) {
        byDoc[doc.docId] = {
          status: "superseded",
          statusConfidence: "low",
          alternates: datedIds.filter((id) => id !== doc.docId),
        };
      }
      continue;
    }

    const winner = winners[0];
    if (winner.effective !== undefined) {
      byDoc[winner.docId] = {
        status: "active",
        statusConfidence: "high",
        alternates: [],
      };
      for (const doc of others) {
        byDoc[doc.docId] = {
          status: "superseded",
          statusConfidence: "high",
          alternates: [],
        };
        supersedes.push({
          docId: winner.docId,
          supersedesDocId: doc.docId,
        });
      }
      continue;
    }

    // The ranking key came from the issued date. Keep the fallback winner but
    // mark the group low so the API warns about the uncertainty.
    byDoc[winner.docId] = {
      status: "active",
      statusConfidence: "low",
      alternates: datedIds.filter((id) => id !== winner.docId),
    };
    for (const doc of others) {
      byDoc[doc.docId] = {
        status: "superseded",
        statusConfidence: "low",
        alternates: datedIds.filter((id) => id !== doc.docId),
      };
      supersedes.push({
        docId: winner.docId,
        supersedesDocId: doc.docId,
      });
    }
  }

  return { byDoc, supersedes };
}
