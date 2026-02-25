/**
 * commitTool.ts — Execution logic for add_commit / get_commit tools.
 *
 * These are handled directly in agentLoop.ts (not via executeTool) because
 * they need sessionId and CommitManager which are not available inside the
 * generic executeTool dispatcher.
 */

import { CommitManager, CommitMeta } from '../../Storage/commitManager';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderCommitList(commits: CommitMeta[]): string {
  if (commits.length === 0) {
    return 'No commits yet. Use add_commit to create your first checkpoint.';
  }
  const rows = commits.map((c, i) => [
    `#${i + 1}`,
    c.id,
    c.name,
    c.scope,
    formatDate(c.timestamp),
    `${c.files.length} files`,
    formatSize(c.totalSize)
  ]);
  const header = ['#', 'ID', 'Name', 'Scope', 'Date', 'Files', 'Size'];
  const widths = header.map((h, ci) =>
    Math.max(h.length, ...rows.map(r => (r[ci] || '').length))
  );
  const sep = widths.map(w => '-'.repeat(w)).join('-+-');
  const fmt = (row: string[]) => row.map((v, ci) => v.padEnd(widths[ci])).join(' | ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}

// ── add_commit ──────────────────────────────────────────────────────────────

export async function executeAddCommit(
  args: { name: string; scope: string },
  workspaceRoot: string,
  sessionId: string,
  commitManager: CommitManager
): Promise<{ success: boolean; message: string; commit?: CommitMeta }> {
  if (!args.name || typeof args.name !== 'string') {
    return { success: false, message: 'ERROR: "name" parameter is required (commit title)' };
  }
  if (!args.scope || typeof args.scope !== 'string') {
    return { success: false, message: 'ERROR: "scope" parameter is required (e.g. "." or "src/Engine")' };
  }
  if (!workspaceRoot) {
    return { success: false, message: 'ERROR: No workspace folder open' };
  }

  try {
    const meta = await commitManager.addCommit(sessionId, args.name.trim(), args.scope.trim(), workspaceRoot);
    return {
      success: true,
      commit: meta,
      message:
        `✓ Commit created: "${meta.name}"\n` +
        `  ID: ${meta.id}\n` +
        `  Scope: ${meta.scope}\n` +
        `  Files backed up: ${meta.files.length}\n` +
        `  Size: ${formatSize(meta.totalSize)}\n` +
        `  Date: ${formatDate(meta.timestamp)}\n\n` +
        `To restore this checkpoint later: get_commit(action="restore", commitId="${meta.id}")`
    };
  } catch (err: any) {
    return { success: false, message: `ERROR: ${err.message || String(err)}` };
  }
}

// ── get_commit ──────────────────────────────────────────────────────────────

export async function executeGetCommit(
  args: { action: 'list' | 'restore' | 'delete' | 'diff'; commitId?: string },
  workspaceRoot: string,
  sessionId: string,
  commitManager: CommitManager
): Promise<{ success: boolean; message: string }> {
  const action = (args.action || 'list').toLowerCase() as typeof args.action;

  if (action === 'list') {
    try {
      const commits = await commitManager.listCommits(sessionId);
      return {
        success: true,
        message: `Session commits (${commits.length} total):\n\n${renderCommitList(commits)}`
      };
    } catch (err: any) {
      return { success: false, message: `ERROR listing commits: ${err.message}` };
    }
  }

  // All other actions require commitId
  if (!args.commitId) {
    return { success: false, message: `ERROR: "commitId" is required for action "${action}"` };
  }

  if (action === 'restore') {
    if (!workspaceRoot) {
      return { success: false, message: 'ERROR: No workspace folder open' };
    }
    try {
      const restored = await commitManager.restoreCommit(sessionId, args.commitId, workspaceRoot);
      return {
        success: true,
        message:
          `✓ Restored ${restored.length} files from commit "${args.commitId}".\n` +
          `Restored files:\n` +
          restored.slice(0, 30).map(f => `  • ${f}`).join('\n') +
          (restored.length > 30 ? `\n  … and ${restored.length - 30} more` : '')
      };
    } catch (err: any) {
      return { success: false, message: `ERROR restoring: ${err.message}` };
    }
  }

  if (action === 'delete') {
    try {
      const ok = await commitManager.deleteCommit(sessionId, args.commitId);
      return {
        success: ok,
        message: ok
          ? `✓ Commit "${args.commitId}" deleted.`
          : `Commit "${args.commitId}" not found.`
      };
    } catch (err: any) {
      return { success: false, message: `ERROR deleting: ${err.message}` };
    }
  }

  if (action === 'diff') {
    if (!workspaceRoot) {
      return { success: false, message: 'ERROR: No workspace folder open' };
    }
    try {
      const diffs = await commitManager.diffCommit(sessionId, args.commitId, workspaceRoot);
      const modified = diffs.filter(d => d.status === 'modified');
      const deleted = diffs.filter(d => d.status === 'deleted');
      const unchanged = diffs.filter(d => d.status === 'unchanged');

      let out = `Diff for commit "${args.commitId}":\n\n`;
      out += `  ${modified.length} modified, ${deleted.length} deleted, ${unchanged.length} unchanged\n\n`;
      if (modified.length) {
        out += `Modified:\n` + modified.map(d => `  M  ${d.file}`).join('\n') + '\n\n';
      }
      if (deleted.length) {
        out += `Deleted (from workspace):\n` + deleted.map(d => `  D  ${d.file}`).join('\n') + '\n\n';
      }
      if (!modified.length && !deleted.length) {
        out += 'All files match the commit snapshot.';
      }
      return { success: true, message: out.trim() };
    } catch (err: any) {
      return { success: false, message: `ERROR diffing: ${err.message}` };
    }
  }

  return {
    success: false,
    message: `ERROR: Unknown action "${action}". Valid actions: list, restore, delete, diff`
  };
}
