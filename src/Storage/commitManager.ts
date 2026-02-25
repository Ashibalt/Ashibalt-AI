/**
 * commitManager.ts — Git-commit analog for Ashibalt.
 *
 * Saves full file-tree backups ("commits") per session so the model
 * can checkpoint work and restore it later — without requiring git.
 *
 * Storage layout:
 *   <sessionsDir>/<sessionId>/commits/
 *     index.json           ← CommitMeta[] (sorted newest-first after load)
 *     <commitId>/
 *       meta.json          ← full CommitMeta with file list
 *       files/
 *         src/
 *           foo.ts         ← full file copy mirroring workspace path
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

export interface CommitMeta {
  id: string;
  name: string;
  /** Path relative to workspaceRoot that was committed, e.g. "src/Engine" or "." */
  scope: string;
  timestamp: number;
  /** Workspace-relative paths of all committed files */
  files: string[];
  /** Total bytes backed up */
  totalSize: number;
}

/** File extensions that are skipped (binary / generated). */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.br', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.node', '.bin',
  '.map', // source maps — too large and not useful for restore
]);

/** Directories that are never committed. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', 'dist', 'out', 'build',
  '.vscode', '.next', '__pycache__', '.cache',
]);

/** Generate a short unique id (timestamp + 4 hex chars from random). */
function genId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(16).slice(2, 6);
  return `${ts}-${rand}`;
}

export class CommitManager {
  private sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  private commitsDir(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, 'commits');
  }

  private indexPath(sessionId: string): string {
    return path.join(this.commitsDir(sessionId), 'index.json');
  }

  private commitDir(sessionId: string, commitId: string): string {
    return path.join(this.commitsDir(sessionId), commitId);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async readIndex(sessionId: string): Promise<CommitMeta[]> {
    const p = this.indexPath(sessionId);
    try {
      const raw = await fs.readFile(p, 'utf8');
      return JSON.parse(raw) as CommitMeta[];
    } catch {
      return [];
    }
  }

  private async writeIndex(sessionId: string, index: CommitMeta[]): Promise<void> {
    await fs.mkdir(this.commitsDir(sessionId), { recursive: true });
    await fs.writeFile(this.indexPath(sessionId), JSON.stringify(index, null, 2), 'utf8');
  }

  /**
   * Recursively collect all text files from `dir`.
   * Returns paths relative to `rootDir`.
   */
  private async collectFiles(dir: string, rootDir: string): Promise<string[]> {
    const results: string[] = [];
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const sub = await this.collectFiles(fullPath, rootDir);
        results.push(...sub);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;
        results.push(path.relative(rootDir, fullPath));
      }
    }
    return results;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Create a new commit: backs up all files under `workspaceRoot/scope`.
   * Use scope = "." to back up the entire workspace.
   */
  async addCommit(
    sessionId: string,
    name: string,
    scope: string,
    workspaceRoot: string
  ): Promise<CommitMeta> {
    const scopeAbs = path.resolve(workspaceRoot, scope === '.' ? '' : scope);

    // Verify scope exists
    if (!existsSync(scopeAbs)) {
      throw new Error(`Scope path does not exist: ${scopeAbs}`);
    }

    const commitId = genId();
    const filesRootDir = workspaceRoot; // paths stored relative to workspaceRoot
    const relFiles = await this.collectFiles(scopeAbs, filesRootDir);

    if (relFiles.length === 0) {
      throw new Error(`No files found in scope "${scope}" (${scopeAbs})`);
    }

    const destFilesDir = path.join(this.commitDir(sessionId, commitId), 'files');
    let totalSize = 0;

    // Copy each file
    for (const rel of relFiles) {
      const src = path.join(workspaceRoot, rel);
      const dest = path.join(destFilesDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        const content = await fs.readFile(src);
        await fs.writeFile(dest, content);
        totalSize += content.length;
      } catch {
        // File disappeared between listing and copying — skip
      }
    }

    const meta: CommitMeta = {
      id: commitId,
      name,
      scope,
      timestamp: Date.now(),
      files: relFiles,
      totalSize,
    };

    // Write per-commit meta.json
    await fs.mkdir(this.commitDir(sessionId, commitId), { recursive: true });
    await fs.writeFile(
      path.join(this.commitDir(sessionId, commitId), 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf8'
    );

    // Update index
    const index = await this.readIndex(sessionId);
    index.unshift(meta); // newest first
    await this.writeIndex(sessionId, index);

    return meta;
  }

  /**
   * List all commits for a session (newest first).
   */
  async listCommits(sessionId: string): Promise<CommitMeta[]> {
    return this.readIndex(sessionId);
  }

  /**
   * Restore files from a commit back to workspaceRoot.
   * Returns list of relative paths that were restored.
   */
  async restoreCommit(
    sessionId: string,
    commitId: string,
    workspaceRoot: string
  ): Promise<string[]> {
    const metaPath = path.join(this.commitDir(sessionId, commitId), 'meta.json');
    let meta: CommitMeta;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      throw new Error(`Commit "${commitId}" not found`);
    }

    const destFilesDir = path.join(this.commitDir(sessionId, commitId), 'files');
    const restored: string[] = [];

    for (const rel of meta.files) {
      const src = path.join(destFilesDir, rel);
      const dest = path.join(workspaceRoot, rel);
      try {
        const content = await fs.readFile(src);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content);
        restored.push(rel);
      } catch {
        // File missing in backup — skip
      }
    }

    return restored;
  }

  /**
   * Delete a commit. Returns true on success.
   */
  async deleteCommit(sessionId: string, commitId: string): Promise<boolean> {
    const dir = this.commitDir(sessionId, commitId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Not fatal
    }

    const index = await this.readIndex(sessionId);
    const filtered = index.filter(c => c.id !== commitId);
    if (filtered.length === index.length) return false; // nothing removed
    await this.writeIndex(sessionId, filtered);
    return true;
  }

  /**
   * Compare commit snapshot with current workspace state.
   * Returns per-file status: unchanged | modified | deleted | new (only in workspace).
   */
  async diffCommit(
    sessionId: string,
    commitId: string,
    workspaceRoot: string
  ): Promise<Array<{ file: string; status: 'unchanged' | 'modified' | 'deleted' }>> {
    const metaPath = path.join(this.commitDir(sessionId, commitId), 'meta.json');
    let meta: CommitMeta;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      throw new Error(`Commit "${commitId}" not found`);
    }

    const destFilesDir = path.join(this.commitDir(sessionId, commitId), 'files');
    const results: Array<{ file: string; status: 'unchanged' | 'modified' | 'deleted' }> = [];

    for (const rel of meta.files) {
      const committed = path.join(destFilesDir, rel);
      const current = path.join(workspaceRoot, rel);
      try {
        const [a, b] = await Promise.all([fs.readFile(committed), fs.readFile(current)]);
        const hashA = createHash('md5').update(a).digest('hex');
        const hashB = createHash('md5').update(b).digest('hex');
        results.push({ file: rel, status: hashA === hashB ? 'unchanged' : 'modified' });
      } catch {
        // Current file missing
        results.push({ file: rel, status: 'deleted' });
      }
    }

    return results;
  }
}
