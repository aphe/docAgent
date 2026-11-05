// Removes top-level `providerMetadata` from SSE `data:` lines.
//
// The VoltOps console's bundled ai-sdk-ui validates tool-output-available
// chunks against a schema that predates providerMetadata, so a chunk carrying
// the OpenRouter reasoning metadata fails validation and the chat never
// renders. The field is attached non-deterministically by the provider, so
// stripping it server-side on the way out is the deterministic fix.
// Ported from ticketing/src/streaming/strip-provider-metadata.ts.
export function stripProviderMetadataFromSSE(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  function processLine(line: string): string {
    if (!line.startsWith("data: ")) {
      return line;
    }
    const jsonText = line.slice("data: ".length);
    try {
      const chunk = JSON.parse(jsonText) as Record<string, unknown>;
      if (chunk && typeof chunk === "object" && "providerMetadata" in chunk) {
        const { providerMetadata: _providerMetadata, ...rest } = chunk;
        return `data: ${JSON.stringify(rest)}`;
      }
      return line;
    } catch {
      return line;
    }
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${processLine(line)}\n`));
        }
      },
      flush(controller) {
        if (buffer.length > 0) {
          controller.enqueue(encoder.encode(processLine(buffer)));
        }
      },
    }),
  );
}
