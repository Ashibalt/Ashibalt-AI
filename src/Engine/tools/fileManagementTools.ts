import * as vscode from 'vscode';
import * as path from 'path';
import { resolveFilePath, checkPathSecurity } from './toolUtils';
import { getSnapshotManager } from '../../Storage/snapshotManager';
import { applySnapshotDecorations } from '../../Storage/snapshotDecorations';

/**
 * Create a new file with content.
 * Parent directories are created automatically. Fails if file already exists.
 */
export async function createFileTool(args: any, workspaceRoot?: string) {
  if (!args || typeof args.file_path !== 'string') {
    throw new Error('create_file requires file_path string argument');
  }
  if (typeof args.content !== 'string') {
    throw new Error('create_file requires content string argument');
  }

  // Sanity check: detect if model sent structured JSON instead of actual file content
  // Common GLM bug: CSS/HTML represented as [{"margin": 0, ...}] instead of actual code
  const ext = path.extname(args.file_path).toLowerCase();
  const textFileExts = ['.html', '.htm', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.rb', '.go', '.rs', '.php', '.vue', '.svelte', '.xml', '.svg', '.md', '.txt', '.sh', '.bat', '.yaml', '.yml'];
  if (textFileExts.includes(ext)) {
    const trimmed = args.content.trimStart();
    if (trimmed.startsWith('[{') || trimmed.startsWith('[\n{')) {
      return {
        success: false,
        error: `Content looks like a JSON array, not valid ${ext} file content. ` +
          `You must write actual ${ext} code/markup as plain text, NOT convert it to JSON objects. ` +
          `For example, for HTML write "<!DOCTYPE html><html>..." not "[{\"margin\": 0}]".`,
        hint: `Please retry create_file with actual ${ext} file content as a plain text string.`
      };
    }
  }

  const resolved = resolveFilePath(args.file_path, workspaceRoot);
  await checkPathSecurity(resolved, workspaceRoot, 'создание');

  const uri = vscode.Uri.file(resolved);

  // Check if file already exists
  try {
    await vscode.workspace.fs.stat(uri);
    throw new Error(`File already exists: ${resolved}. Use edit_file to modify existing files.`);
  } catch (e: any) {
    // File doesn't exist - good, we can create it
    if (e.message && e.message.includes('already exists')) {
      throw e;
    }
  }

  // Create parent directories if needed
  const dirPath = path.dirname(resolved);
  const dirUri = vscode.Uri.file(dirPath);
  try {
    await vscode.workspace.fs.createDirectory(dirUri);
  } catch (e) {
    // Directory might already exist, ignore
  }

  // Write the file
  const content = args.content;
  const bytes = Buffer.from(content, 'utf8');
  await vscode.workspace.fs.writeFile(uri, bytes);

  // Create snapshot so the file appears in Pending Changes dashboard
  // and can be rolled back (deleted) if user clicks "Revert"
  const snapshotManager = getSnapshotManager();
  const lines = content.split('\n').length;
  const snapshot = await snapshotManager.createSnapshot(
    resolved,
    'create_file',
    null,        // oldContent = null (file didn't exist)
    content,
    1,
    lines
  );
  if (snapshot) {
    applySnapshotDecorations(snapshot);
  }

  const fileName = path.basename(resolved);

  return {
    success: true,
    file_path: resolved,
    file_name: fileName,
    message: `✅ FILE CREATED: ${resolved} (${lines} lines). Use edit_file to modify this file from now on — do NOT create_file again.`,
    total_lines: lines
  };
}

/**
 * Delete a file with user confirmation.
 */
export async function deleteFileTool(args: any, workspaceRoot?: string): Promise<any> {
  if (!args || typeof args.file_path !== 'string') {
    return { error: 'file_path is required' };
  }

  const resolved = resolveFilePath(args.file_path, workspaceRoot);
  const uri = vscode.Uri.file(resolved);
  const fileName = path.basename(resolved);

  // Check file exists
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) {
      return { error: 'Cannot delete directories. Use terminal command for that.' };
    }
  } catch (e) {
    return { error: `File not found: ${resolved}` };
  }

  // Security check
  await checkPathSecurity(resolved, workspaceRoot, 'удаление');

  // Ask user confirmation
  const choice = await vscode.window.showWarningMessage(
    `Удалить файл "${fileName}"?\n\nПуть: ${resolved}`,
    { modal: true },
    'Удалить',
    'Отмена'
  );

  if (choice !== 'Удалить') {
    return {
      success: false,
      error: 'Deletion cancelled by user',
      file_path: resolved
    };
  }

  // Delete the file
  try {
    // Read file content before deleting — needed for snapshot (rollback support)
    let oldContent: string | null = null;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      oldContent = Buffer.from(bytes).toString('utf8');
    } catch {
      // If we can't read, proceed without snapshot
    }

    await vscode.workspace.fs.delete(uri);

    // Create snapshot so the file can be restored on rollback
    if (oldContent !== null) {
      const snapshotManager = getSnapshotManager();
      const oldLines = oldContent.split('\n').length;
      await snapshotManager.createSnapshot(
        resolved,
        'delete_file',
        oldContent,   // baseline = file contents before delete
        '',           // newContent = empty (file deleted)
        1,
        oldLines
      );
    }

    return {
      success: true,
      file_path: resolved,
      file_name: fileName,
      message: `Successfully deleted ${fileName}`
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Failed to delete file',
      file_path: resolved
    };
  }
}
