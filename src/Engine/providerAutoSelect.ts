/**
 * providerAutoSelect.ts
 *
 * Автовыбор провайдера OpenRouter с поддержкой prompt caching.
 * Перед первым запросом к модели запрашивает список эндпоинтов,
 * выбирает оптимального провайдера по критериям: кэш → цена кэша →
 * цена output → скорость (TPS), и кэширует результат на сессию.
 */

import { logger } from '../logger';

// ── Типы ────────────────────────────────────────────

interface EndpointPricing {
  prompt: string;
  completion: string;
  input_cache_read?: string;
  input_cache_write?: string;
  [key: string]: string | number | undefined;
}

interface ThroughputPercentiles {
  p50?: number;
  p75?: number;
  p90?: number;
  p99?: number;
}

interface OpenRouterEndpoint {
  name: string;
  provider_name: string;
  pricing: EndpointPricing;
  throughput_last_30m?: ThroughputPercentiles;
  [key: string]: any;
}

interface EndpointsResponse {
  data: {
    endpoints: OpenRouterEndpoint[];
    [key: string]: any;
  };
}

export interface ProviderSelection {
  order: string[];
  allow_fallbacks: boolean;
}

/**
 * Допуски для группировки "одинаковых" цен.
 * Значения в $/токен (API возвращает цены за токен, не за миллион).
 * $0.03/M = 3e-8 per token  — допуск для cache_read
 * $0.10/M = 1e-7 per token  — допуск для completion (output)
 */
const CACHE_READ_TOLERANCE = 3e-8;   // $0.03 per million tokens
const COMPLETION_TOLERANCE = 1e-7;   // $0.10 per million tokens

function normalizeProviderRoutingName(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-');
}

// ── Сессионный кэш ──────────────────────────────────

const providerCache = new Map<string, ProviderSelection | null>();
const providerRateLimitUntil = new Map<string, number>();

/**
 * Сбросить кэш (для тестов или при необходимости).
 */
export function clearProviderCache(): void {
  providerCache.clear();
  providerRateLimitUntil.clear();
  logger.log('[ProviderAutoSelect] Cache cleared');
}

function providerCooldownKey(modelId: string, providerName: string): string {
  return `${modelId}::${normalizeProviderRoutingName(providerName)}`;
}

function isProviderRateLimited(modelId: string, providerName: string): boolean {
  const key = providerCooldownKey(modelId, providerName);
  const until = providerRateLimitUntil.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    providerRateLimitUntil.delete(key);
    return false;
  }
  return true;
}

export function markProviderRateLimited(modelId: string, providerName: string, ttlMs = 10 * 60 * 1000): void {
  if (!modelId || !providerName) return;

  const normalized = normalizeProviderRoutingName(providerName) || providerName;
  const key = providerCooldownKey(modelId, normalized);
  const until = Date.now() + Math.max(1_000, ttlMs);
  providerRateLimitUntil.set(key, until);

  const cached = providerCache.get(modelId);
  if (cached?.order?.some(p => normalizeProviderRoutingName(p) === normalized)) {
    providerCache.delete(modelId);
    logger.log(`[ProviderAutoSelect] Dropped cache for "${modelId}" because provider "${normalized}" is rate-limited`);
  }

  logger.log(`[ProviderAutoSelect] Marked provider "${providerName}" (routing="${normalized}") as rate-limited for "${modelId}" until ${new Date(until).toISOString()}`);
}

// ── Основная функция ─────────────────────────────────

/**
 * Определяет оптимальный провайдер OpenRouter с поддержкой prompt caching.
 *
 * Алгоритм выбора (только среди провайдеров с input_cache_read):
 *   1. Находим минимальную цену cache_read
 *   2. Формируем группу: все провайдеры с cache_read ≤ min + CACHE_READ_TOLERANCE
 *   3. Внутри группы находим минимальную цену completion (output)
 *   4. Формируем финальную группу: completion ≤ min_completion + COMPLETION_TOLERANCE
 *   5. Из финальной группы выбираем с максимальным throughput_last_30m.p50 (TPS)
 *
 * Если провайдеров с кэшем нет → возвращает null (стандартный механизм OpenRouter).
 *
 * @returns ProviderSelection — жёсткий выбор провайдера
 *          null              — автовыбор отключён, OpenRouter выбирает сам
 */
export async function resolveOpenRouterProvider(
  modelId: string,
  apiKey: string,
  baseUrl: string
): Promise<ProviderSelection | null> {
  // Проверяем что это OpenRouter
  if (!baseUrl.includes('openrouter.ai')) {
    return null;
  }

  // Cache hit
  if (providerCache.has(modelId)) {
    const cached = providerCache.get(modelId)!;
    if (cached?.order?.some(p => isProviderRateLimited(modelId, p))) {
      providerCache.delete(modelId);
      logger.log(`[ProviderAutoSelect] Cache STALE for "${modelId}" (selected provider is rate-limited), recomputing...`);
    } else {
      logger.log(`[ProviderAutoSelect] Cache HIT for "${modelId}" → ${cached ? cached.order[0] : 'null (auto)'}`);
      return cached;
    }
  }

  logger.log(`[ProviderAutoSelect] Cache MISS for "${modelId}", fetching endpoints...`);

  try {
    const endpointsUrl = `${baseUrl.replace(/\/$/, '')}/models/${modelId}/endpoints`;
    logger.log(`[ProviderAutoSelect] GET ${endpointsUrl}`);

    const response = await fetch(endpointsUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Ashibalt-AI/1.0'
      }
    });

    if (!response.ok) {
      logger.error(`[ProviderAutoSelect] API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const json: EndpointsResponse = await response.json();
    const endpoints = json?.data?.endpoints;

    if (!endpoints || !Array.isArray(endpoints) || endpoints.length === 0) {
      logger.log(`[ProviderAutoSelect] No endpoints found for "${modelId}"`);
      return null;
    }

    // ── Собираем только провайдеры с input_cache_read ──────────────────────
    interface CacheCandidate {
      endpoint: OpenRouterEndpoint;
      cacheReadPrice: number;
      completionPrice: number;
      throughput: number;
    }

    const withCache: CacheCandidate[] = [];

    for (const ep of endpoints) {
      const pricing = ep.pricing;
      if (!pricing) continue;

      const hasCaching = pricing.input_cache_read !== undefined && pricing.input_cache_read !== null;
      const cacheReadPrice = hasCaching ? parseFloat(pricing.input_cache_read!) : NaN;

      if (!hasCaching || isNaN(cacheReadPrice)) {
        logger.log(`[ProviderAutoSelect]   ✗ "${ep.provider_name}" — без кэширования`);
        continue;
      }

      const routingName = normalizeProviderRoutingName(ep.provider_name) || ep.provider_name;
      if (isProviderRateLimited(modelId, routingName)) {
        logger.log(`[ProviderAutoSelect]   ⏭ skip "${ep.provider_name}" (routing="${routingName}") — temporary rate-limited`);
        continue;
      }

      const completionPrice = parseFloat(pricing.completion) || 0;
      const throughput = ep.throughput_last_30m?.p50 ?? 0;

      withCache.push({ endpoint: ep, cacheReadPrice, completionPrice, throughput });
      logger.log(`[ProviderAutoSelect]   ✓ "${ep.provider_name}" — cache_read=$${cacheReadPrice}, completion=$${completionPrice}, tps=${throughput}`);
    }

    // ── Нет кэш-провайдеров → null (стандартный механизм OpenRouter) ───────
    if (withCache.length === 0) {
      logger.log(`[ProviderAutoSelect] No caching providers for "${modelId}" → null (standard OpenRouter routing)`);
      providerCache.set(modelId, null);
      return null;
    }

    // ── Шаг 1: группируем по cache_read (в пределах CACHE_READ_TOLERANCE) ──
    const minCacheRead = Math.min(...withCache.map(e => e.cacheReadPrice));
    const cacheReadGroup = withCache.filter(e => e.cacheReadPrice - minCacheRead <= CACHE_READ_TOLERANCE);
    logger.log(
      `[ProviderAutoSelect] cache_read group (min=$${minCacheRead}, tolerance=$${CACHE_READ_TOLERANCE}): ` +
      cacheReadGroup.map(e => `${e.endpoint.provider_name}($${e.cacheReadPrice})`).join(', ')
    );

    // ── Шаг 2: группируем по completion (в пределах COMPLETION_TOLERANCE) ──
    const minCompletion = Math.min(...cacheReadGroup.map(e => e.completionPrice));
    const completionGroup = cacheReadGroup.filter(e => e.completionPrice - minCompletion <= COMPLETION_TOLERANCE);
    logger.log(
      `[ProviderAutoSelect] completion group (min=$${minCompletion}, tolerance=$${COMPLETION_TOLERANCE}): ` +
      completionGroup.map(e => `${e.endpoint.provider_name}($${e.completionPrice})`).join(', ')
    );

    // ── Шаг 3: из финальной группы — самый быстрый (highest TPS) ───────────
    completionGroup.sort((a, b) => b.throughput - a.throughput);
    const best = completionGroup[0];

    const providerName = best.endpoint.provider_name;
    const providerRoutingName = normalizeProviderRoutingName(providerName) || providerName;

    const selection: ProviderSelection = {
      order: [providerRoutingName],
      allow_fallbacks: false
    };

    logger.log(
      `[ProviderAutoSelect] ✓ Selected "${providerName}" → routing "${providerRoutingName}" for "${modelId}" ` +
      `(cache_read=$${best.cacheReadPrice}, completion=$${best.completionPrice}, tps=${best.throughput}, fallbacks=false)`
    );
    providerCache.set(modelId, selection);
    return selection;

  } catch (error: any) {
    logger.error(`[ProviderAutoSelect] Failed to fetch endpoints for "${modelId}":`, error?.message || error);
    return null;
  }
}

