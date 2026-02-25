/**
 * Context Cache для Agent Loop
 * Кэширует прочитанные файлы чтобы избежать повторных чтений
 */

interface CachedFile {
  content: string;
  lines: string[];
  timestamp: number;
  totalLines: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export class ContextCache {
  private cache: Map<string, CachedFile> = new Map();
  private maxCacheSize: number;
  private maxAgeMs: number;
  private stats: CacheStats = { hits: 0, misses: 0, size: 0 };

  constructor(options: { maxCacheSize?: number; maxAgeMs?: number } = {}) {
    this.maxCacheSize = options.maxCacheSize ?? 50; // Max 50 files
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Получить файл из кэша
   */
  get(filePath: string): CachedFile | undefined {
    const normalizedPath = this.normalizePath(filePath);
    const cached = this.cache.get(normalizedPath);
    
    if (!cached) {
      this.stats.misses++;
      return undefined;
    }

    // Проверяем свежесть
    if (Date.now() - cached.timestamp > this.maxAgeMs) {
      this.cache.delete(normalizedPath);
      this.stats.size = this.cache.size;
      this.stats.misses++;
      return undefined;
    }

    this.stats.hits++;
    return cached;
  }

  /**
   * Добавить файл в кэш
   */
  set(filePath: string, content: string): void {
    const normalizedPath = this.normalizePath(filePath);
    
    // Если кэш переполнен - удаляем старейшую запись
    if (this.cache.size >= this.maxCacheSize && !this.cache.has(normalizedPath)) {
      this.evictOldest();
    }

    const lines = content.split('\n');
    this.cache.set(normalizedPath, {
      content,
      lines,
      timestamp: Date.now(),
      totalLines: lines.length
    });
    this.stats.size = this.cache.size;
  }

  /**
   * Инвалидировать файл в кэше (после редактирования)
   */
  invalidate(filePath: string): void {
    const normalizedPath = this.normalizePath(filePath);
    this.cache.delete(normalizedPath);
    this.stats.size = this.cache.size;
  }

  /**
   * Инвалидировать все файлы
   */
  clear(): void {
    this.cache.clear();
    this.stats.size = 0;
  }

  /**
   * Получить статистику кэша
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Получить часть файла из кэша (если он там есть)
   * Возвращает undefined если файла нет в кэше
   */
  getRange(filePath: string, startLine: number, endLine?: number): { 
    content: string; 
    startLine: number; 
    endLine: number; 
    totalLines: number 
  } | undefined {
    const cached = this.get(filePath);
    if (!cached) return undefined;

    const start = Math.max(0, startLine - 1); // Convert to 0-based
    const end = endLine ? Math.min(endLine, cached.totalLines) : cached.totalLines;
    
    const selectedLines = cached.lines.slice(start, end);
    
    return {
      content: selectedLines.join('\n'),
      startLine: start + 1,
      endLine: Math.min(end, cached.totalLines),
      totalLines: cached.totalLines
    };
  }

  /**
   * Проверить есть ли файл в кэше и свежий ли он
   */
  has(filePath: string): boolean {
    return this.get(filePath) !== undefined;
  }

  private normalizePath(filePath: string): string {
    // Нормализуем слэши и приводим к lowercase для Windows
    return filePath.replace(/\\/g, '/').toLowerCase();
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, value] of this.cache.entries()) {
      if (value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}

// ============================================================================
// FileTime — track which files were read per session
// Prevents editing/overwriting files that haven't been read first.
// Inspired by OpenCode's FileTime.assert() mechanism.
// ============================================================================

class FileTimeTracker {
  /** sessionID → Map<normalizedPath, readTimestamp> */
  private sessions = new Map<string, Map<string, number>>();
  /** The current active session ID (set by agentLoop before each loop) */
  private _currentSession: string = 'default';

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
  }

  /** Set the current active session */
  setSession(sessionId: string): void {
    this._currentSession = sessionId;
  }

  get currentSession(): string {
    return this._currentSession;
  }

  /** Record that a file was read in the current session */
  read(filePath: string): void {
    const key = this.normalizePath(filePath);
    if (!this.sessions.has(this._currentSession)) {
      this.sessions.set(this._currentSession, new Map());
    }
    this.sessions.get(this._currentSession)!.set(key, Date.now());
  }

  /**
   * Assert that the file was read in the current session before allowing edit/write.
   * Returns null if OK, or error string if not read.
   */
  assert(filePath: string): string | null {
    const key = this.normalizePath(filePath);
    const readTime = this.sessions.get(this._currentSession)?.get(key);
    if (!readTime) {
      return `You must read the file "${filePath}" with read_file before editing it. ` +
        `This prevents blind overwrites and ensures you see the current content.`;
    }
    return null; // OK
  }

  /** Clear all sessions */
  clearAll(): void {
    this.sessions.clear();
  }
}

// Singleton instances
let globalCache: ContextCache | null = null;
let globalFileTime: FileTimeTracker | null = null;

export function getContextCache(): ContextCache {
  if (!globalCache) {
    globalCache = new ContextCache();
  }
  return globalCache;
}

export function getFileTime(): FileTimeTracker {
  if (!globalFileTime) {
    globalFileTime = new FileTimeTracker();
  }
  return globalFileTime;
}

export function resetContextCache(): void {
  if (globalCache) {
    globalCache.clear();
  }
  globalCache = null;
}

export function resetFileTime(): void {
  if (globalFileTime) {
    globalFileTime.clearAll();
  }
  globalFileTime = null;
}
