import { fetch } from "undici";
import { parseSSEStream, type ReadableStreamLike } from '../sseParser';
import { logger } from '../../logger';

interface OpenRouterConfig {
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
}

interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface ChatOptions {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal;
  tools?: any[];
  reasoning?: { effort: string };
}

// Fixed parameters for all API calls
const FIXED_PARAMS = {
  temperature: 0.3,
  top_p: 1,
  max_tokens: 4096,
  n: 1
};

export class OpenRouterClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel?: string;

  constructor(config: OpenRouterConfig) {
    this.baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  this.apiKey = config.apiKey?.trim() ?? "";
    this.defaultModel = config.defaultModel;
  }

  async chat(options: ChatOptions, onChunk?: (chunk: string) => void, onReasoning?: (reasoning: string) => void): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const body: any = {
      model: options.model ?? this.defaultModel,
      messages: options.messages,
      stream: options.stream ?? true,
      ...FIXED_PARAMS
    };

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }

    // Add reasoning parameter if enabled
    if (options.reasoning) {
      body.reasoning = options.reasoning;
    }

    const authHeader = this.apiKey;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Ashibalt-AI/1.0",
    };

    // OpenRouter-specific headers for app identification
    if (this.baseUrl.includes('openrouter.ai')) {
      headers['X-Title'] = 'Ashibalt AI (beta)';
      headers['HTTP-Referer'] = 'https://github.com/Ashibalt-AI';
    }

    if (authHeader) {
      headers["Authorization"] = `Bearer ${authHeader}`;
    } else {
      logger.log('[OpenRouterClient] No auth token or API key provided!');
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal
    });

    if (!response.ok) {
      const error = await response.text();
      // Include status code in consistent format for parseApiError
      throw new Error(`Chat request failed (${response.status}): ${error}`);
    }

    if (body.stream && onChunk && response.body) {
      return this.streamChat(response.body, onChunk, onReasoning, options.signal);
    }

    const json: any = await response.json();
    const content: string = json.choices?.[0]?.message?.content ?? "";
    if (!content) {
      throw new Error("OpenRouter returned empty response.");
    }
    return content;
  }

  private async streamChat(body: ReadableStreamLike, onChunk: (chunk: string) => void, onReasoning?: (reasoning: string) => void, signal?: AbortSignal) {
    const result = await parseSSEStream(body, { onChunk, onReasoning, signal });
    return result.content;
  }
}
