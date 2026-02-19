import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { logger } from '../logger';

const UID_FILE_NAME = 'AshibaltUID';
const UID_GLOBAL_STATE_KEY = 'ashibalt_uid';

/**
 * Manages a persistent unique user identifier.
 * 
 * Storage strategy (dual redundancy):
 *  1. File: ~/.Ashibalt/AshibaltUID
 *  2. VS Code globalState (survives file deletion)
 * 
 * If file is deleted or edited, it's auto-restored from globalState.
 * If globalState is empty (fresh install), a new UUID is generated and saved to both.
 * This guarantees one user = one UID regardless of file tampering.
 */
export class UidManager {
  private uid: string | null = null;
  private filePath: string;
  private watcher: vscode.FileSystemWatcher | null = null;
  private restoring = false; // guard against own writes triggering watcher

  constructor() {
    this.filePath = path.join(os.homedir(), '.Ashibalt', UID_FILE_NAME);
  }

  /**
   * Initialize UID: resolve from globalState -> file -> generate new.
   * Must be called once at extension activation.
   */
  async initialize(context: vscode.ExtensionContext): Promise<string> {
    // 1. Check globalState (authoritative source)
    const storedUid = context.globalState.get<string>(UID_GLOBAL_STATE_KEY);

    // 2. Check file
    let fileUid: string | null = null;
    try {
      fileUid = (await fs.readFile(this.filePath, 'utf8')).trim();
      if (!fileUid || fileUid.length < 8) fileUid = null;
    } catch {
      // File doesn't exist or unreadable
    }

    if (storedUid) {
      // GlobalState has UID — this is the truth
      this.uid = storedUid;
      // Restore file if missing or mismatched
      if (fileUid !== storedUid) {
        await this.writeUidFile(storedUid);
        logger.log(`[UID] Restored file from globalState: ${storedUid}`);
      }
    } else if (fileUid) {
      // File exists but globalState is empty (edge case: imported from another machine)
      this.uid = fileUid;
      await context.globalState.update(UID_GLOBAL_STATE_KEY, fileUid);
      logger.log(`[UID] Imported from file to globalState: ${fileUid}`);
    } else {
      // Fresh install — generate new UID
      this.uid = crypto.randomUUID();
      await context.globalState.update(UID_GLOBAL_STATE_KEY, this.uid);
      await this.writeUidFile(this.uid);
      logger.log(`[UID] Generated new UID: ${this.uid}`);
    }

    // Watch for file changes/deletions and auto-restore
    this.startWatcher();

    return this.uid;
  }

  getUid(): string | null {
    return this.uid;
  }

  private async writeUidFile(uid: string): Promise<void> {
    this.restoring = true;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, uid, 'utf8');
    } catch (err) {
      logger.error('[UID] Failed to write UID file:', err);
    } finally {
      // Delay clearing the guard so the watcher event doesn't race
      setTimeout(() => { this.restoring = false; }, 500);
    }
  }

  /**
   * Watch the UID file for external changes/deletions and auto-restore.
   */
  private startWatcher(): void {
    if (this.watcher) return;
    const dirUri = vscode.Uri.file(path.dirname(this.filePath));
    const pattern = new vscode.RelativePattern(dirUri, UID_FILE_NAME);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

    const restore = async () => {
      if (this.restoring || !this.uid) return;
      try {
        const content = (await fs.readFile(this.filePath, 'utf8')).trim();
        if (content === this.uid) return; // file is correct
      } catch {
        // file missing — restore
      }
      logger.log('[UID] File tampered or deleted, restoring from memory');
      await this.writeUidFile(this.uid);
    };

    this.watcher.onDidChange(restore);
    this.watcher.onDidDelete(restore);
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = null;
  }
}

// Singleton
export const uidManager = new UidManager();
