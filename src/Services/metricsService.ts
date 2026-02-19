
import { logger } from '../logger';
import { uidManager } from '../Storage/uidManager';

/**
 * ──── METRICS SERVER URL ────
 * Change this constant when deploying to production.
 * Local dev: http://localhost:4200
 * Production: set your server URL here
 */
export const METRICS_SERVER_URL = '';
export const METRICS_API_KEY = '';

const SEND_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 10_000; // 10 seconds

export interface UsageMetrics {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  toolUsage: Record<string, number>;  // tool_name -> call count
  modelUsage: Record<string, number>; // model_id -> request count
  platform?: string;       // win32 | darwin | linux
  extensionVersion?: string;
}

/**
 * Client-side metrics service.
 * 
 * Responsibilities:
 *  - Accumulate local usage metrics
 *  - Send metrics to server when toggle is enabled
 *  - Periodic send (once per 24h if enabled)
 *  - Gracefully handle server unavailability
 */
export class MetricsService {
  private enabled = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private metricsUrl: string;
  private latestMetrics: UsageMetrics | null = null;

  constructor(serverUrl?: string) {
    this.metricsUrl = serverUrl || METRICS_SERVER_URL;
  }

  /**
   * Enable metrics sending. Immediately sends current metrics,
   * then starts periodic timer (24h).
   */
  enable(currentMetrics: UsageMetrics): void {
    this.enabled = true;
    this.latestMetrics = currentMetrics;
    this.sendMetrics(currentMetrics);
    this.startPeriodicSend();
    logger.log('[METRICS] Enabled');
  }

  /**
   * Disable metrics sending. Stops periodic timer.
   */
  disable(): void {
    this.enabled = false;
    this.latestMetrics = null;
    this.stopPeriodicSend();
    logger.log('[METRICS] Disabled');
  }

  /**
   * Update latest metrics snapshot (for periodic resend).
   */
  updateMetrics(metrics: UsageMetrics): void {
    this.latestMetrics = metrics;
  }

  /**
   * Send metrics snapshot. Called when:
   *  1. User enables toggle
   *  2. Periodic timer fires (24h)
   * 
   * Fire-and-forget: errors are logged, never thrown.
   * If disabled between call and execution, silently returns.
   */
  async sendMetrics(metrics: UsageMetrics): Promise<void> {
    if (!this.enabled) return;

    const uid = uidManager.getUid();
    if (!uid) {
      logger.log('[METRICS] No UID, skipping send');
      return;
    }

    const payload = {
      uid,
      timestamp: new Date().toISOString(),
      metrics: {
        totalRequests: metrics.totalRequests,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        toolUsage: metrics.toolUsage,
        modelUsage: metrics.modelUsage,
        platform: metrics.platform || process.platform,
        extensionVersion: metrics.extensionVersion || '',
      }
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (METRICS_API_KEY) {
        headers['Authorization'] = `Bearer ${METRICS_API_KEY}`;
      }

      const res = await fetch(`${this.metricsUrl}/api/metrics`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) {
        logger.log(`[METRICS] Sent successfully (status ${res.status})`);
      } else {
        logger.log(`[METRICS] Server returned ${res.status}: ${res.statusText}`);
      }
    } catch (err: any) {
      // Network error, timeout, server down — all fine, just log
      if (err?.name === 'AbortError') {
        logger.log('[METRICS] Send timed out');
      } else {
        logger.log(`[METRICS] Send failed: ${err?.message || err}`);
      }
    }
  }

  private startPeriodicSend(): void {
    this.stopPeriodicSend();
    this.intervalHandle = setInterval(() => {
      if (this.enabled && this.latestMetrics) {
        this.sendMetrics(this.latestMetrics);
      }
    }, SEND_INTERVAL_MS);
  }

  private stopPeriodicSend(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  dispose(): void {
    this.stopPeriodicSend();
  }
}

// Singleton
export const metricsService = new MetricsService();
