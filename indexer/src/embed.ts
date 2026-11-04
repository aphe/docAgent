const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const BATCH_SIZE = 96;

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index?: number }>;
  error?: { message?: string };
}

/**
 * Embeds texts through OpenRouter with the OpenAI embedding model.
 *
 * The provider is pinned to OpenAI and fallbacks are disabled. Requests are
 * sent in batches of at most 96 texts to stay within the API limit. An empty
 * API key is rejected before any network call so misconfiguration never
 * reaches the provider.
 */
export async function embedTexts(
  texts: string[],
  key: string,
): Promise<number[][]> {
  if (key.trim() === "") {
    throw new Error("OPENROUTER_API_KEY is required to embed texts");
  }
  if (texts.length === 0) return [];

  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
        provider: { order: ["openai"], allow_fallbacks: false },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenRouter embedding request failed (${response.status}): ${body}`,
      );
    }

    const payload = (await response.json()) as EmbeddingResponse;
    if (payload.error) {
      throw new Error(
        `OpenRouter embedding error: ${payload.error.message ?? "unknown"}`,
      );
    }
    if (!Array.isArray(payload.data) || payload.data.length !== batch.length) {
      throw new Error(
        `OpenRouter embedding response returned ${payload.data?.length ?? 0} vectors for ${batch.length} texts`,
      );
    }

    const ordered = payload.data
      .map((item, index) => ({ item, index: item.index ?? index }))
      .sort((a, b) => a.index - b.index)
      .map(({ item }) => item.embedding);

    embeddings.push(...ordered);
  }

  return embeddings;
}
