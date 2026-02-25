import { window, workspace, type Memento } from 'vscode';

import { logger } from '../logger';
import type { ProviderType } from './config';

export interface AIModel {
  name: string;
  id: string;
  provider: ProviderType;
  tier?: 'free' | 'pro';
  contextLength?: number;
}

/** Warnings about model capabilities/status discovered from provider API */
export interface ModelWarning {
  modelId: string;
  messages: string[];
}

export interface AshibaltConfig {
  models: AIModel[];
  selectedModelId: string | null;
  codeModel: string | null; // Model for autocomplete and refactoring
}

const DEFAULT_CONFIG: AshibaltConfig = {
  models: [],
  selectedModelId: null,
  codeModel: null
};

const STORAGE_KEY = 'ashibaltConfigV1';

export class ConfigManager {
  private readonly storage: Memento;
  private config: AshibaltConfig;
  private changeListeners: Set<() => void> = new Set();

  constructor(storage: Memento) {
    this.storage = storage;
    this.config = { ...DEFAULT_CONFIG };

    logger.log('ConfigManager initialized. Using VS Code global storage (config.json removed).');
    this.loadConfig();
    this.migrateModels();
  }

  /**
   * Run one-time model migrations (provider renames, stale entries).
   */
  private migrateModels(): void {
    // Remove stale Pony Alpha entries
    const ponyIdx = this.config.models.findIndex(m => m.id === 'openrouter/pony-alpha');
    if (ponyIdx !== -1) {
      this.config.models.splice(ponyIdx, 1);
      if (this.config.selectedModelId === 'openrouter/pony-alpha') {
        this.config.selectedModelId = null as any;
      }
      this.saveConfig();
      logger.log('[ConfigManager] Removed stale openrouter/pony-alpha');
    }
    // Migrate old 'ashibalt' provider → 'mistral'
    let migrated = false;
    for (const m of this.config.models) {
      if (m.provider === 'ashibalt' as any) {
        (m as any).provider = 'mistral';
        migrated = true;
      }
    }
    if (migrated) {
      this.saveConfig();
      logger.log('[ConfigManager] Migrated ashibalt → mistral provider');
    }
  }

  private loadConfig(): void {
    try {
      const stored = this.storage.get<AshibaltConfig>(STORAGE_KEY);
      if (stored) {
        const validProviders: ProviderType[] = ['ollama', 'mistral', 'openrouter', 'openai', 'claude', 'deepseek', 'grok', 'gemini'];
        const validModels = Array.isArray(stored.models) 
          ? stored.models.map(m => ({
              ...m,
              provider: (validProviders.includes(m.provider as ProviderType) ? m.provider : 
                         (m.provider as string) === 'ashibalt' ? 'mistral' : 'mistral') as ProviderType
            }))
          : [];
        
        this.config = {
          ...DEFAULT_CONFIG,
          ...stored,
          models: validModels
        };
        logger.log(`✓ Config loaded from VS Code storage. Models: ${this.config.models.length}, Selected: ${this.config.selectedModelId}`);
      } else {
        this.config = { ...DEFAULT_CONFIG };
        logger.log('No stored config found, using defaults.');
      }
      this.emitChange();
    } catch (error) {
      logger.error('Failed to load config from VS Code storage', error);
      this.config = { ...DEFAULT_CONFIG };
      window.showErrorMessage('Ashibalt: не удалось прочитать настройки из VS Code.');
    }
  }

  private saveConfig(): void {
    this.storage.update(STORAGE_KEY, this.config)
      .then(() => {
        logger.log(`✓ Config saved to VS Code storage. Models: ${this.config.models.length}`);
        this.emitChange();
      }, (error) => {
        logger.error('Failed to persist config to VS Code storage', error);
        window.showErrorMessage('Ashibalt: не удалось сохранить настройки.');
      });
  }

  private emitChange() {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        logger.error('Config change listener failed', error);
      }
    }
  }

  public onDidChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  public reload() {
    this.loadConfig();
  }

  public dispose() {
    this.changeListeners.clear();
  }

  // Public API
  public getConfig(): AshibaltConfig {
    return { ...this.config };
  }

  public getModels(): AIModel[] {
    return [...this.config.models];
  }

  public getSelectedModelId(): string | null {
    return this.config.selectedModelId;
  }

  public getSelectedModel(): AIModel | null {
    if (!this.config.selectedModelId) {
      return null;
    }
    return this.config.models.find(m => m.id === this.config.selectedModelId) || null;
  }

  public getCodeModel(): string | null {
    return this.config.codeModel;
  }

  public addModel(model: AIModel): void {
    // Check if model already exists
    const exists = this.config.models.some(m => m.id === model.id && m.provider === model.provider);
    if (exists) {
      throw new Error('Model already exists');
    }

    this.config.models.push(model);
    this.saveConfig();
  }

  public deleteModel(modelId: string): void {
    const initialLength = this.config.models.length;
    this.config.models = this.config.models.filter(m => m.id !== modelId);
    
    if (this.config.models.length < initialLength) {
      // If deleted model was selected, clear selection
      if (this.config.selectedModelId === modelId) {
        this.config.selectedModelId = null;
      }
      
      // If deleted model was code model, clear it
      if (this.config.codeModel === modelId) {
        this.config.codeModel = null;
      }
      
      this.saveConfig();
    }
  }

  public clearAllModels(): void {
    this.config.models = [];
    this.config.selectedModelId = null;
    this.config.codeModel = null;
    this.saveConfig();
  }

  public setSelectedModel(modelId: string | null): void {
    if (modelId !== null) {
      const model = this.config.models.find(m => m.id === modelId);
      if (!model) {
        throw new Error('Model not found');
      }
    }
    
    this.config.selectedModelId = modelId;
    this.saveConfig();
  }

  public setCodeModel(modelId: string | null): void {
    // Handle special "disabled" value - treat as null
    if (modelId === 'disabled') {
      this.config.codeModel = null;
      this.saveConfig();
      return;
    }
    
    if (modelId !== null) {
      const model = this.config.models.find(m => m.id === modelId);
      if (!model) {
        throw new Error('Model not found');
      }
    }
    
    this.config.codeModel = modelId;
    this.saveConfig();
  }

  public getConfigPath(): string {
    return 'VS Code global storage (config.json не используется)';
  }

  /**
   * Fetch models from local Ollama instance
   */
  public async fetchOllamaModels(): Promise<AIModel[]> {
    const config = workspace.getConfiguration("ashibaltAi");
    const ollamaUrl = config.get<string>("ollamaBaseUrl", "http://localhost:11434");

    try {
      logger.log(`[ConfigManager] Fetching Ollama models from ${ollamaUrl}/api/tags`);
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch Ollama models: ${response.status}`);
      }

      const data = await response.json() as any;
      const ollamaModels: AIModel[] = (data.models || []).map((m: any) => ({
        id: m.name || m.model,
        name: m.name || m.model,
        provider: 'ollama' as const,
      }));

      logger.log(`[ConfigManager] Loaded ${ollamaModels.length} Ollama models`);

      // Replace existing Ollama models, preserve others
      const otherModels = this.config.models.filter(m => m.provider !== 'ollama');
      this.config.models = [...ollamaModels, ...otherModels];
      this.saveConfig();

      return ollamaModels;
    } catch (error) {
      logger.error('[ConfigManager] Failed to fetch Ollama models', error);
      return this.config.models.filter(m => m.provider === 'ollama');
    }
  }

  /**
   * Generic model fetching for any provider.
   * Most providers use OpenAI-compatible GET /models with Bearer token.
   * Special cases: Ollama (/api/tags, no auth), Claude (x-api-key header), Gemini (key in query param).
   */
  /** Cached warnings from last fetchProviderModels call */
  private _modelWarnings: Map<string, string[]> = new Map();

  /** Cached contextLength from last fetchProviderModels calls (modelId → contextLength) */
  private _contextLengthCache: Map<string, number> = new Map();

  /** Get warnings for a specific model (populated after fetchProviderModels) */
  public getModelWarnings(modelId: string): string[] {
    return this._modelWarnings.get(modelId) || [];
  }

  /** Get cached contextLength for a model (populated after fetchProviderModels) */
  public getCachedContextLength(modelId: string): number | undefined {
    return this._contextLengthCache.get(modelId);
  }

  /**
   * Update contextLength on saved models that are missing it.
   * Called automatically after fetchProviderModels returns fresh data.
   */
  private updateSavedModelsContextLength(fetchedModels: AIModel[]): void {
    let updated = false;
    for (const fetched of fetchedModels) {
      if (!fetched.contextLength) continue;
      // Cache for lookup
      this._contextLengthCache.set(fetched.id, fetched.contextLength);
      // Update saved model if missing contextLength
      const saved = this.config.models.find(m => m.id === fetched.id && m.provider === fetched.provider);
      if (saved && !saved.contextLength) {
        saved.contextLength = fetched.contextLength;
        updated = true;
      }
    }
    if (updated) {
      this.saveConfig();
    }
  }

  /**
   * Fetch context length for a single model from provider API.
   * Used when a model is added manually (no prior fetch of full model list).
   */
  public async fetchSingleModelContextLength(provider: ProviderType, modelId: string, baseUrl: string, apiKey: string): Promise<number | undefined> {
    try {
      let url: string;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      let extractContextLength: (data: any) => number | undefined;

      switch (provider) {
        case 'mistral': {
          // Mistral supports GET /v1/models/{model_id}
          url = `${baseUrl}/models/${encodeURIComponent(modelId)}`;
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
          extractContextLength = (data) => data?.max_context_length || undefined;
          break;
        }
        case 'openrouter': {
          // OpenRouter: filter from full list (no single-model endpoint)
          url = `${baseUrl}/models`;
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
          extractContextLength = (data) => {
            const model = (data?.data || []).find((m: any) => m.id === modelId);
            return model?.context_length || undefined;
          };
          break;
        }
        case 'deepseek':
          return 128000; // All DeepSeek models use 128K
        case 'claude': {
          url = `${baseUrl}/models`;
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
          extractContextLength = (data) => {
            const model = (data?.data || []).find((m: any) => m.id === modelId);
            return model?.context_window || undefined;
          };
          break;
        }
        case 'gemini': {
          url = `${baseUrl}/models/${modelId}?key=${apiKey}`;
          extractContextLength = (data) => data?.inputTokenLimit || undefined;
          break;
        }
        default: {
          // OpenAI-compatible: try /models endpoint and filter
          url = `${baseUrl}/models`;
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
          extractContextLength = (data) => {
            const model = (data?.data || []).find((m: any) => m.id === modelId);
            return model?.context_length || model?.context_window || undefined;
          };
          break;
        }
      }

      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        return undefined;
      }

      const data = await response.json() as any;
      const contextLength = extractContextLength(data);
      if (contextLength) {
        this._contextLengthCache.set(modelId, contextLength);
      }
      return contextLength;
    } catch (error) {
      logger.error(`[ConfigManager] Error fetching single model info for ${modelId}`, error);
      return undefined;
    }
  }

  public async fetchProviderModels(provider: ProviderType, baseUrl: string, apiKey: string): Promise<AIModel[]> {
    try {
      let url: string;
      let headers: Record<string, string> = { 'Content-Type': 'application/json' };
      let parseModels: (data: any) => AIModel[];
      let extractWarnings: ((data: any) => Map<string, string[]>) | undefined;

      switch (provider) {
        case 'ollama': {
          url = `${baseUrl}/api/tags`;
          parseModels = (data) => (data.models || []).map((m: any) => ({
            id: m.name || m.model,
            name: m.name || m.model,
            provider: 'ollama' as const,
          }));
          break;
        }
        case 'claude': {
          url = `${baseUrl}/models`;
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
          parseModels = (data) => (data.data || []).map((m: any) => ({
            id: m.id,
            name: m.display_name || m.id,
            provider: 'claude' as const,
            contextLength: m.context_window || undefined,
          }));
          break;
        }
        case 'gemini': {
          url = `${baseUrl}/models?key=${apiKey}`;
          parseModels = (data) => (data.models || []).filter((m: any) => 
            m.supportedGenerationMethods?.includes('generateContent')
          ).map((m: any) => ({
            id: m.name?.replace('models/', '') || m.name,
            name: m.displayName || m.name,
            provider: 'gemini' as const,
            contextLength: m.inputTokenLimit || undefined,
          }));
          break;
        }
        case 'openrouter': {
          url = `${baseUrl}/models`;
          if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }
          parseModels = (data) => (data.data || []).map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            provider: 'openrouter' as const,
            contextLength: m.context_length || undefined,
          }));
          extractWarnings = (data) => {
            const warnings = new Map<string, string[]>();
            for (const m of (data.data || [])) {
              const msgs: string[] = [];
              // Check for tool support
              const params = m.supported_parameters || [];
              if (!params.includes('tools') && !params.includes('tool_choice')) {
                msgs.push('⚠️ Модель не поддерживает вызов инструментов (tools). Агентный режим не будет работать.');
              }
              // Check expiration
              if (m.expiration_date) {
                msgs.push(`⏰ Модель будет удалена: ${m.expiration_date}`);
              }
              if (msgs.length > 0) warnings.set(m.id, msgs);
            }
            return warnings;
          };
          break;
        }
        case 'mistral': {
          url = `${baseUrl}/models`;
          if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }
          parseModels = (data) => (data.data || []).map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            provider: 'mistral' as const,
            contextLength: m.max_context_length || undefined,
          }));
          extractWarnings = (data) => {
            const warnings = new Map<string, string[]>();
            for (const m of (data.data || [])) {
              const msgs: string[] = [];
              if (m.capabilities && m.capabilities.function_calling === false) {
                msgs.push('⚠️ Модель не поддерживает вызов инструментов (function_calling). Агентный режим не будет работать.');
              }
              if (m.capabilities && m.capabilities.completion_chat === false) {
                msgs.push('⚠️ Модель не поддерживает чат (completion_chat). Эта модель предназначена для других задач.');
              }
              if (m.deprecation) {
                const replacement = m.deprecation_replacement_model ? ` Замена: ${m.deprecation_replacement_model}` : '';
                msgs.push(`⚠️ Модель deprecated (устарела) с ${m.deprecation}.${replacement}`);
              }
              if (msgs.length > 0) warnings.set(m.id, msgs);
            }
            return warnings;
          };
          break;
        }
        case 'deepseek': {
          url = `${baseUrl}/models`;
          if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }
          parseModels = (data) => (data.data || []).map((m: any) => ({
            id: m.id,
            name: m.id,
            provider: 'deepseek' as const,
            contextLength: 128000, // DeepSeek fixed: all models use 128K
          }));
          break;
        }
        default: {
          // OpenAI-compatible: openai, grok
          url = `${baseUrl}/models`;
          if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }
          parseModels = (data) => (data.data || []).map((m: any) => ({
            id: m.id,
            name: m.id,
            provider: provider,
            contextLength: m.context_length || m.context_window || undefined,
          }));
          break;
        }
      }

      logger.log(`[ConfigManager] Fetching ${provider} models from ${url}`);
      const response = await fetch(url, { method: 'GET', headers });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as any;
      const fetchedModels = parseModels(data);

      // Extract and cache warnings
      if (extractWarnings) {
        const newWarnings = extractWarnings(data);
        for (const [id, msgs] of newWarnings) {
          this._modelWarnings.set(id, msgs);
        }
      }

      logger.log(`[ConfigManager] Loaded ${fetchedModels.length} models from ${provider}`);

      if (fetchedModels.length === 0) {
        logger.log(`[ConfigManager] ${provider} returned empty models list`);
        return [];
      }

      // Update contextLength on already-saved models that are missing it
      this.updateSavedModelsContextLength(fetchedModels);

      // For Ollama (local, few models) — auto-save all models
      // For cloud providers with potentially hundreds of models — return without saving
      if (provider === 'ollama') {
        const otherModels = this.config.models.filter(m => m.provider !== provider);
        this.config.models = [...fetchedModels, ...otherModels];
        this.saveConfig();
      }

      return fetchedModels;
    } catch (error) {
      logger.error(`[ConfigManager] Failed to fetch ${provider} models`, error);
      throw error;
    }
  }
}

// Singleton instance
let configManagerInstance: ConfigManager | null = null;

/**
 * Get the ConfigManager singleton instance.
 * Requires the instance to be created via setConfigManager first.
 */
export function getConfigManager(): ConfigManager {
  if (!configManagerInstance) {
    throw new Error('ConfigManager not initialized. Call setConfigManager() first.');
  }
  return configManagerInstance;
}

/**
 * Set the ConfigManager instance (used when created externally in extension.ts)
 */
export function setConfigManager(instance: ConfigManager): void {
  configManagerInstance = instance;
}
