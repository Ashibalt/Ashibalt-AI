import * as vscode from 'vscode';
import * as path from 'path';
import { getSnapshotManager } from '../../Storage/snapshotManager';
import { applySnapshotDecorations } from '../../Storage/snapshotDecorations';
import { logger } from '../../logger';
import { getContextCache, getFileTime } from '../SystemContext/contextCache';
import { diagnose, formatDiagnosticResult } from '../diagnosticsEngine';
import { findStringWithStrategies, fixEscapeSequences } from '../stringMatcher';

// ============================================================================
// edit_file - Simple and reliable file editing
// ============================================================================

interface EditResult {
  line: number;       // Actual line where edit was applied
  old_text: string;
  new_text: string;
  success: boolean;
  error?: string;
}

export async function editFileTool(args: any, workspaceRoot?: string) {
  // Validate args
  if (!args || typeof args.file_path !== 'string') {
    return { success: false, error: 'edit_file requires file_path string' };
  }
  
  // Resolve file path
  const rawPath = args.file_path;
  let resolvedPath: string;
  if (path.isAbsolute(rawPath)) {
    resolvedPath = rawPath;
  } else if (workspaceRoot) {
    resolvedPath = path.resolve(workspaceRoot, rawPath);
  } else {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      resolvedPath = path.resolve(folders[0].uri.fsPath, rawPath);
    } else {
      resolvedPath = rawPath;
    }
  }
  
  const uri = vscode.Uri.file(resolvedPath);
  
  // Read existing file — edit_file only works on existing files
  let fileContent: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    fileContent = Buffer.from(bytes).toString('utf8');
  } catch (e: any) {
    return { 
      success: false, 
      error: `File not found: ${rawPath}. Use create_file to create new files.`,
      hint: `create_file({ "file_path": "${rawPath}", "content": "..." })`
    };
  }

  // FileTime check: model must read_file before editing
  const fileTime = getFileTime();
  const fileTimeError = fileTime.assert(resolvedPath);
  if (fileTimeError) {
    logger.log(`[edit_file] FileTime BLOCKED: ${rawPath} was not read first`);
    return {
      success: false,
      error: fileTimeError,
      hint: `Call read_file({ "file_path": "${rawPath}" }) first, then retry your edit.`
    };
  }
  
  const originalContent = fileContent;
  const startLineHint = typeof args.start_line === 'number' ? args.start_line : undefined;
  
  // PRIMARY: old_string/new_string format (with optional start_line hint)
  const oldStr = args.old_string ?? args.oldString;
  const newStr = args.new_string ?? args.newString;
  if (typeof oldStr === 'string' && typeof newStr === 'string') {
    return await applyReplaceString(resolvedPath, rawPath, originalContent, oldStr, newStr, uri, startLineHint);
  }
  
  // FALLBACK: line-range format (start_line, end_line, content)
  if (typeof args.start_line === 'number' && typeof args.end_line === 'number' && typeof args.content === 'string') {
    return await applyLineRangeEdit(resolvedPath, rawPath, originalContent, args.start_line, args.end_line, args.content, uri);
  }
  
  return { 
    success: false, 
    error: 'edit_file requires: file_path, old_string, new_string',
    hint: 'Use: edit_file({ file_path: "...", old_string: "text to find", new_string: "replacement text" })'
  };
}

/**
 * Apply line-range based edit
 * start_line and end_line are 1-based
 * If end_line < start_line, it's a pure insertion before start_line
 */
async function applyLineRangeEdit(
  resolvedPath: string,
  rawPath: string,
  originalContent: string,
  startLine: number,
  endLine: number,
  newContent: string,
  uri: vscode.Uri
): Promise<any> {
  const lines = originalContent.split(/\r?\n/);
  const totalLines = lines.length;
  
  // Validate line numbers
  if (startLine < 1) {
    return { success: false, error: `start_line must be >= 1, got ${startLine}` };
  }
  
  // Handle insertion mode (end_line < start_line means insert before start_line)
  const isInsertion = endLine < startLine;
  
  // Clamp end_line to file length for replacement (instead of error)
  let actualEndLine = endLine;
  if (!isInsertion) {
    if (startLine > totalLines) {
      return { 
        success: false, 
        error: `start_line ${startLine} exceeds file length (${totalLines} lines)`,
        hint: `File has ${totalLines} lines. Use start_line <= ${totalLines}`
      };
    }
    // Clamp end_line to total lines - don't error, just adjust
    if (endLine > totalLines) {
      actualEndLine = totalLines;
      logger.log(`[edit_file] end_line ${endLine} clamped to ${totalLines} (file length)`);
    }
  }
  
  // Calculate what we're replacing (for logging and snapshot)
  const startIdx = startLine - 1; // Convert to 0-based
  const endIdx = isInsertion ? startIdx : actualEndLine; // endLine is inclusive, but slice is exclusive
  
  const oldLines = isInsertion ? [] : lines.slice(startIdx, endIdx);
  const oldText = oldLines.join('\n');
  
  // Build new content - fix escape sequences from model
  const fixedContent = fixEscapeSequences(newContent);
  const newLines = fixedContent ? fixedContent.split('\n') : [];
  
  // Construct result
  const beforeLines = lines.slice(0, startIdx);
  const afterLines = isInsertion ? lines.slice(startIdx) : lines.slice(endIdx);
  const resultLines = [...beforeLines, ...newLines, ...afterLines];
  const resultContent = resultLines.join('\n');
  
  // Calculate stats
  const linesRemoved = oldLines.length;
  const linesAdded = newLines.length;

  // Guard against near-full-file rewrites via line-range mode on large files.
  // Only block extreme cases (>90%). FileTime prevents blind edits now.
  if (!isInsertion && totalLines > 100) {
    const removedRatio = linesRemoved / totalLines;
    const addedRatio = linesAdded / totalLines;
    if (removedRatio >= 0.9 || addedRatio >= 0.9) {
      logger.log(`[edit_file] BLOCKED broad line-range edit: file=${rawPath}, remove=${linesRemoved}/${totalLines}, add=${linesAdded}/${totalLines}, range=${startLine}-${endLine}`);
      return {
        success: false,
        error: `Line-range edit replaces ${linesRemoved}/${totalLines} lines — nearly the entire file. ` +
          `Split into smaller edit_file calls (20-80 lines each).`,
        hint: 'Read the file and apply targeted edit_file calls with old_string/new_string for specific regions.'
      };
    }
  }
  
  logger.log(`[edit_file] Line-range edit: lines ${startLine}-${endLine}, removing ${linesRemoved}, adding ${linesAdded}`);
  
  try {
    const stats = await writeFileAndNotify(resolvedPath, rawPath, originalContent, resultContent, uri, [{
      line: startLine,
      old_text: oldText,
      new_text: fixedContent,
      success: true
    }]);
    
    const result: any = {
      success: true,
      message: isInsertion 
        ? `Inserted ${linesAdded} line(s) at line ${startLine}`
        : `Replaced lines ${startLine}-${endLine} (${linesRemoved} lines) with ${linesAdded} line(s)`,
      file: resolvedPath,
      start_line: startLine,
      end_line: endLine,
      linesAdded,
      linesRemoved
    };
    
    // Include diagnostics if there are errors (critical feedback for agent!)
    if (stats.diagnostics?.has_errors) {
      result.diagnostics = stats.diagnostics;
      result.warning = `⚠️ Edit applied but ${stats.diagnostics.error_count} error(s) detected! Fix them before continuing.`;
    }
    
    return result;
  } catch (e: any) {
    return { success: false, error: `Failed to write file: ${e?.message || e}` };
  }
}

/**
 * Apply old_string/new_string edit with 7-strategy fuzzy matching
 */
async function applyReplaceString(
  resolvedPath: string, 
  rawPath: string, 
  originalContent: string, 
  oldString: string, 
  newString: string,
  uri: vscode.Uri,
  startLineHint?: number
): Promise<any> {
  
  logger.log(`[edit_file] old_string/new_string mode (${oldString.length}/${newString.length} chars), hint=${startLineHint ?? 'none'}`);
  
  // Soft limit: warn if old_string or new_string is excessively large
  // This wastes tokens and is fragile — small edits are more reliable
  const MAX_EDIT_LINES = 200; // Raised from 50 — FileTime prevents blind edits now
  const oldLines = oldString.split('\n').length;
  const newLines = newString.split('\n').length;
  const totalFileLines = originalContent.split('\n').length;

  // Guard against near-full-file replacement on large files.
  // Only block extreme cases (>90% of file).
  if (totalFileLines > 100) {
    const oldRatio = oldLines / totalFileLines;
    const newRatio = newLines / totalFileLines;
    if (oldRatio >= 0.9 || newRatio >= 0.9) {
      logger.log(`[edit_file] BLOCKED near-full rewrite: file=${rawPath}, old=${oldLines}/${totalFileLines}, new=${newLines}/${totalFileLines}`);
      return {
        success: false,
        error: `Edit replaces ${oldLines}/${totalFileLines} lines — this is nearly the entire file. ` +
          `Split into 2-4 smaller edit_file calls instead.`,
        hint: 'Read the file and make targeted edits of 20-80 lines each.'
      };
    }
  }

  if (oldLines > MAX_EDIT_LINES || newLines > MAX_EDIT_LINES) {
    logger.log(`[edit_file] WARN: large edit old=${oldLines} new=${newLines} (limit=${MAX_EDIT_LINES})`);
    // Just warn in logs, don't block. FileTime + tool descriptions handle the guidance.
  }

  // Handle empty file: if old_string is empty and file is empty (or whitespace-only),
  // write new_string as the full file content. This handles the common case where
  // a model tries to edit an empty file by providing old_string="" and new_string="content".
  if (oldString === '' && originalContent.trim() === '') {
    logger.log(`[edit_file] Empty file + empty old_string — writing new_string as full content`);
    try {
      const stats = await writeFileAndNotify(resolvedPath, rawPath, originalContent, newString, uri, [{
        line: 1,
        old_text: '',
        new_text: newString,
        success: true
      }]);
      
      const resultLines = newString.split('\n');
      const ctxEnd = Math.min(resultLines.length, 6);
      const contextLines = resultLines.slice(0, ctxEnd)
        .map((l, i) => `L${i + 1}: ${l}`)
        .join('\n');
      
      const result: any = {
        success: true,
        message: `File was empty — wrote ${resultLines.length} lines`,
        file: rawPath,
        line: 1,
        strategy: 'empty_file',
        linesAdded: resultLines.length,
        linesRemoved: 0,
        verification_context: contextLines
      };
      
      if (stats.diagnostics?.has_errors) {
        result.diagnostics = stats.diagnostics;
        result.warning = `⚠️ Edit applied but ${stats.diagnostics.error_count} error(s) detected!`;
      }
      
      return result;
    } catch (e: any) {
      return { success: false, error: `Failed to write file: ${e?.message || e}` };
    }
  }

  // Use multi-strategy matcher with optional line hint
  const matchResult = findStringWithStrategies(originalContent, oldString, newString, startLineHint);
  
  // Check if match failed
  if (!matchResult.found) {
    logger.log(`[edit_file] All 7 matching strategies failed`);
    return {
      success: false,
      error: matchResult.error,
      ...matchResult.details
    };
  }
  
  // Multiple matches — if we have a hint, we already picked the best one
  if (matchResult.matchCount > 1 && !startLineHint) {
    logger.log(`[edit_file] ${matchResult.matchCount} matches found, no hint to disambiguate`);
    return {
      success: false,
      error: `old_string matches ${matchResult.matchCount} locations. Add start_line hint or include more context to make it unique.`,
      hint: 'Either add more surrounding lines to old_string, or provide start_line to specify which occurrence.'
    };
  }
  
  logger.log(`[edit_file] Match found: strategy=${matchResult.strategy}, line=${matchResult.matchLine}, matches=${matchResult.matchCount}`);
  
  // Apply replacement using the matched text (NOT the original old_string — may differ due to fuzzy match)
  const newContent = matchResult.normalizedContent.replace(matchResult.matchedOld, matchResult.matchedNew);
  
  try {
    const stats = await writeFileAndNotify(resolvedPath, rawPath, originalContent, newContent, uri, [{
      line: matchResult.matchLine,
      old_text: matchResult.matchedOld,
      new_text: matchResult.matchedNew,
      success: true
    }]);
    
    // Build ±3 lines context around edited area for agent verification
    const newLines = newContent.split('\n');
    const editStartLine = matchResult.matchLine; // 1-based
    const editedLineCount = matchResult.matchedNew.split('\n').length;
    const ctxStart = Math.max(0, editStartLine - 1 - 3); // 0-based, 3 lines before
    const ctxEnd = Math.min(newLines.length, editStartLine - 1 + editedLineCount + 3);
    const contextLines = newLines.slice(ctxStart, ctxEnd)
      .map((l, i) => `L${ctxStart + i + 1}: ${l}`)
      .join('\n');
    
    const result: any = {
      success: true,
      message: `Edit applied at line ${matchResult.matchLine} (strategy: ${matchResult.strategy})`,
      file: rawPath,
      line: matchResult.matchLine,
      strategy: matchResult.strategy,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
      verification_context: contextLines
    };
    
    if (matchResult.matchCount > 1) {
      result.note = `${matchResult.matchCount} matches found, picked closest to hint line ${startLineHint}`;
    }
    
    // Include diagnostics if there are errors (critical feedback for agent!)
    if (stats.diagnostics?.has_errors) {
      result.diagnostics = stats.diagnostics;
      result.warning = `⚠️ Edit applied but ${stats.diagnostics.error_count} error(s) detected! Fix them before continuing.`;
    }
    
    return result;
  } catch (e: any) {
    return { success: false, error: `Failed to write file: ${e?.message || e}` };
  }
}

/**
 * Write file, create snapshot, invalidate cache, run diagnostics
 * Returns statistics about the edit (linesAdded, linesRemoved) + diagnostics
 */
async function writeFileAndNotify(
  resolvedPath: string,
  rawPath: string,
  originalContent: string,
  newContent: string,
  uri: vscode.Uri,
  editResults: EditResult[]
): Promise<{ linesAdded: number; linesRemoved: number; diagnostics?: any }> {
  // Write file
  const bytes = Buffer.from(newContent, 'utf8');
  await vscode.workspace.fs.writeFile(uri, bytes);
  
  // Create snapshot for undo
  const snapshotManager = getSnapshotManager();
  const successfulEdits = editResults.filter(e => e.success);
  
  // Calculate the actual changed region by comparing original and new content
  const originalLines = originalContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);
  
  // Find the actual start and end of changes by comparing lines
  let startLine = 1;
  let endLineOld = originalLines.length;
  let endLineNew = newLines.length;
  
  // Find first different line
  for (let i = 0; i < Math.min(originalLines.length, newLines.length); i++) {
    if (originalLines[i] !== newLines[i]) {
      startLine = i + 1; // 1-based
      break;
    }
  }
  
  // Find last different line (from end)
  let diffFromEnd = 0;
  for (let i = 0; i < Math.min(originalLines.length, newLines.length); i++) {
    const oldIdx = originalLines.length - 1 - i;
    const newIdx = newLines.length - 1 - i;
    if (oldIdx < startLine - 1 || newIdx < startLine - 1) break;
    if (originalLines[oldIdx] !== newLines[newIdx]) {
      break;
    }
    diffFromEnd = i + 1;
  }
  
  endLineOld = originalLines.length - diffFromEnd;
  endLineNew = newLines.length - diffFromEnd;
  
  // Extract changed regions
  const oldChangedLines = originalLines.slice(startLine - 1, endLineOld).join('\n');
  const newChangedLines = newLines.slice(startLine - 1, endLineNew).join('\n');
  
  // Calculate line statistics
  const oldLineCount = oldChangedLines.split('\n').length;
  const newLineCount = newChangedLines.split('\n').length;
  const linesAdded = Math.max(0, newLineCount - oldLineCount + (newLineCount > oldLineCount ? 0 : newChangedLines.length - oldChangedLines.length > 0 ? 1 : 0));
  const linesRemoved = Math.max(0, oldLineCount - newLineCount + (oldLineCount > newLineCount ? 0 : oldChangedLines.length - newChangedLines.length > 0 ? 1 : 0));
  
  // More accurate calculation based on actual line differences
  const actualLinesAdded = newChangedLines.split('\n').filter((line, i) => {
    const oldLine = oldChangedLines.split('\n')[i];
    return oldLine === undefined || line !== oldLine;
  }).length;
  const actualLinesRemoved = oldChangedLines.split('\n').filter((line, i) => {
    const newLine = newChangedLines.split('\n')[i];
    return newLine === undefined || line !== newLine;
  }).length;
  
  const snapshot = await snapshotManager.createSnapshot(
    resolvedPath,
    'edit_file',
    oldChangedLines,
    newChangedLines,
    startLine,
    endLineNew
  );
  
  // Invalidate cache
  const cache = getContextCache();
  cache.invalidate(resolvedPath);
  logger.log(`[edit_file] Invalidated cache for: ${resolvedPath}`);
  
  // Apply decorations
  if (snapshot) {
    applySnapshotDecorations(snapshot);
  }
  
  logger.log(`[edit_file] SUCCESS - Applied edit to ${rawPath}`);
  
  // AUTO-DIAGNOSE: Run diagnostics after edit to give immediate feedback
  let diagnosticsResult: any = undefined;
  try {
    // Small delay for Language Server to update
    await new Promise(resolve => setTimeout(resolve, 150));
    
    const diagResult = await diagnose({ file: resolvedPath, syntaxOnly: true });
    
    if (diagResult.errors.length > 0) {
      diagnosticsResult = {
        has_errors: true,
        error_count: diagResult.errors.length,
        checker: diagResult.checker,
        errors: diagResult.errors.map(e => ({
          line: e.line,
          message: e.message,
          severity: e.severity
        })),
        formatted: formatDiagnosticResult(diagResult)
      };
      logger.log(`[edit_file] AUTO-DIAGNOSE: Found ${diagResult.errors.length} error(s)`);
    } else {
      diagnosticsResult = {
        has_errors: false,
        message: 'No errors found after edit'
      };
      logger.log(`[edit_file] AUTO-DIAGNOSE: No errors`);
    }
  } catch (e) {
    logger.log(`[edit_file] AUTO-DIAGNOSE failed: ${e}`);
    // Don't fail the edit if diagnostics fail
  }
  
  // Return per-edit statistics (not cumulative)
  return {
    linesAdded: actualLinesAdded,
    linesRemoved: actualLinesRemoved,
    diagnostics: diagnosticsResult
  };
}
