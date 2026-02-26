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
  /** List of providers to allow (OpenRouter picks best among them, sticky routing preserved). */
  only?: string[];
  /** Legacy: force strict order. Deprecated — breaks sticky routing. */
  order?: string[];
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

// ── Persistent storage ──────────────────────────────
// Allows cache to survive VS Code restarts

interface CacheMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: any): Thenable<void>;
}

const STORAGE_KEY = 'providerAutoSelectCache';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
let _storage: CacheMemento | undefined;

/**
 * Initialize persistent storage. Call once from extension activate().
 * Loads previously saved provider selections from globalState.
 */
export function initProviderCacheStorage(storage: CacheMemento): void {
  _storage = storage;
  const persisted: Record<string, { selection: ProviderSelection | null; savedAt: number }> | undefined
    = storage.get(STORAGE_KEY, undefined as any);
  if (persisted && typeof persisted === 'object') {
    let loaded = 0;
    let skippedLegacy = 0;
    for (const [key, entry] of Object.entries(persisted)) {
      if (entry && typeof entry === 'object' && typeof entry.savedAt === 'number') {
        if (Date.now() - entry.savedAt < CACHE_MAX_AGE_MS) {
          // Skip legacy single-provider entries — they break sticky routing
          const sel = entry.selection;
          if (sel && !sel.only && sel.order && sel.allow_fallbacks === false) {
            skippedLegacy++;
            continue;
          }
          providerCache.set(key, entry.selection);
          loaded++;
        }
      }
    }
    if (loaded > 0) {
      logger.log(`[ProviderAutoSelect] Restored ${loaded} cached provider selections from storage`);
    }
    if (skippedLegacy > 0) {
      logger.log(`[ProviderAutoSelect] Skipped ${skippedLegacy} legacy format entries (will recompute)`);
      persistCache(); // Remove legacy entries from storage
    }
  }
}

/** Persist the current cache to globalState (debounced-safe). */
function persistCache(): void {
  if (!_storage) return;
  const obj: Record<string, { selection: ProviderSelection | null; savedAt: number }> = {};
  for (const [key, value] of providerCache) {
    obj[key] = { selection: value, savedAt: Date.now() };
  }
  _storage.update(STORAGE_KEY, obj);
}

/**
 * Сбросить кэш (для тестов или при необходимости).
 */
export function clearProviderCache(): void {
  providerCache.clear();
  providerRateLimitUntil.clear();
  persistCache();
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
  const cachedList = cached?.only ?? cached?.order ?? [];
  if (cachedList.some(p => normalizeProviderRoutingName(p) === normalized)) {
    providerCache.delete(modelId);
    persistCache();
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
    // Invalidate legacy format: {order:[one], allow_fallbacks:false} — breaks sticky routing
    if (cached && !cached.only && cached.order && cached.allow_fallbacks === false) {
      providerCache.delete(modelId);
      persistCache();
      logger.log(`[ProviderAutoSelect] Cache LEGACY for "${modelId}" (old single-provider format) — cleared, recomputing...`);
    } else if (cached?.only?.some(p => isProviderRateLimited(modelId, p)) || cached?.order?.some(p => isProviderRateLimited(modelId, p))) {
      providerCache.delete(modelId);
      logger.log(`[ProviderAutoSelect] Cache STALE for "${modelId}" (selected provider is rate-limited), recomputing...`);
    } else {
      logger.log(`[ProviderAutoSelect] Cache HIT for "${modelId}" → ${cached ? (cached.only ?? cached.order ?? []).join(', ') : 'null (auto)'}`);
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
      persistCache();
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

    // ── Шаг 3: собираем ВСЕ провайдеры из финальной группы → only-list ──────
    // Передаём список в `only` вместо `order`, чтобы OpenRouter сохранял
    // sticky routing и сам выбирал лучший endpoint среди кеш-провайдеров.
    // С `order` и `allow_fallbacks:false` sticky routing отключается.
    completionGroup.sort((a, b) => b.throughput - a.throughput);

    const onlyList = completionGroup.map(
      e => normalizeProviderRoutingName(e.endpoint.provider_name) || e.endpoint.provider_name
    );

    const selection: ProviderSelection = {
      only: onlyList,
      allow_fallbacks: true
    };

    logger.log(
      `[ProviderAutoSelect] ✓ Cache providers for "${modelId}": [${onlyList.join(', ')}] ` +
      `(allow_fallbacks=true, sticky routing preserved by OpenRouter)`
    );
    providerCache.set(modelId, selection);
    persistCache();
    return selection;

  } catch (error: any) {
    logger.error(`[ProviderAutoSelect] Failed to fetch endpoints for "${modelId}":`, error?.message || error);
    return null;
  }
}

