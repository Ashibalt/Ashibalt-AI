
import * as vscode from 'vscode';
import { logger } from '../logger';
import { parseSSEStream, type ReadableStreamLike } from './sseParser';
import { buildModelParams } from './modelParams';

/** Structured API response from chat/completions */
export interface ChatResponse {
  content: string;
  reasoning?: string;
  tool_calls?: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[];
  finish_reason?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    cost?: number;
  };
}

/**
 * Send a streaming chat/completions request with tool definitions.
 * Handles provider-specific quirks (DeepSeek, Mistral, GLM, Ollama).
 */
export async function fetchOpenRouterWithTools(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: any[];
  tools: any[];
  toolChoice?: 'auto' | 'any' | 'none' | 'required';
  reasoning?: { max_tokens?: number; effort?: string; enabled?: boolean };
  signal?: AbortSignal;
  onChunk: (chunk: string) => void;
  onReasoning?: (reasoning: string) => void;
  /** OpenRouter provider routing (from providerAutoSelect) */
  provider?: { only?: string[]; order?: string[]; allow_fallbacks: boolean } | null;
  /** Explicitly enable parallel tool calls (agent mode) */
  parallelToolCalls?: boolean;
}): Promise<ChatResponse> {
  const { baseUrl, apiKey, model, messages, tools, toolChoice, reasoning, signal, onChunk, onReasoning, provider: providerRouting, parallelToolCalls } = opts;

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  // Provider detection flags (for provider-specific API quirks below)
  const isDeepSeek = baseUrl.includes('deepseek.com');
  const isMistral = baseUrl.includes('mistral.ai');
  const isGLM = /glm/i.test(model);
  const isOllama = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('11434');
  const isOpenRouter = baseUrl.includes('openrouter.ai');

  let actualModel = model;
  if (isDeepSeek && reasoning?.enabled) {
    actualModel = 'deepseek-reasoner';
    if (model !== actualModel) {
      logger.log(`[FETCH] DeepSeek reasoning enabled, switching model: ${model} → ${actualModel}`);
    }
  }

  // Use centralized model parameters (temperature, top_p, max_tokens, n)
  const params = buildModelParams(baseUrl, actualModel);

  const body: any = {
    model: actualModel,
    messages,
    stream: true,
    ...params
  };

  logger.log(`[FETCH] Request config: provider=${baseUrl}, messages=${messages.length}, tools=${tools?.length || 0}, toolChoice=${toolChoice || 'none'}, max_tokens=${params.max_tokens}`);

  // OpenRouter provider routing (auto-selected caching provider)
  if (providerRouting && isOpenRouter) {
    body.provider = providerRouting;
    logger.log(`[FETCH] Provider routing: ${JSON.stringify(providerRouting)}`);
  }

  // Apply explicit cache_control breakpoint to system message for providers that require it.
  // Anthropic Claude: REQUIRES cache_control to activate prompt caching (no explicit marker = no cache).
  // Google Gemini: supports cache_control, uses the LAST breakpoint in the request.
  // OpenAI / DeepSeek / Grok / Moonshot / Groq: implicit caching — no markup needed (would be ignored anyway).
  // TTL 1h (instead of default 5min) because agent sessions often exceed 5 minutes.
  if (isOpenRouter && (/claude/i.test(actualModel) || /gemini/i.test(actualModel))) {
    const sysMsg = body.messages[0];
    if (sysMsg?.role === 'system' && typeof sysMsg.content === 'string' && sysMsg.content.length > 0) {
      // Clone the messages array (shallow) to avoid mutating the original conversationMessages —
      // mutating it would change the byte-identical prefix that providers use for cache lookup.
      body.messages = [
        {
          role: 'system',
          content: [{
            type: 'text',
            text: sysMsg.content,
            cache_control: { type: 'ephemeral', ttl: '1h' }
          }]
        },
        ...body.messages.slice(1)
      ];
      logger.log(`[FETCH] cache_control (ephemeral, ttl=1h) applied to system message for ${actualModel}`);
    }
  }

  if (tools && tools.length > 0) {
    body.tools = tools;

    // Parallel tool calls: enable for all models in agent mode
    if (parallelToolCalls) {
      body.parallel_tool_calls = true;
      logger.log(`[FETCH] Enabled parallel tool calls for model: ${actualModel}`);
    }

    if (toolChoice && !isOllama) {
      const effectiveToolChoice = (toolChoice === 'any' && !isMistral) ? 'required' : toolChoice;
      body.tool_choice = effectiveToolChoice;
      logger.log(`[FETCH] tool_choice=${effectiveToolChoice}`);
    }
  }

  if (isGLM) {
    body.reasoning = { enabled: false };
    logger.log(`[FETCH] GLM model — reasoning disabled for proper tool calling`);
  } else if (reasoning && !isDeepSeek) {
    body.reasoning = reasoning;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Ashibalt-AI/1.0',
  };
  if (isOpenRouter) {
    headers['X-Title'] = 'Ashibalt AI';
    headers['HTTP-Referer'] = 'https://github.com/Ashibalt/Ashibalt-AI';
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    logger.error('[FETCH] No API key provided');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  } as any);

  if (!response.ok) {
    let error = await response.text();
    // Strip HTML from error responses (CloudFlare 503 pages etc.)
    if (error.includes('<html') || error.includes('<!DOCTYPE') || error.includes('<HTML')) {
      const titleMatch = error.match(/<title[^>]*>([^<]+)<\/title>/i);
      const textOnly = error.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      error = titleMatch
        ? `${titleMatch[1].trim()} — ${textOnly.substring(0, 200)}`
        : textOnly.substring(0, 300);
    }
    throw new Error(`API request failed (${response.status}): ${error}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  return parseSSEStream(response.body as ReadableStreamLike, { onChunk, onReasoning });
}
