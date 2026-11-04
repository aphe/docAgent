import type { Client } from "@libsql/client";
import { type Hit, type HitStatus, hybridSearch, type StatusConfidence } from "./search";

export interface Citation {
  chunkId: string;
  docId: string;
  path: string;
  page: number;
  charStart: number;
  charEnd: number;
  status: HitStatus;
  statusConfidence: StatusConfidence;
  stale: boolean;
}

export interface AnswerResponse {
  text: string;
  citations: Citation[];
  alternates: string[];
  warnings: string[];
  draft?: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export type ChatCompletion = (
  messages: ChatMessage[],
  key: string,
) => Promise<string>;

export interface AnswerDeps {
  /** Injected embedding function; see `hybridSearch`. */
  embed?: (texts: string[], key: string) => Promise<number[][]>;
  /** Injected chat completion; tests supply a stub so no network is used. */
  chat?: ChatCompletion;
  /** OpenRouter key. Defaults to `OPENROUTER_API_KEY`. */
  key?: string;
}

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const LLM_MODEL = "openai/gpt-6-luna";
const NO_SOURCE_TEXT = "Sumber tidak ditemukan untuk pertanyaan ini.";
const TOP_K = 8;

const SYSTEM_PROMPT =
  "Jawab hanya dari kutipan yang diberikan. Jangan menambah fakta. " +
  "Kutip setiap klaim dengan chunkId dalam kurung siku, misalnya [doc:1:0]. " +
  "Jika kutipan tidak menjawab pertanyaan, katakan tidak ditemukan.";

const DRAFT_PROMPT =
  "Susun draf revisi hanya dari kutipan yang diberikan. Jangan menambah fakta. " +
  "Kutip setiap klaim dengan chunkId dalam kurung siku. Draf tidak diterapkan otomatis.";

/**
 * Default OpenRouter chat completion. The provider is pinned to OpenAI and
 * fallbacks are disabled. An empty key is rejected before any network call.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  key: string,
): Promise<string> {
  if (key.trim() === "") {
    throw new Error("OPENROUTER_API_KEY is required to call the LLM");
  }
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      provider: { order: ["openai"], allow_fallbacks: false },
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter chat request failed (${response.status}): ${body}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: string };
  };
  if (payload.error) {
    throw new Error(`OpenRouter chat error: ${payload.error.message ?? "unknown"}`);
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("OpenRouter chat returned no content");
  }
  return content.trim();
}

async function documentPaths(
  db: Client,
  docIds: string[],
): Promise<Map<string, string>> {
  if (docIds.length === 0) return new Map();
  const placeholders = docIds.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT doc_id, path FROM documents WHERE doc_id IN (${placeholders})`,
    args: docIds,
  });
  const paths = new Map<string, string>();
  for (const row of result.rows) {
    paths.set(String(row.doc_id), String(row.path));
  }
  return paths;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toCitations(hits: Hit[], paths: Map<string, string>): Citation[] {
  return hits.map((hit) => ({
    chunkId: hit.chunkId,
    docId: hit.docId,
    path: paths.get(hit.docId) ?? "",
    page: hit.page,
    charStart: hit.charStart,
    charEnd: hit.charEnd,
    status: hit.status,
    statusConfidence: hit.statusConfidence,
    stale: hit.stale,
  }));
}

function buildWarnings(hits: Hit[], alternates: string[]): string[] {
  const warnings: string[] = [];

  const staleIds = hits.filter((hit) => hit.stale).map((hit) => hit.chunkId);
  if (staleIds.length > 0) {
    warnings.push(
      `Kutipan stale, versi dokumen berubah sejak indeks: ${staleIds.join(", ")}.`,
    );
  }

  const lowConfidenceDocs = unique(
    hits
      .filter((hit) => hit.statusConfidence === "low")
      .map((hit) => hit.docId),
  );
  if (lowConfidenceDocs.length > 0) {
    warnings.push(
      `Kepercayaan status rendah untuk dokumen: ${lowConfidenceDocs.join(", ")}.`,
    );
  }

  if (alternates.length > 0) {
    warnings.push(`Dokumen alternatif yang perlu diperiksa: ${alternates.join(", ")}.`);
  }

  return warnings;
}

function passages(hits: Hit[]): string {
  return hits
    .map(
      (hit) =>
        `[${hit.chunkId}] (${hit.docId}, hal. ${hit.page})\n${hit.text}`,
    )
    .join("\n\n");
}

/**
 * Answers or drafts from the local index.
 *
 * No hit returns a plain no-source message with no citations. Citations are
 * only real chunks returned by `hybridSearch`; an unreadable document can
 * never appear. Stale citations and low-confidence/ambiguous documents add
 * warnings listing them. Draft mode returns text in both `text` and `draft`
 * and never writes anywhere.
 */
export async function answer(
  db: Client,
  query: string,
  mode: "answer" | "draft",
  deps: AnswerDeps = {},
): Promise<AnswerResponse> {
  const hits = await hybridSearch(db, query, {
    topK: TOP_K,
    ...(deps.embed === undefined ? {} : { embed: deps.embed }),
    ...(deps.key === undefined ? {} : { key: deps.key }),
  });

  if (hits.length === 0) {
    return { text: NO_SOURCE_TEXT, citations: [], alternates: [], warnings: [] };
  }

  const paths = await documentPaths(
    db,
    unique(hits.map((hit) => hit.docId)),
  );
  const citations = toCitations(hits, paths);
  const alternates = unique(hits.flatMap((hit) => hit.alternates));
  const warnings = buildWarnings(hits, alternates);

  const key = deps.key ?? process.env.OPENROUTER_API_KEY ?? "";
  const chat = deps.chat ?? chatCompletion;
  const text = await chat(
    [
      { role: "system", content: mode === "draft" ? DRAFT_PROMPT : SYSTEM_PROMPT },
      {
        role: "user",
        content: `Pertanyaan: ${query}\n\nKutipan:\n${passages(hits)}`,
      },
    ],
    key,
  );

  if (mode === "draft") {
    return { text, citations, alternates, warnings, draft: text };
  }
  return { text, citations, alternates, warnings };
}
