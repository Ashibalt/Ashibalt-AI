import { ExtensionConfig, PROVIDER_DEFAULTS, type ProviderType } from "./Config/config";
import { OpenRouterClient } from "./Engine/OpenRouter/openRouterClient";

export interface ChatModelClient {
  chat: (options: any, onChunk?: (chunk: string) => void, onReasoning?: (reasoning: string) => void) => Promise<string>;
}

export interface ChatClientWithFallback {
  client: ChatModelClient;
  fallbackClient: ChatModelClient | null;
  primaryProvider: ProviderType;
}

export function createChatClient(config: ExtensionConfig, provider?: ProviderType): ChatModelClient {
  return createChatClientWithFallback(config, provider).client;
}

/**
 * Resolve baseUrl and apiKey for a given provider.
 * Priority: providerSettings from UI > legacy top-level config > defaults.
 */
export function resolveProviderConnection(config: ExtensionConfig, provider: ProviderType): { baseUrl: string; apiKey: string } {
  const ps = config.providerSettings?.[provider];

  switch (provider) {
    case 'ollama':
      return {
        baseUrl: `${ps?.url || config.ollamaBaseUrl || PROVIDER_DEFAULTS.ollama.url}/v1`,
        apiKey: 'ollama' // Ollama doesn't require auth but expects non-empty key
      };
    case 'openrouter':
      return {
        baseUrl: ps?.url || config.openRouterBaseUrl || PROVIDER_DEFAULTS.openrouter.url,
        apiKey: ps?.apiKey || config.openRouterApiKey || ''
      };
    case 'mistral': {
      // If user provided their own Mistral API key, go direct
      const mistralKey = ps?.apiKey || '';
      return {
        baseUrl: ps?.url || PROVIDER_DEFAULTS.mistral.url,
        apiKey: mistralKey
      };
    }
    default: {
      // OpenAI-compatible providers: openai, claude, deepseek, grok, gemini
      const defaults = PROVIDER_DEFAULTS[provider] || { url: '' };
      return {
        baseUrl: ps?.url || defaults.url,
        apiKey: ps?.apiKey || ''
      };
    }
  }
}

export function createChatClientWithFallback(config: ExtensionConfig, provider?: ProviderType): ChatClientWithFallback {
  const effectiveProvider = provider || 'mistral';
  const { baseUrl, apiKey } = resolveProviderConnection(config, effectiveProvider);

  const client = new OpenRouterClient({
    baseUrl,
    apiKey,
    defaultModel: undefined
  });

  return { client, fallbackClient: null, primaryProvider: effectiveProvider };
}
