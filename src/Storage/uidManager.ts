import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ExtensionContext } from 'vscode';
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
 * If file is deleted, it's restored from globalState.
 * If globalState is empty (fresh install), a new UUID is generated and saved to both.
 * This guarantees one user = one UID regardless of file tampering.
 */
export class UidManager {
  private uid: string | null = null;
  private filePath: string;

  constructor() {
    this.filePath = path.join(os.homedir(), '.Ashibalt', UID_FILE_NAME);
  }

  /**
   * Initialize UID: resolve from globalState -> file -> generate new.
   * Must be called once at extension activation.
   */
  async initialize(context: ExtensionContext): Promise<string> {
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

    return this.uid;
  }

  getUid(): string | null {
    return this.uid;
  }

  private async writeUidFile(uid: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, uid, 'utf8');
    } catch (err) {
      logger.error('[UID] Failed to write UID file:', err);
    }
  }
}

// Singleton
export const uidManager = new UidManager();
