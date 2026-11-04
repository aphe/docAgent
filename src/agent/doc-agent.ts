import { Agent, Memory, createTool } from "@voltagent/core";
import type { Client } from "@libsql/client";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { answer, searchStep, type AnswerDeps } from "../query/answer";

const querySchema = z.object({
  query: z.string().min(1).max(2000).describe("Pertanyaan dalam bahasa Indonesia atau Inggris"),
});

/**
 * Document agent for the VoltOps console. Each tool is self-contained and
 * takes only `{ query }`; the model chooses which tool to call.
 *
 * Trade-off: a turn that calls `search_documents` and then `answer_question`
 * embeds the query twice and runs hybrid search twice. The two hit sets can
 * differ, so citations come only from `answer_question` / `draft_revision`.
 *
 * Retrieval thresholds, status ranking, citation filtering, and the no-match
 * path all execute inside `src/query/answer.ts`.
 */

const PREVIEW_CHARS = 300;

export function createDocAgent(db: Client, memory: Memory, deps: AnswerDeps = {}) {
  const searchDocuments = createTool({
    name: "search_documents",
    description:
      "Pratinjau singkat potongan dokumen untuk memeriksa relevansi. Hanya pratinjau: JANGAN menjawab atau mengutip [chunkId] dari hasil ini. Jawaban dan kutipan wajib dari answer_question atau draft_revision.",
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
      "Jawab pertanyaan dari dokumen dengan kutipan [chunkId]. Gunakan untuk pertanyaan SOP atau perjanjian.",
    parameters: querySchema,
    execute: async ({ query }) => answer(db, query, "answer", deps),
  });

  const draftRevision = createTool({
    name: "draft_revision",
    description:
      "Susun draf revisi dari kutipan dokumen. Draf hanya dikembalikan sebagai teks, tidak diterapkan.",
    parameters: querySchema,
    execute: async ({ query }) => answer(db, query, "draft", deps),
  });

  return new Agent({
    name: "docAgent",
    instructions:
      "Anda asisten dokumen SOP dan perjanjian. Gunakan answer_question untuk menjawab, " +
      "search_documents untuk melihat potongan mentah, dan draft_revision untuk draf. " +
      "Jawab hanya dari hasil tool. Sebutkan dokumen yang superseded atau tidak terbaca.",
    model: createOpenRouter({ apiKey: deps.key ?? "" })("openai/gpt-6-luna"),
    tools: [searchDocuments, answerQuestion, draftRevision],
    memory,
  });
}
