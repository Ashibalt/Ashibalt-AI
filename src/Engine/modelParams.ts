import { logger } from '../logger';

// ─── Core Parameters ───────────────────────────────────────────────

/** Sampling temperature. Low = deterministic (good for code/tools), high = creative. */
export const MODEL_TEMPERATURE = 0.3;

/** Nucleus sampling. 0.95 = лёгкая фильтрация наименее вероятных токенов. */
export const MODEL_TOP_P = 0.95;

/** Number of completions per request. Always 1 for agent use. */
export const MODEL_N = 1;

/** Default max output tokens for agent/chat mode. */
export const MODEL_MAX_TOKENS = 16384;

/** Minimum allowed max_tokens — below this, tool call arguments get truncated. */
export const MODEL_MIN_MAX_TOKENS = 8192;

// ─── Provider Overrides ────────────────────────────────────────────

/**
 * Get effective max_tokens for a given provider/model.
 * Handles provider-specific output limits.
 */
export function getEffectiveMaxTokens(baseUrl: string, model: string): number {
  const isDeepSeek = baseUrl.includes('deepseek.com');
  const isDeepSeekReasoner = model === 'deepseek-reasoner';

  // DeepSeek non-reasoner has 8K output limit
  if (isDeepSeek && !isDeepSeekReasoner) {
    return Math.min(MODEL_MAX_TOKENS, 8192);
  }

  return MODEL_MAX_TOKENS;
}

/**
 * Build the complete params object for a chat/completions API call.
 * Single source of truth — all API calls should use this.
 */
export function buildModelParams(baseUrl: string, model: string): {
  temperature: number;
  top_p: number;
  n: number;
  max_tokens: number;
} {
  const maxTokens = getEffectiveMaxTokens(baseUrl, model);

  logger.log(`[ModelParams] temperature=${MODEL_TEMPERATURE}, top_p=${MODEL_TOP_P}, max_tokens=${maxTokens}, model=${model}`);

  return {
    temperature: MODEL_TEMPERATURE,
    top_p: MODEL_TOP_P,
    n: MODEL_N,
    max_tokens: maxTokens
  };
}
