/**
 * Shared SSE (Server-Sent Events) stream parser.
 * Used by both agentLoop and openRouterClient to avoid code duplication.
 */

import { logger } from '../logger';

export type ReadableStreamLike =
  | ReadableStream<Uint8Array>
  | import("stream/web").ReadableStream<Uint8Array>;

export interface SSEToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface SSEUsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
}

export interface SSEParseResult {
  content: string;
  reasoning?: string;
  finish_reason?: string;
  tool_calls?: SSEToolCall[];
  usage?: SSEUsageInfo;
}

export interface SSEParseOptions {
  onChunk: (chunk: string) => void;
  onReasoning?: (reasoning: string) => void;
  signal?: AbortSignal;
}

/**
 * Parse an SSE stream from an OpenAI-compatible chat endpoint.
 *
 * Handles:
 * - Content delta streaming
 * - 4 reasoning formats: reasoning_details, reasoning_content, reasoning, thinking
 * - Tool call accumulation across multiple deltas
 * - finish_reason tracking
 * - Abort signal
 */
export async function parseSSEStream(
  body: ReadableStreamLike,
  opts: SSEParseOptions
): Promise<SSEParseResult> {
  const { onChunk, onReasoning, signal } = opts;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningAccumulated = "";
  let finishReason = "";
  let usage: SSEUsageInfo | undefined;
  let eventsParsed = 0;
  let parseErrors = 0;
  let contentChunks = 0;
  let reasoningChunks = 0;
  let toolCallDeltas = 0;
  const toolCallsMap = new Map<
    number,
    { id: string; type: string; function: { name: string; arguments: string } }
  >();

  logger.log('[SSE] Stream parse started');

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Aborted");
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line || !line.startsWith("data:")) continue;

        const payload = line.replace(/^data:\s*/, "");
        if (payload === "[DONE]") break;

        try {
          const json = JSON.parse(payload);
          eventsParsed++;
          const choice = json.choices?.[0];
          const delta = choice?.delta;

          // Track finish_reason (will be 'length' if max_tokens hit)
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          // Track usage info (typically in the last chunk)
          if (json.usage) {
            usage = {
              prompt_tokens: json.usage.prompt_tokens,
              completion_tokens: json.usage.completion_tokens,
              total_tokens: json.usage.total_tokens,
              // OpenRouter: usage.prompt_tokens_details.cached_tokens
              // Mistral: usage.prompt_cache_hit_tokens
              cached_tokens: json.usage.prompt_tokens_details?.cached_tokens
                ?? json.usage.prompt_cache_hit_tokens
                ?? json.usage.cache_read_input_tokens
                ?? undefined,
            };
          }

          if (delta?.content) {
            content += delta.content;
            contentChunks++;
            onChunk(delta.content);
          }

          // --- Reasoning (4 formats) ---

          // Format 1: reasoning_details array (OpenRouter extended thinking)
          const reasoningDetails = delta?.reasoning_details;
          if (
            reasoningDetails &&
            Array.isArray(reasoningDetails) &&
            onReasoning
          ) {
            for (const detail of reasoningDetails) {
              if (detail.type === "reasoning.text" && detail.text) {
                reasoningAccumulated += detail.text;
                reasoningChunks++;
                onReasoning(reasoningAccumulated);
              } else if (
                detail.type === "reasoning.summary" &&
                detail.summary
              ) {
                reasoningAccumulated += detail.summary;
                reasoningChunks++;
                onReasoning(reasoningAccumulated);
              }
            }
          }

          // Format 2: reasoning_content (Claude, some models)
          if (delta?.reasoning_content && onReasoning) {
            reasoningAccumulated += delta.reasoning_content;
            reasoningChunks++;
            onReasoning(reasoningAccumulated);
          }

          // Format 3: reasoning field directly
          if (delta?.reasoning && onReasoning) {
            reasoningAccumulated += delta.reasoning;
            reasoningChunks++;
            onReasoning(reasoningAccumulated);
          }

          // Format 4: thinking field (some models)
          if (delta?.thinking && onReasoning) {
            reasoningAccumulated += delta.thinking;
            reasoningChunks++;
            onReasoning(reasoningAccumulated);
          }

          // --- Tool calls ---
          if (delta?.tool_calls) {
            toolCallDeltas += delta.tool_calls.length;
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap.has(idx)) {
                toolCallsMap.set(idx, {
                  id: tc.id || "",
                  type: tc.type || "function",
                  function: { name: "", arguments: "" },
                });
              }
              const existing = toolCallsMap.get(idx)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments)
                existing.function.arguments += tc.function.arguments;
            }
          }
        } catch (e: any) {
          parseErrors++;
          if (parseErrors <= 3) {
            logger.log(`[SSE] Event parse error (${parseErrors}): ${(e?.message || String(e)).slice(0, 120)}`);
          }
          // ignore parse errors in individual SSE events
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls =
    toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined;

  const finish = finishReason || 'none';
  logger.log(
    `[SSE] Stream parse done: events=${eventsParsed}, parseErrors=${parseErrors}, ` +
    `contentChunks=${contentChunks}, reasoningChunks=${reasoningChunks}, toolCallDeltas=${toolCallDeltas}, ` +
    `toolCallsFinal=${toolCalls?.length || 0}, finish_reason=${finish}, contentChars=${content.length}`
  );
  if (finish === 'length') {
    logger.log('[SSE] finish_reason=length detected (response hit max_tokens/output limit)');
  }

  return {
    content,
    reasoning: reasoningAccumulated || undefined,
    finish_reason: finishReason || undefined,
    tool_calls: toolCalls,
    usage,
  };
}
