/**
 * providerAutoSelect.ts
 *
 * Автовыбор провайдера OpenRouter с поддержкой prompt caching.
 * Перед первым запросом к модели запрашивает список эндпоинтов,
 * выбирает самый дешёвый провайдер с кэшированием и кэширует
 * результат в Map на уровне модуля (до перезапуска расширения).
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

interface OpenRouterEndpoint {
  name: string;
  provider_name: string;
  pricing: EndpointPricing;
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
 * @returns `{ order: [providerName], allow_fallbacks: false }` — если провайдер выбран (жёсткий выбор)
 *          `null` — если автовыбор отключён (нет кэш-провайдеров или слишком дорого)
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
      // НЕ записываем в кэш — следующий запрос попробует снова
      return null;
    }

    const json: EndpointsResponse = await response.json();
    const endpoints = json?.data?.endpoints;

    if (!endpoints || !Array.isArray(endpoints) || endpoints.length === 0) {
      logger.log(`[ProviderAutoSelect] No endpoints found for "${modelId}"`);
      // Do NOT cache null — empty endpoints may be transient (all providers blacklisted or API hiccup)
      return null;
    }

    // Разделяем на провайдеры с кэшированием и без
    const withCache: { endpoint: OpenRouterEndpoint; promptPrice: number; cacheReadPrice: number }[] = [];
    const withoutCache: { endpoint: OpenRouterEndpoint; promptPrice: number }[] = [];

    for (const ep of endpoints) {
      const pricing = ep.pricing;
      if (!pricing) continue;

      const promptPrice = parseFloat(pricing.prompt);
      const hasCaching = pricing.input_cache_read !== undefined && pricing.input_cache_read !== null;
      const cacheReadPrice = hasCaching ? parseFloat(pricing.input_cache_read!) : 0;

      const routingName = normalizeProviderRoutingName(ep.provider_name) || ep.provider_name;
      if (isProviderRateLimited(modelId, routingName)) {
        logger.log(`[ProviderAutoSelect]   ⏭ skip "${ep.provider_name}" (routing="${routingName}") — temporary rate-limited`);
        continue;
      }

      if (hasCaching && !isNaN(cacheReadPrice)) {
        withCache.push({ endpoint: ep, promptPrice, cacheReadPrice });
        logger.log(`[ProviderAutoSelect]   ✓ "${ep.provider_name}" — кэширование: prompt=$${promptPrice}, cache_read=$${cacheReadPrice}`);
      } else {
        withoutCache.push({ endpoint: ep, promptPrice });
        logger.log(`[ProviderAutoSelect]   ✗ "${ep.provider_name}" — без кэширования: prompt=$${promptPrice}`);
      }
    }

    // Нет провайдеров с кэшированием — fallback к самому дешёвому без кэша
    if (withCache.length === 0) {
      if (withoutCache.length > 0) {
        withoutCache.sort((a, b) => a.promptPrice - b.promptPrice);
        const bestNoCache = withoutCache[0];
        const providerName = bestNoCache.endpoint.provider_name;
        const providerRoutingName = normalizeProviderRoutingName(providerName) || providerName;
        const selection: ProviderSelection = {
          order: [providerRoutingName],
          allow_fallbacks: false
        };
        logger.log(`[ProviderAutoSelect] No caching providers for "${modelId}" → selected non-cache "${providerName}" (routing="${providerRoutingName}", fallbacks=false)`);
        providerCache.set(modelId, selection);
        return selection;
      }

      logger.log(`[ProviderAutoSelect] No available providers left for "${modelId}" (all filtered/rate-limited) → null`);
      providerCache.set(modelId, null);
      return null;
    }

    // Сортировка: по prompt price ASC, при равенстве — по cache_read ASC
    withCache.sort((a, b) => {
      if (a.promptPrice !== b.promptPrice) return a.promptPrice - b.promptPrice;
      return a.cacheReadPrice - b.cacheReadPrice;
    });

    const best = withCache[0];

    // Защитная проверка 3x: если prompt цена кэш-провайдера > 3x мин. цены без кэша
    if (withoutCache.length > 0) {
      const minNonCachePrompt = Math.min(...withoutCache.map(e => e.promptPrice));
      if (best.promptPrice > minNonCachePrompt * 3) {
        logger.log(`[ProviderAutoSelect] ⚠ 3x guard triggered: cache provider "${best.endpoint.provider_name}" prompt=$${best.promptPrice} > 3× min non-cache=$${minNonCachePrompt} → null`);
        providerCache.set(modelId, null);
        return null;
      }
    }

    const providerName = best.endpoint.provider_name;
    const providerRoutingName = normalizeProviderRoutingName(providerName) || providerName;

    const selection: ProviderSelection = {
      order: [providerRoutingName],
      allow_fallbacks: false
    };

    logger.log(`[ProviderAutoSelect] ✓ Selected "${providerName}" → routing "${providerRoutingName}" for "${modelId}" (prompt=$${best.promptPrice}, cache_read=$${best.cacheReadPrice}, fallbacks=false)`);
    providerCache.set(modelId, selection);
    return selection;
  } catch (error: any) {
    logger.error(`[ProviderAutoSelect] Failed to fetch endpoints for "${modelId}":`, error?.message || error);
    // НЕ записываем в кэш — следующий запрос попробует снова
    return null;
  }
}
