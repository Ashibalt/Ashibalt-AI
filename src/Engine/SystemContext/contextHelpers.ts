import { Uri, workspace, FileType } from 'vscode';
import { logger } from '../../logger';

export interface AttachedFile {
  path: string;
  name: string;
  icon?: string;
}

export async function buildAttachedFilesFromContext(contextFiles: Set<string>, contextAttachments: Map<string, { mime: string; dataUrl?: string; name?: string; size?: number }>, getIconForFile: (name: string) => string) : Promise<AttachedFile[]> {
  const files: AttachedFile[] = [];
  for (const filePath of Array.from(contextFiles)) {
    try {
      let displayName = String(filePath);
      if (String(filePath).startsWith('pasted:')) {
        const attach = contextAttachments.get(filePath);
        if (attach && attach.name) displayName = attach.name;
      } else {
        displayName = String(filePath).split(/[\\\/]/).pop() || filePath;
      }
      files.push({ path: filePath, name: displayName, icon: getIconForFile(displayName) });
    } catch (e) {
      logger.error('Failed to build attached file entry', e);
    }
  }
  return files;
}

export async function isFileAllowedForContext(fullPath: string, maxSize = 64 * 1024) {
  try {
    const stat = await workspace.fs.stat(Uri.file(fullPath));
    if (stat.type === FileType.Directory) return { ok: false, reason: 'directory' };
    if (stat.size > maxSize) return { ok: false, reason: 'size' };
    const content = await workspace.fs.readFile(Uri.file(fullPath));
    const isBinary = content.some(b => b === 0);
    return { ok: !isBinary, reason: isBinary ? 'binary' : null };
  } catch (e) {
    logger.error('isFileAllowedForContext failed', e);
    return { ok: false, reason: 'error' };
  }
}
