import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Individual change within a file (for UI display)
 */
export interface FileChange {
  id: string;
  timestamp: number;
  // Context for finding position dynamically
  contextBefore: string[];  // 2-3 lines before change
  contextAfter: string[];   // 2-3 lines after change
  // What was changed
  oldLines: string[];       // Lines that were removed
  newLines: string[];       // Lines that were added
  // Cached position (updated on each refresh)
  cachedStartLine: number;
}

/**
 * Snapshot of a file - stores baseline + all changes
 */
export interface FileSnapshot {
  id: string;
  filePath: string;
  fileName: string;
  createdAt: number;        // When first change was made
  updatedAt: number;        // When last change was made
  tool: 'edit_file' | 'overwrite_file' | 'create_file' | 'delete_file';
  // FULL file content before ANY changes (for reliable rollback)
  baselineContent: string | null;  // null for create_file (file didn't exist)
  // Individual changes for UI display
  changes: FileChange[];
  // Aggregated stats
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

/**
 * Summary of all pending changes for dashboard
 */
export interface PendingChangesSummary {
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
  files: {
    filePath: string;
    fileName: string;
    added: number;
    removed: number;
    snapshotId: string;
    changeCount: number;
  }[];
}

// Legacy interface for compatibility
export interface LegacyFileSnapshot {
  id: string;
  filePath: string;
  fileName: string;
  timestamp: number;
  tool: 'edit_file' | 'overwrite_file' | 'create_file' | 'delete_file';
  oldContent: string | null;
  newContent: string;
  startLine: number;
  endLine: number;
  linesAdded: number;
  linesRemoved: number;
}

// Limits
const MAX_SNAPSHOTS_PER_FILE = 1; // One snapshot per file (contains all changes)
const MAX_TOTAL_FILES = 50;

/**
 * Manages file snapshots for undo functionality
 * New architecture: ONE snapshot per file with baseline + multiple changes
 */
export class SnapshotManager {
  private snapshotsDir: string;
  private pendingDir: string;
  private snapshots: Map<string, FileSnapshot> = new Map(); // key = filePath
  private onChangeCallbacks: (() => void)[] = [];
  private _initPromise: Promise<void> | null = null;

  constructor() {
    const homeDir = os.homedir();
    this.snapshotsDir = path.join(homeDir, '.Ashibalt', 'snapshots');
    this.pendingDir = path.join(this.snapshotsDir, 'pending');
  }

  /**
   * Initialize the manager - create directories and load existing snapshots
   */
  async init(): Promise<void> {
    this._initPromise = (async () => {
      await this.ensureDir(this.snapshotsDir);
      await this.ensureDir(this.pendingDir);
      await this.loadPendingSnapshots();
    })();
    await this._initPromise;
  }

  /**
   * Wait for initialization to complete. Safe to call multiple times.
   * Returns immediately if already initialized or init() was never called.
   */
  async ready(): Promise<void> {
    if (this._initPromise) {
      await this._initPromise;
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (e) {
      // Directory might already exist
    }
  }

  /**
   * Load all pending snapshots from disk
   */
  private async loadPendingSnapshots(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.pendingDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await fs.promises.readFile(
            path.join(this.pendingDir, file),
            'utf8'
          );
          const snapshot: FileSnapshot = JSON.parse(content);
          // Use filePath as key for quick lookup
          this.snapshots.set(snapshot.filePath, snapshot);
        } catch (e) {
          console.error(`Failed to load snapshot ${file}:`, e);
        }
      }
    } catch (e) {
      console.error('Failed to load pending snapshots:', e);
    }
  }

  /**
   * Create or update a snapshot for a file change
   * If file already has a snapshot, adds a new change to it
   * Otherwise creates new snapshot with baseline
   */
  async createSnapshot(
    filePath: string,
    tool: FileSnapshot['tool'],
    oldContent: string | null,
    newContent: string,
    startLine: number,
    _endLine: number  // Not used directly, calculated from content
  ): Promise<FileSnapshot> {
    let snapshot = this.snapshots.get(filePath);
    const now = Date.now();
    
    // Read current file to get context lines
    let currentFileLines: string[] = [];
    try {
      const uri = vscode.Uri.file(filePath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      currentFileLines = Buffer.from(bytes).toString('utf8').split('\n');
    } catch (e) {
      // File might have just been created
    }
    
    // Calculate context for this change
    const zeroBasedStart = Math.max(0, startLine - 1);
    const newLines = newContent ? newContent.split('\n') : [];
    const oldLines = oldContent ? oldContent.split('\n') : [];
    
    // Get 2-3 context lines before and after
    const contextBefore = currentFileLines.slice(
      Math.max(0, zeroBasedStart - 3),
      zeroBasedStart
    );
    const contextAfter = currentFileLines.slice(
      zeroBasedStart + newLines.length,
      zeroBasedStart + newLines.length + 3
    );
    
    const change: FileChange = {
      id: `${now}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: now,
      contextBefore,
      contextAfter,
      oldLines,
      newLines,
      cachedStartLine: startLine
    };
    
    if (snapshot) {
      // Add change to existing snapshot
      snapshot.changes.push(change);
      snapshot.updatedAt = now;
      snapshot.totalLinesAdded += newLines.length;
      snapshot.totalLinesRemoved += oldLines.length;
      
      // If the original snapshot was from create_file (baselineContent === null)
      // but this new change is an edit_file, the file now has real content
      // that should be restored on rollback instead of deleting the file.
      // We keep baselineContent = null only for create_file — this is correct:
      // if the file was created by the model, rolling back should delete it.
      // But the tool field should reflect the latest type for UI display.
      if (tool !== 'create_file' && tool !== 'delete_file') {
        snapshot.tool = tool;
      }
    } else {
      // Create new snapshot with baseline
      // For baseline, we need the ORIGINAL file content before this change
      // Since the file has already been modified, we reconstruct it
      let baselineContent: string | null = null;
      
      if (tool === 'create_file') {
        baselineContent = null; // File didn't exist
      } else if (oldContent !== null) {
        // Reconstruct baseline by replacing newContent with oldContent at startLine
        const beforeChange = currentFileLines.slice(0, zeroBasedStart);
        const afterChange = currentFileLines.slice(zeroBasedStart + newLines.length);
        baselineContent = [...beforeChange, ...oldLines, ...afterChange].join('\n');
      } else {
        // Fallback: oldContent is null but file existed (shouldn't happen normally)
        baselineContent = currentFileLines.join('\n');
      }
      
      snapshot = {
        id: `snap_${now}_${Math.random().toString(36).substr(2, 9)}`,
        filePath,
        fileName: path.basename(filePath),
        createdAt: now,
        updatedAt: now,
        tool,
        baselineContent,
        changes: [change],
        totalLinesAdded: newLines.length,
        totalLinesRemoved: oldLines.length
      };
      
      this.snapshots.set(filePath, snapshot);
    }
    
    // Enforce limits
    await this.enforceLimits();
    
    // Save to disk
    await this.saveSnapshotToDisk(snapshot);
    
    // Notify listeners
    this.notifyChange();
    
    return snapshot;
  }

  /**
   * Find the current position of a change by searching for context
   * Improved algorithm with multiple strategies
   * Returns 1-based line number
   */
  findChangePosition(fileContent: string, change: FileChange): number {
    const lines = fileContent.split('\n');
    
    // Strategy 1: Find by context before + new content combination (most reliable)
    if (change.contextBefore.length > 0 && change.newLines.length > 0) {
      const contextLen = change.contextBefore.length;
      const newLen = change.newLines.length;
      
      for (let i = 0; i <= lines.length - contextLen - newLen; i++) {
        // Check if context matches
        let contextMatches = true;
        for (let j = 0; j < contextLen && contextMatches; j++) {
          if (lines[i + j] !== change.contextBefore[j]) {
            contextMatches = false;
          }
        }
        
        if (contextMatches) {
          // Check if new content follows
          let contentMatches = true;
          const contentStart = i + contextLen;
          for (let j = 0; j < newLen && contentMatches; j++) {
            if (lines[contentStart + j] !== change.newLines[j]) {
              contentMatches = false;
            }
          }
          
          if (contentMatches) {
            return contentStart + 1; // 1-based line where new content starts
          }
        }
      }
    }
    
    // Strategy 2: Find by context before only
    if (change.contextBefore.length > 0) {
      const contextLen = change.contextBefore.length;
      
      for (let i = 0; i <= lines.length - contextLen; i++) {
        let matches = true;
        for (let j = 0; j < contextLen && matches; j++) {
          if (lines[i + j] !== change.contextBefore[j]) {
            matches = false;
          }
        }
        
        if (matches) {
          return i + contextLen + 1; // 1-based line after context
        }
      }
    }
    
    // Strategy 3: Find by new content (if unique enough - at least 2 lines)
    if (change.newLines.length >= 2) {
      const newLen = change.newLines.length;
      let foundAt = -1;
      let foundCount = 0;
      
      for (let i = 0; i <= lines.length - newLen; i++) {
        let matches = true;
        for (let j = 0; j < newLen && matches; j++) {
          if (lines[i + j] !== change.newLines[j]) {
            matches = false;
          }
        }
        
        if (matches) {
          foundAt = i;
          foundCount++;
          if (foundCount > 1) break; // Not unique, don't use this strategy
        }
      }
      
      if (foundCount === 1 && foundAt !== -1) {
        return foundAt + 1; // 1-based start of new content
      }
    }
    
    // Strategy 4: Fallback to cached position
    return change.cachedStartLine;
  }

  /**
   * Enforce snapshot limits
   */
  private async enforceLimits(): Promise<void> {
    if (this.snapshots.size >= MAX_TOTAL_FILES) {
      // Remove oldest snapshot
      let oldest: FileSnapshot | null = null;
      for (const snap of this.snapshots.values()) {
        if (!oldest || snap.createdAt < oldest.createdAt) {
          oldest = snap;
        }
      }
      if (oldest) {
        await this.confirmSnapshot(oldest.id);
        vscode.window.showInformationMessage(
          `Лимит файлов (${MAX_TOTAL_FILES}) достигнут. Изменения в ${oldest.fileName} автоматически сохранены.`
        );
      }
    }
  }

  /**
   * Save snapshot to disk
   */
  private async saveSnapshotToDisk(snapshot: FileSnapshot): Promise<void> {
    // Use safe filename based on snapshot id
    const filePath = path.join(this.pendingDir, `${snapshot.id}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  /**
   * Delete snapshot from disk
   */
  private async deleteSnapshotFromDisk(snapshot: FileSnapshot): Promise<void> {
    const filePath = path.join(this.pendingDir, `${snapshot.id}.json`);
    try {
      await fs.promises.unlink(filePath);
    } catch (e) {
      // File might not exist
    }
  }

  /**
   * Confirm a snapshot (user accepted changes) - removes the snapshot
   */
  async confirmSnapshot(id: string): Promise<boolean> {
    // Find snapshot by id
    let snapshot: FileSnapshot | undefined;
    for (const s of this.snapshots.values()) {
      if (s.id === id) {
        snapshot = s;
        break;
      }
    }
    if (!snapshot) return false;

    this.snapshots.delete(snapshot.filePath);
    await this.deleteSnapshotFromDisk(snapshot);
    this.notifyChange();
    return true;
  }

  /**
   * Confirm all snapshots for a file
   */
  async confirmFile(filePath: string): Promise<number> {
    const snapshot = this.snapshots.get(filePath);
    if (!snapshot) return 0;
    
    await this.confirmSnapshot(snapshot.id);
    return 1;
  }

  /**
   * Confirm all pending snapshots
   */
  async confirmAll(): Promise<number> {
    const count = this.snapshots.size;
    const snapshots = Array.from(this.snapshots.values());
    for (const snapshot of snapshots) {
      await this.confirmSnapshot(snapshot.id);
    }
    return count;
  }

  /**
   * Rollback ALL changes to a file - restores baseline
   */
  async rollbackSnapshot(id: string): Promise<boolean> {
    // Find snapshot by id
    let snapshot: FileSnapshot | undefined;
    for (const s of this.snapshots.values()) {
      if (s.id === id) {
        snapshot = s;
        break;
      }
    }
    if (!snapshot) return false;

    try {
      const uri = vscode.Uri.file(snapshot.filePath);

      if (snapshot.baselineContent === null) {
        // File was created by the model — verify it still looks like the
        // created content before deleting.  If the file now contains content
        // that clearly predates the model (e.g. it existed before and the
        // snapshot was erroneously stored with null baseline), refuse to
        // delete and instead just remove the snapshot.
        try {
          const currentBytes = await vscode.workspace.fs.readFile(uri);
          const currentContent = Buffer.from(currentBytes).toString('utf8');
          // Only delete if the file hasn't grown far beyond what the model produced
          // (a safety net — if the user added significant content, don't wipe it)
          const modelProducedLength = snapshot.changes.reduce((sum, c) => sum + c.newLines.join('\n').length, 0);
          if (modelProducedLength > 0 && currentContent.length > modelProducedLength * 3 + 500) {
            // File has grown beyond what the model wrote — don't delete, just drop snapshot
            vscode.window.showWarningMessage(`Файл ${snapshot.fileName} значительно изменён с момента создания. Откат пропущен.`);
          } else {
            await vscode.workspace.fs.delete(uri);
          }
        } catch {
          // File already gone — that's fine
        }
      } else {
        // Restore baseline content
        const bytes = Buffer.from(snapshot.baselineContent, 'utf8');
        await vscode.workspace.fs.writeFile(uri, bytes);
      }

      // Remove snapshot
      this.snapshots.delete(snapshot.filePath);
      await this.deleteSnapshotFromDisk(snapshot);
      this.notifyChange();
      return true;
    } catch (e) {
      console.error('Failed to rollback snapshot:', e);
      return false;
    }
  }

  /**
   * Rollback a specific change within a file
   * This reconstructs the file by re-applying all OTHER changes to baseline
   */
  async rollbackChange(snapshotId: string, changeId: string): Promise<boolean> {
    // Find snapshot
    let snapshot: FileSnapshot | undefined;
    for (const s of this.snapshots.values()) {
      if (s.id === snapshotId) {
        snapshot = s;
        break;
      }
    }
    if (!snapshot) return false;
    
    // Find the change to remove
    const changeIndex = snapshot.changes.findIndex(c => c.id === changeId);
    if (changeIndex === -1) return false;
    
    const changeToRemove = snapshot.changes[changeIndex];
    
    // If this is the only change, rollback entire file
    if (snapshot.changes.length === 1) {
      return this.rollbackSnapshot(snapshotId);
    }
    
    try {
      // Start from baseline and re-apply all changes EXCEPT the one we're removing
      let content = snapshot.baselineContent || '';
      
      // Sort changes by their original timestamp to apply in order
      const remainingChanges = snapshot.changes
        .filter(c => c.id !== changeId)
        .sort((a, b) => a.timestamp - b.timestamp);
      
      // Apply each remaining change sequentially
      // Each change transforms: oldLines -> newLines at a certain position
      for (const change of remainingChanges) {
        const lines = content.split('\n');
        
        // Find where oldLines are in current content
        let foundStart = -1;
        if (change.oldLines.length > 0) {
          // Search for oldLines in current content
          for (let i = 0; i <= lines.length - change.oldLines.length; i++) {
            let matches = true;
            for (let j = 0; j < change.oldLines.length && matches; j++) {
              if (lines[i + j] !== change.oldLines[j]) {
                matches = false;
              }
            }
            if (matches) {
              foundStart = i;
              break;
            }
          }
        } else {
          // Pure insertion - find by context
          if (change.contextBefore.length > 0) {
            for (let i = 0; i <= lines.length - change.contextBefore.length; i++) {
              let matches = true;
              for (let j = 0; j < change.contextBefore.length && matches; j++) {
                if (lines[i + j] !== change.contextBefore[j]) {
                  matches = false;
                }
              }
              if (matches) {
                foundStart = i + change.contextBefore.length;
                break;
              }
            }
          }
        }
        
        if (foundStart === -1) {
          // Fallback to cached position
          foundStart = Math.max(0, change.cachedStartLine - 1);
        }
        
        // Apply the change: replace oldLines with newLines
        const beforeChange = lines.slice(0, foundStart);
        const afterChange = lines.slice(foundStart + change.oldLines.length);
        content = [...beforeChange, ...change.newLines, ...afterChange].join('\n');
      }
      
      // Write the reconstructed file
      const uri = vscode.Uri.file(snapshot.filePath);
      const bytes = Buffer.from(content, 'utf8');
      await vscode.workspace.fs.writeFile(uri, bytes);
      
      // Remove the change from snapshot
      snapshot.changes.splice(changeIndex, 1);
      snapshot.totalLinesAdded -= changeToRemove.newLines.length;
      snapshot.totalLinesRemoved -= changeToRemove.oldLines.length;
      snapshot.updatedAt = Date.now();
      
      // Update positions for remaining changes
      await this.updateChangePositions(snapshot);
      
      await this.saveSnapshotToDisk(snapshot);
      this.notifyChange();
      return true;
    } catch (e) {
      console.error('Failed to rollback change:', e);
      return false;
    }
  }

  /**
   * Update cached positions for all changes in a snapshot
   */
  private async updateChangePositions(snapshot: FileSnapshot): Promise<void> {
    try {
      const uri = vscode.Uri.file(snapshot.filePath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString('utf8');
      
      for (const change of snapshot.changes) {
        change.cachedStartLine = this.findChangePosition(content, change);
      }
    } catch (e) {
      // File might not exist
    }
  }

  /**
   * Rollback all snapshots for a file
   */
  async rollbackFile(filePath: string): Promise<number> {
    const snapshot = this.snapshots.get(filePath);
    if (!snapshot) return 0;
    
    const result = await this.rollbackSnapshot(snapshot.id);
    return result ? 1 : 0;
  }

  /**
   * Rollback all pending snapshots
   */
  async rollbackAll(): Promise<number> {
    const snapshots = Array.from(this.snapshots.values());
    let count = 0;
    for (const snapshot of snapshots) {
      if (await this.rollbackSnapshot(snapshot.id)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get workspace roots for filtering (lowercased for case-insensitive comparison on Windows)
   */
  private getWorkspaceRoots(): string[] | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders.map(f => f.uri.fsPath.replace(/\\/g, '/').toLowerCase());
  }

  /**
   * Check if a file belongs to the current workspace
   * Uses case-insensitive comparison (Windows paths are case-insensitive)
   */
  private isInWorkspace(filePath: string, roots: string[] | null): boolean {
    if (!roots) return true; // no workspace — show all
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return roots.some(root => normalized.startsWith(root));
  }

  /**
   * Get all pending snapshots (filtered to current workspace)
   */
  getPendingSnapshots(): FileSnapshot[] {
    const roots = this.getWorkspaceRoots();
    // Filter out snapshots for files that no longer exist on disk
    const pending = Array.from(this.snapshots.values())
      .filter(s => this.isInWorkspace(s.filePath, roots) && fs.existsSync(s.filePath))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    // Clean up stale snapshots (files deleted by user)
    for (const [filePath, snapshot] of this.snapshots) {
      if (this.isInWorkspace(filePath, roots) && !fs.existsSync(filePath)) {
        this.snapshots.delete(filePath);
        this.deleteSnapshotFromDisk(snapshot).catch(() => {});
      }
    }

    return pending;
  }

  /**
   * Get snapshot for a specific file
   */
  getSnapshotForFile(filePath: string): FileSnapshot | undefined {
    return this.snapshots.get(filePath);
  }

  /**
   * Get snapshots for a specific file (compatibility method)
   */
  getSnapshotsForFile(filePath: string): FileSnapshot[] {
    const snapshot = this.snapshots.get(filePath);
    return snapshot ? [snapshot] : [];
  }

  /**
   * Get summary for dashboard (filtered to current workspace)
   */
  getSummary(): PendingChangesSummary {
    const roots = this.getWorkspaceRoots();
    const files = Array.from(this.snapshots.values())
      .filter(s => this.isInWorkspace(s.filePath, roots))
      .map(s => ({
        filePath: s.filePath,
        fileName: s.fileName,
        added: s.totalLinesAdded,
        removed: s.totalLinesRemoved,
        snapshotId: s.id,
        changeCount: s.changes.length
      }));

    const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
    const totalRemoved = files.reduce((sum, f) => sum + f.removed, 0);

    return {
      totalFiles: files.length,
      totalAdded,
      totalRemoved,
      files
    };
  }

  /**
   * Check if there are pending changes in the current workspace
   * Only counts snapshots whose files belong to an open workspace folder
   */
  hasPendingChanges(): boolean {
    if (this.snapshots.size === 0) return false;

    const roots = this.getWorkspaceRoots();
    for (const snap of this.snapshots.values()) {
      if (this.isInWorkspace(snap.filePath, roots)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Register callback for when snapshots change
   */
  onChange(callback: () => void): () => void {
    this.onChangeCallbacks.push(callback);
    return () => {
      const idx = this.onChangeCallbacks.indexOf(callback);
      if (idx !== -1) this.onChangeCallbacks.splice(idx, 1);
    };
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      try {
        cb();
      } catch (e) {
        console.error('Snapshot change callback error:', e);
      }
    }
  }
}

// Singleton instance
let instance: SnapshotManager | null = null;

export function getSnapshotManager(): SnapshotManager {
  if (!instance) {
    instance = new SnapshotManager();
  }
  return instance;
}
