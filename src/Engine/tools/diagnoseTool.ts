import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../../logger';
import { diagnose, formatDiagnosticResult } from '../diagnosticsEngine';

/**
 * Fast diagnostics tool — check file for errors.
 */
export async function diagnoseTool(args: any, workspaceRoot?: string): Promise<any> {
  if (!args?.file) {
    throw new Error('diagnose requires "file" parameter');
  }
  
  // Resolve path
  let filePath = args.file;
  if (!path.isAbsolute(filePath)) {
    if (workspaceRoot) {
      filePath = path.join(workspaceRoot, filePath);
    } else {
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        filePath = path.resolve(folders[0].uri.fsPath, filePath);
      }
    }
  }
  logger.log(`[DIAGNOSE] Resolved path: ${filePath}`);
  
  // Check file exists
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
  } catch {
    logger.log(`[DIAGNOSE] File not found: ${filePath}`);
    throw new Error(`File not found: ${filePath}`);
  }
  
  // syntaxOnly option: only check syntax errors (skip VS Code semantic diagnostics)
  // Default: false — explicit diagnose() returns both syntax + semantic
  const syntaxOnly = args.syntax_only === true;
  
  // Run diagnostics
  const result = await diagnose({ file: filePath, syntaxOnly });
  
  const totalErrors = result.totalErrors || result.errors.length;
  logger.log(`[DIAGNOSE] Result: ${result.errors.length}/${totalErrors} errors, checker: ${result.checker}, ${result.duration}ms`);
  
  // Return formatted result
  const formatted = formatDiagnosticResult(result);
  logger.log(`[DIAGNOSE] Output (${formatted.length} chars)`);
  
  return {
    success: true,
    formatted,
    errors_count: result.errors.length,
    total_errors: totalErrors,  // Total errors found (before limit)
    total_lines: result.totalLines,
    checker: result.checker,
    duration_ms: result.duration,
    errors: result.errors
  };
}
