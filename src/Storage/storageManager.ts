import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ExtensionContext } from 'vscode';
import { logger } from '../logger';

/**
 * Sanitize sessionId to prevent path traversal attacks.
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

// Action types for sequential message content
export interface TextAction {
  type: 'text';
  content: string;
}

export interface FileReadAction {
  type: 'read_file';
  fileName: string;
  filePath: string;
  success: boolean;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  truncated?: boolean;
  error?: string;
}

export interface FileEditAction {
  type: 'edit_file';
  fileName: string;
  filePath: string;
  success: boolean;
  error?: string;
  linesAdded?: number;
  linesRemoved?: number;
  startLine?: number;
}

export interface FileCreateAction {
  type: 'create_file';
  fileName: string;
  filePath: string;
  success: boolean;
  error?: string;
}

export interface FileDeleteAction {
  type: 'delete_file';
  fileName: string;
  filePath: string;
  success: boolean;
  error?: string;
}

export interface TerminalAction {
  type: 'terminal';
  command: string;
  exitCode?: number;
  success: boolean;
  rejected?: boolean;
  error?: string;
}

export interface SearchAction {
  type: 'search';
  query: string;
  totalResults: number;
  success: boolean;
}

export interface WebSearchAction {
  type: 'web_search';
  query: string;
  resultsCount: number;
  success: boolean;
}

export interface DiagnoseAction {
  type: 'diagnose';
  filePath: string;
  errorsCount: number;
  success: boolean;
}

export interface ListFilesAction {
  type: 'list_files';
  path: string;
  success: boolean;
}

export interface FetchUrlAction {
  type: 'fetch_url';
  url: string;
  success: boolean;
}

export interface RunTestsAction {
  type: 'run_tests';
  passed: number;
  failed: number;
  total: number;
  success: boolean;
}

export interface FindReferencesAction {
  type: 'find_references';
  totalReferences: number;
  filesAffected: number;
  success: boolean;
}

export type MessageAction = TextAction | FileReadAction | FileEditAction | FileCreateAction | FileDeleteAction | TerminalAction | SearchAction | WebSearchAction | DiagnoseAction | ListFilesAction | FetchUrlAction | RunTestsAction | FindReferencesAction;

// Legacy support
export type FileAction = FileReadAction;

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  timestamp?: number;
  tokenCount?: number;
  attachments?: any[];
  actions?: MessageAction[];  // New: ordered sequence of text and file actions
  fileActions?: FileAction[]; // Legacy: kept for backward compatibility
  modelName?: string; // Model name used to generate this message (for assistant messages)
}

export class StorageManager {
  private root: string;
  private sessionsIndexPath: string;
  private sessionsDir: string;

  constructor(rootPath?: string) {
    this.root = rootPath || path.join(os.homedir(), '.Ashibalt');
    this.sessionsIndexPath = path.join(this.root, 'sessions.json');
    this.sessionsDir = path.join(this.root, 'sessions');
  }

  async init() {
    // ensure root and sessions dir exist
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(this.sessionsDir, { recursive: true });
    // ensure sessions index exists
    try {
      await fs.access(this.sessionsIndexPath);
    } catch (e) {
      await this.atomicWrite(this.sessionsIndexPath, JSON.stringify([]));
    }
    // ensure README exists with guidance for users
    try {
      const readmePath = path.join(this.root, 'README.txt');
      try {
        await fs.access(readmePath);
      } catch (err) {
        const text = "Здесь хранится конфиругация и история сессий. Убедитесь что при удалении сессионных файлов, вы совершаете это осознавая что история сессий будет удалена";
        await fs.writeFile(readmePath, text, 'utf8');
      }
    } catch (e) {
      console.error('Failed to create README in storage root', e);
    }
  }

  private async atomicWrite(filePath: string, data: string, retries = 3) {
    const tmp = filePath + '.tmp';
    // ensure parent directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, data, { encoding: 'utf8' });
    
    // Retry rename on Windows EPERM errors (file lock)
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await fs.rename(tmp, filePath);
        return; // success
      } catch (e: any) {
        if (e.code === 'EPERM' && attempt < retries - 1) {
          // Wait a bit and retry - Windows file lock
          await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        // Last attempt or different error - try direct write as fallback
        try {
          await fs.writeFile(filePath, data, { encoding: 'utf8' });
          // Clean up tmp if exists
          try { await fs.unlink(tmp); } catch {}
          return;
        } catch {
          throw e; // re-throw original error
        }
      }
    }
  }

  async listSessions(): Promise<any[]> {
    try {
      const raw = await fs.readFile(this.sessionsIndexPath, 'utf8');
      return JSON.parse(raw || '[]');
    } catch (e) {
      return [];
    }
  }

  getSessionsDir() {
    return this.sessionsDir;
  }

  getSessionsIndexPath() {
    return this.sessionsIndexPath;
  }

  async sessionExists(sessionId: string) {
    sessionId = sanitizeSessionId(sessionId);
    const messagesPath = path.join(this.sessionsDir, sessionId, 'messages.jsonl');
    try {
      await fs.access(messagesPath);
      return true;
    } catch (e) {
      return false;
    }
  }

  async saveSessionsIndex(index: any[]) {
    await this.atomicWrite(this.sessionsIndexPath, JSON.stringify(index, null, 2));
  }

  async createSession(sessionId: string, title?: string) {
    sessionId = sanitizeSessionId(sessionId);
    const dir = path.join(this.sessionsDir, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const messagesPath = path.join(dir, 'messages.jsonl');
    try {
      await fs.access(messagesPath);
    } catch (e) {
      await fs.writeFile(messagesPath, '', 'utf8');
    }
    // update index
    const index = await this.listSessions();
    const exists = index.find((s: any) => s.id === sessionId);
    if (!exists) {
      index.unshift({ id: sessionId, title: title || 'New Chat', date: Date.now(), file: path.join(sessionId, 'messages.jsonl') });
      await this.saveSessionsIndex(index);
    }
  }

  async appendMessage(sessionId: string, message: StoredMessage) {
    sessionId = sanitizeSessionId(sessionId);
    const dir = path.join(this.sessionsDir, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const messagesPath = path.join(dir, 'messages.jsonl');
    const line = JSON.stringify({ type: 'message', ...message });
    await fs.appendFile(messagesPath, line + '\n', 'utf8');
  }

  /**
   * Remove a message by ID from the session's messages.jsonl file.
   * Rewrites the file without the target message.
   */
  async removeMessage(sessionId: string, messageId: string): Promise<void> {
    sessionId = sanitizeSessionId(sessionId);
    const messagesPath = path.join(this.sessionsDir, sessionId, 'messages.jsonl');
    try {
      const raw = await fs.readFile(messagesPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const filtered = lines.filter(line => {
        try {
          const parsed = JSON.parse(line);
          return parsed.id !== messageId;
        } catch {
          return true;
        }
      });
      await this.atomicWrite(messagesPath, filtered.join('\n') + (filtered.length ? '\n' : ''));
    } catch {
      // File doesn't exist or can't be read — nothing to remove
    }
  }

  // ---- Session metrics persistence ----

  async saveSessionMetrics(sessionId: string, metrics: { inputTokens: number; outputTokens: number; apiCalls: number; currentContextTokens?: number; contextLimit?: number }) {
    sessionId = sanitizeSessionId(sessionId);
    const dir = path.join(this.sessionsDir, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const metricsPath = path.join(dir, 'metrics.json');
    await this.atomicWrite(metricsPath, JSON.stringify(metrics));
    logger.log(`[STORAGE] saveSessionMetrics session=${sessionId} apiCalls=${metrics.apiCalls} in=${metrics.inputTokens} out=${metrics.outputTokens} ctx=${metrics.currentContextTokens || 0}/${metrics.contextLimit || 0}`);
  }

  async loadSessionMetrics(sessionId: string): Promise<{ inputTokens: number; outputTokens: number; apiCalls: number; currentContextTokens?: number; contextLimit?: number }> {
    sessionId = sanitizeSessionId(sessionId);
    const metricsPath = path.join(this.sessionsDir, sessionId, 'metrics.json');
    try {
      const raw = await fs.readFile(metricsPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return { inputTokens: 0, outputTokens: 0, apiCalls: 0, currentContextTokens: 0 };
    }
  }

  // ---- API conversation persistence (full tool_calls + tool results) ----

  async saveApiConversation(sessionId: string, conversation: any[]) {
    sessionId = sanitizeSessionId(sessionId);
    const dir = path.join(this.sessionsDir, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const convPath = path.join(dir, 'conversation.json');
    await this.atomicWrite(convPath, JSON.stringify(conversation));
    logger.log(`[STORAGE] saveApiConversation session=${sessionId} messages=${conversation.length}`);
  }

  async loadApiConversation(sessionId: string): Promise<any[]> {
    sessionId = sanitizeSessionId(sessionId);
    const convPath = path.join(this.sessionsDir, sessionId, 'conversation.json');
    try {
      const raw = await fs.readFile(convPath, 'utf8');
      const parsed = JSON.parse(raw);
      logger.log(`[STORAGE] loadApiConversation session=${sessionId} messages=${Array.isArray(parsed) ? parsed.length : 0}`);
      return parsed;
    } catch {
      logger.log(`[STORAGE] loadApiConversation session=${sessionId} messages=0 (no file)`);
      return [];
    }
  }

  // ---- Session mode lock (agent/chat) ----

  async saveSessionMode(sessionId: string, mode: string) {
    sessionId = sanitizeSessionId(sessionId);
    const dir = path.join(this.sessionsDir, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const modePath = path.join(dir, 'mode.json');
    await this.atomicWrite(modePath, JSON.stringify({ mode }));
  }

  async loadSessionMode(sessionId: string): Promise<string | null> {
    sessionId = sanitizeSessionId(sessionId);
    const modePath = path.join(this.sessionsDir, sessionId, 'mode.json');
    try {
      const raw = await fs.readFile(modePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed.mode || null;
    } catch {
      return null;
    }
  }

  async readSessionTail(sessionId: string, maxLines = 200): Promise<StoredMessage[]> {
    sessionId = sanitizeSessionId(sessionId);
    const messagesPath = path.join(this.sessionsDir, sessionId, 'messages.jsonl');
    try {
      const raw = await fs.readFile(messagesPath, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const tail = lines.slice(-maxLines);
      const parsed = tail.map(l => {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean).map((o: any) => ({ 
        id: o.id, 
        role: o.role, 
        content: o.content, 
        timestamp: o.timestamp, 
        tokenCount: o.tokenCount, 
        attachments: o.attachments, 
        actions: o.actions,
        fileActions: o.fileActions,
        modelName: o.modelName
      }));
      // Deduplicate by id: keep the LAST occurrence (most complete version)
      const seen = new Map<string, number>();
      for (let i = 0; i < parsed.length; i++) {
        if (parsed[i].id) { seen.set(parsed[i].id, i); }
      }
      return parsed.filter((msg, idx) => !msg.id || seen.get(msg.id) === idx);
    } catch (e) {
      return [];
    }
  }

  async migrateFromGlobalStateIfPresent(context: ExtensionContext) {
    try {
      const saved = context.globalState.get<any[]>('chatSessions', []);
      if (!saved || saved.length === 0) return;
      // create storage root if needed
      await this.init();
      for (const s of saved) {
        const id = s.id || ('sess_' + Date.now().toString() + '_' + Math.floor(Math.random() * 10000));
        await this.createSession(id, s.title || 'Migrated Chat');
        const messages = s.messages || [];
        for (const m of messages) {
          // only persist final messages (no temporary)
          if ((m as any).temporary) continue;
          const msg = {
            id: m.id || ('m_' + Date.now().toString()),
            role: m.role,
            content: m.content,
            timestamp: Date.now(),
            tokenCount: 0,
            attachments: m.attachedFiles || undefined
          };
          await this.appendMessage(id, msg);
        }
      }
      // mark migration done by clearing old state
      await context.globalState.update('chatSessions', []);
    } catch (e) {
      // swallow errors but log externally if needed
      console.error('Migration failed', e);
    }
  }

  /**
   * Clear all messages in a session but keep the session itself
   */
  async clearSession(sessionId: string) {
    sessionId = sanitizeSessionId(sessionId);
    const messagesPath = path.join(this.sessionsDir, sessionId, 'messages.jsonl');
    try {
      // Truncate the messages file
      await fs.writeFile(messagesPath, '', 'utf8');
    } catch (e) {
      // Session might not exist yet, ignore
      console.error('Failed to clear session messages', e);
    }
  }

  async deleteSession(sessionId: string) {
    sessionId = sanitizeSessionId(sessionId);
    const dir = path.join(this.sessionsDir, sessionId);
    try {
      // remove session folder and its contents
      // fs.rm with recursive and force is preferred; fallback to rmdir if not available
      // @ts-ignore
      if (typeof (fs as any).rm === 'function') {
        // Node >= 14.14
        // @ts-ignore
        await (fs as any).rm(dir, { recursive: true, force: true });
      } else {
        // older fallback
        await fs.rmdir(dir, { recursive: true } as any).catch(() => { /* ignore */ });
      }
    } catch (e) {
      // ignore remove errors, we'll still attempt to update index
      console.error('Failed to remove session folder', e);
    }

    // remove from index and persist
    try {
      const index = await this.listSessions();
      const filtered = index.filter((s: any) => s.id !== sessionId);
      await this.saveSessionsIndex(filtered);
    } catch (e) {
      console.error('Failed to update sessions index during deleteSession', e);
      throw e;
    }
  }
}
