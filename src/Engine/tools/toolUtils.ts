import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Strip ANSI escape codes from terminal output for cleaner model input
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Resolve a raw file path to an absolute path.
 * Uses workspaceRoot if provided, otherwise falls back to first workspace folder.
 */
export function resolveFilePath(rawPath: string, workspaceRoot?: string): string {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  if (workspaceRoot) {
    return path.resolve(workspaceRoot, rawPath);
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return path.resolve(folders[0].uri.fsPath, rawPath);
  }
  return rawPath;
}

/**
 * Security check: ensure path is within workspace or ask user for permission.
 */
export async function checkPathSecurity(resolved: string, workspaceRoot?: string, action: string = 'доступ к'): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const rootCandidate = workspaceRoot || (folders && folders.length > 0 ? folders[0].uri.fsPath : undefined);
  
  if (rootCandidate) {
    const rel = path.relative(rootCandidate, resolved);
    if (rel.startsWith('..') || (path.isAbsolute(rel) && rel.indexOf('..') === 0)) {
      const msg = `Запрошенный файл находится вне рабочего каталога: ${resolved}. Разрешить ${action} этого файла?`;
      const choice = await vscode.window.showWarningMessage(msg, { modal: true }, 'Разрешить', 'Отклонить');
      if (choice !== 'Разрешить') {
        throw new Error(`User denied ${action} file outside workspace`);
      }
    }
  } else {
    const msg = `Нет открытого рабочего каталога. Разрешить ${action} файла: ${resolved}?`;
    const choice = await vscode.window.showWarningMessage(msg, { modal: true }, 'Разрешить', 'Отклонить');
    if (choice !== 'Разрешить') {
      throw new Error(`User denied ${action} file without workspace root`);
    }
  }
}
