import { Agent, Memory, createTool } from "@voltagent/core";
import type { Client } from "@libsql/client";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { answer, searchStep, type AnswerDeps, type Citation } from "../query/answer";

const querySchema = z.object({
  query: z.string().min(1).max(2000).describe("Pertanyaan dalam bahasa Indonesia atau Inggris"),
});

/**
 * Document agent for the VoltOps console. Each tool is self-contained and
 * takes only `{ query }`; the model chooses which tool to call.
 *
 * The chat model polishes the retrieved text (decision 26). Citations are
 * shown as `[file name]` labels, not chunk ids. `lastCitedLabels` records the
 * labels from the most recent answer tool call for `checkPolishedTags`.
 *
 * Trade-off: a turn that calls `search_documents` and then `answer_question`
 * embeds the query twice and runs hybrid search twice. The two hit sets can
 * differ, so citations come only from `answer_question` / `draft_revision`.
 */

let lastCitedLabels: string[] = [];

export function resetLastCitedLabels(): void {
  lastCitedLabels = [];
}

const PREVIEW_CHARS = 300;

export function getLastCitedLabels(): string[] {
  return lastCitedLabels;
}

function labelFor(citation: Citation): string {
  const file = citation.path ? (citation.path.split("/").pop() ?? citation.path) : citation.docId;
  return `${file}, p. ${citation.page}`;
}

/** Records cited labels for the tag check; returns chunkId → label for the model. */
function recordCitations(citations: Citation[]): Record<string, string> {
  lastCitedLabels = [...new Set(citations.map(labelFor))];
  return Object.fromEntries(citations.map((c) => [c.chunkId, labelFor(c)]));
}

export function createDocAgent(db: Client, memory: Memory, deps: AnswerDeps = {}) {
  const searchDocuments = createTool({
    name: "search_documents",
    description:
      "Pratinjau singkat potongan dokumen untuk memeriksa relevansi. Hanya pratinjau: JANGAN menjawab atau mengutip sumber dari hasil ini. Jawaban dan kutipan wajib dari answer_question atau draft_revision.",
    parameters: querySchema,
    execute: async ({ query }) => {
      const result = await searchStep(db, query, deps);
      return {
        hits: result.hits.map((hit) => ({
          chunkId: hit.chunkId,
          docId: hit.docId,
          page: hit.page,
          score: hit.score,
          status: hit.status,
          statusConfidence: hit.statusConfidence,
          preview: hit.text.slice(0, PREVIEW_CHARS),
        })),
        warnings: result.warnings,
      };
    },
  });

  const answerQuestion = createTool({
    name: "answer_question",
    description:
      "Jawab pertanyaan dari dokumen dengan kutipan [nama file]. Gunakan untuk pertanyaan SOP atau perjanjian.",
    parameters: querySchema,
    execute: async ({ query }) => {
      const result = await answer(db, query, "answer", deps);
      const tagLabels = recordCitations(result.citations);
      return { ...result, tagLabels };
    },
  });

  const draftRevision = createTool({
    name: "draft_revision",
    description:
      "Kembalikan kutipan dokumen asli sebagai draf. Tidak menulis ulang; draf hanya berisi teks sumber dan tidak diterapkan.",
    parameters: querySchema,
    execute: async ({ query }) => {
      const result = await answer(db, query, "draft", deps);
      const tagLabels = recordCitations(result.citations);
      return { ...result, tagLabels };
    },
  });

  return new Agent({
    name: "docAgent",
    instructions:
      "Anda asisten dokumen SOP dan perjanjian. Ambil teks dari field `text` answer_question atau draft_revision lalu haluskan kalimatnya agar mudah dibaca. " +
      "Aturan: pertahankan setiap fakta, angka, dan klausul dari teks sumber; jangan menambah klaim baru; " +
      "ganti setiap tag [chunkId] dengan tag persis dari field `tagLabels` (format `[nama file, p. N]`, termasuk nomor halaman), salin apa adanya; jangan mengubah, menyingkat, atau menggabungkan tag; pertahankan setiap kutipan; jangan pernah menyatakan tidak ada sumber jika tool mengembalikan kutipan; " +
      "jawab dalam bahasa yang sama dengan pertanyaan pengguna (Indonesia atau Inggris) walau teks sumber berbahasa Indonesia; jika hasil tool berisi `warnings`, tampilkan setiap entri sebagai baris bullet `- ` tersendiri setelah teks, diterjemahkan ke bahasa pertanyaan tanpa mengubah fakta atau nama file; " +
      "Gunakan search_documents hanya untuk pratinjau relevansi; jangan menjawab atau mengutip dari hasil itu.",
    model: createOpenRouter({ apiKey: deps.key ?? "" })("openai/gpt-6-luna"),
    tools: [searchDocuments, answerQuestion, draftRevision],
    memory,
  });
}
