import { workspace } from "vscode";

export type ProviderType = 'ollama' | 'mistral' | 'openrouter' | 'openai' | 'claude' | 'deepseek' | 'grok' | 'gemini';

export interface ProviderSettings {
  url: string;
  apiKey: string;
}

/** Default base URLs for each provider */
export const PROVIDER_DEFAULTS: Record<ProviderType, { url: string }> = {
  ollama:     { url: 'http://localhost:11434' },
  mistral:    { url: 'https://api.mistral.ai/v1' },
  openrouter: { url: 'https://openrouter.ai/api/v1' },
  openai:     { url: 'https://api.openai.com/v1' },
  claude:     { url: 'https://api.anthropic.com/v1' },
  deepseek:   { url: 'https://api.deepseek.com/v1' },
  grok:       { url: 'https://api.x.ai/v1' },
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta' },
};

export interface ExtensionConfig {
  maxTokens: number;
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  ollamaBaseUrl: string;
  /** Per-provider URL + API key overrides from settings panel */
  providerSettings: Partial<Record<ProviderType, ProviderSettings>>;
}

export function loadExtensionConfig(): ExtensionConfig {
  const config = workspace.getConfiguration("ashibaltAi");
  const maxTokens = config.get<number>("maxTokens", 4096);
  const openRouterBaseUrl = config.get<string>("openRouterBaseUrl", "https://openrouter.ai/api/v1");
  const ollamaBaseUrl = config.get<string>("ollamaBaseUrl", "http://localhost:11434");
  const openRouterApiKey = config.get<string>("openRouterApiKey", "");

  // Load per-provider settings
  const providerSettings: Partial<Record<ProviderType, ProviderSettings>> = {};
  const stored = config.get<Record<string, ProviderSettings>>("providerSettings", {});
  for (const [key, val] of Object.entries(stored)) {
    if (val && typeof val === 'object') {
      providerSettings[key as ProviderType] = {
        url: val.url || PROVIDER_DEFAULTS[key as ProviderType]?.url || '',
        apiKey: val.apiKey || ''
      };
    }
  }

  return {
    maxTokens,
    openRouterApiKey,
    openRouterBaseUrl,
    ollamaBaseUrl,
    providerSettings
  };
}
