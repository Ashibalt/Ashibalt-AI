/**
 * Syntax Analyzer v2.0 — Tree-sitter Edition
 * 
 * Pure syntax analysis using tree-sitter — finds REAL syntax errors,
 * not cascade garbage from type checker.
 * 
 * Tree-sitter is an incremental parser that:
 * - Parses ONLY syntax, no type checking
 * - Shows ERROR nodes at exact error location
 * - Doesn't produce cascade errors from one missing bracket
 * 
 * Strategy:
 * - Auto-diagnostics (after edit_file): syntax only (tree-sitter / py_compile)
 * - Explicit diagnose() tool call: syntax + VS Code Language Server diagnostics
 * 
 * For Python: uses py_compile (more accurate than tree-sitter for Python).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../logger';

// Tree-sitter imports - loaded lazily
let Parser: any;
let treeSitterLoaded = false;

const languageCache: Record<string, any> = {};

const LANGUAGE_MAP: Record<string, { module: string, key?: string }> = {
  // TypeScript/JavaScript (tree-sitter-typescript parses both)
  '.ts': { module: 'tree-sitter-typescript', key: 'typescript' },
  '.mts': { module: 'tree-sitter-typescript', key: 'typescript' },
  '.cts': { module: 'tree-sitter-typescript', key: 'typescript' },
  '.tsx': { module: 'tree-sitter-typescript', key: 'tsx' },
  '.js': { module: 'tree-sitter-typescript', key: 'typescript' },
  '.mjs': { module: 'tree-sitter-typescript', key: 'typescript' },
  '.cjs': { module: 'tree-sitter-typescript', key: 'typescript' },
  '.jsx': { module: 'tree-sitter-typescript', key: 'tsx' },
  
  '.html': { module: 'tree-sitter-html' },
  '.htm': { module: 'tree-sitter-html' },
  '.css': { module: 'tree-sitter-css' },
  '.php': { module: 'tree-sitter-php', key: 'php' },
  
  '.py': { module: 'tree-sitter-python' },
  '.pyw': { module: 'tree-sitter-python' },
  
  '.sh': { module: 'tree-sitter-bash' },
  '.bash': { module: 'tree-sitter-bash' },
  '.zsh': { module: 'tree-sitter-bash' },
  
  '.rs': { module: 'tree-sitter-rust' },
  '.go': { module: 'tree-sitter-go' },
  '.c': { module: 'tree-sitter-c' },
  '.h': { module: 'tree-sitter-c' },
  '.cpp': { module: 'tree-sitter-cpp' },
  '.cc': { module: 'tree-sitter-cpp' },
  '.cxx': { module: 'tree-sitter-cpp' },
  '.hpp': { module: 'tree-sitter-cpp' },
  '.hxx': { module: 'tree-sitter-cpp' },
  
  '.java': { module: 'tree-sitter-java' },
  
  '.rb': { module: 'tree-sitter-ruby' },
  

  '.json': { module: 'tree-sitter-json' },
};

// Load tree-sitter core
async function loadTreeSitter(): Promise<boolean> {
  if (treeSitterLoaded) return true;
  
  try {
    Parser = require('tree-sitter');
    treeSitterLoaded = true;
    logger.log('[SYNTAX] Tree-sitter core loaded');
    return true;
  } catch (e) {
    logger.log(`[SYNTAX] Failed to load tree-sitter: ${e}`);
    return false;
  }
}

// Load language module for specific extension
// Uses require() first, falls back to dynamic import() for ESM modules (e.g. tree-sitter-css)
async function loadLanguage(ext: string): Promise<any | null> {
  const langInfo = LANGUAGE_MAP[ext];
  if (!langInfo) return null;
  
  const cacheKey = langInfo.module + (langInfo.key || '');
  if (languageCache[cacheKey]) {
    return languageCache[cacheKey];
  }
  
  // Try require() first (works for CJS modules)
  try {
    const mod = require(langInfo.module);
    const language = langInfo.key ? mod[langInfo.key] : mod;
    languageCache[cacheKey] = language;
    logger.log(`[SYNTAX] Loaded ${langInfo.module}${langInfo.key ? '.' + langInfo.key : ''}`);
    return language;
  } catch (requireErr: any) {
    // If it's an ESM module error, try dynamic import()
    if (requireErr?.code === 'ERR_REQUIRE_ESM' || requireErr?.code === 'ERR_REQUIRE_ASYNC_MODULE') {
      try {
        const mod = await import(langInfo.module);
        const language = langInfo.key ? (mod[langInfo.key] ?? mod.default?.[langInfo.key]) : (mod.default ?? mod);
        languageCache[cacheKey] = language;
        logger.log(`[SYNTAX] Loaded ${langInfo.module}${langInfo.key ? '.' + langInfo.key : ''} (via dynamic import)`);
        return language;
      } catch (importErr) {
        logger.log(`[SYNTAX] Failed to load ${langInfo.module} (both require and import failed): ${importErr}`);
        return null;
      }
    }
    logger.log(`[SYNTAX] Failed to load ${langInfo.module}: ${requireErr}`);
    return null;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface DiagnosticError {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  source: 'syntax' | 'semantic' | 'vscode';
  /** Quick fix suggestion if available from LSP */
  quickFix?: string;
}

export interface DiagnosticResult {
  errors: DiagnosticError[];
  context: string;
  fullFile?: string;
  totalLines: number;
  duration: number;
  checker: string;
  totalErrors?: number;
  /** True if only syntax was checked */
  syntaxOnly?: boolean;
}

export interface DiagnoseOptions {
  file: string;
  /** When true, only syntax errors are returned (tree-sitter / py_compile). When false, also includes VS Code diagnostics. */
  syntaxOnly?: boolean;
  includeFullFile?: boolean;
}

// ============================================================================
// Tree-sitter Syntax Analyzer
// ============================================================================

/**
 * Check if file extension is supported by tree-sitter
 */
function isSupported(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext in LANGUAGE_MAP;
}

/**
 * Analyze syntax using tree-sitter.
 * Tree-sitter parses ONLY syntax — no type checking, no cascade errors.
 * 
 * Strategy: Find ERROR nodes and report the FIRST one by position.
 * The first syntax error is usually the ROOT CAUSE.
 */
async function analyzeWithTreeSitter(content: string, filePath: string): Promise<DiagnosticError[]> {
  const loaded = await loadTreeSitter();
  if (!loaded) {
    logger.log('[SYNTAX] Tree-sitter not available, skipping syntax check');
    return [];
  }
  
  const ext = path.extname(filePath).toLowerCase();
  
  // Load language for this file type
  const language = await loadLanguage(ext);
  if (!language) {
    logger.log(`[SYNTAX] No tree-sitter parser for ${ext}`);
    return [];
  }
  
  try {
    const parser = new Parser();
    parser.setLanguage(language);
    
    // Parse the content
    const tree = parser.parse(content);
    const lines = content.split('\n');
    
    // Collect ALL error nodes with their START position
    const errorNodes: Array<{node: any, startByte: number}> = [];
    
    function collectErrors(node: any) {
      if (node.type === 'ERROR' || node.isMissing) {
        errorNodes.push({ node, startByte: node.startIndex });
      }
      for (let i = 0; i < node.childCount; i++) {
        collectErrors(node.child(i));
      }
    }
    
    collectErrors(tree.rootNode);
    
    if (errorNodes.length === 0) {
      logger.log('[SYNTAX] Tree-sitter: no syntax errors');
      return [];
    }
    
    // Sort by position in file - FIRST error is root cause
    errorNodes.sort((a, b) => a.startByte - b.startByte);
    
    // Take only the FIRST error (root cause) plus maybe 1-2 more if they're on different lines
    const errors: DiagnosticError[] = [];
    const seenLines = new Set<number>();
    
    for (const { node } of errorNodes) {
      const line = node.startPosition.row + 1;
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      
      const col = node.startPosition.column + 1;
      const lineContent = lines[node.startPosition.row] || '';
      
      // Generate helpful message based on context
      let message: string;
      
      if (node.isMissing) {
        message = `Missing: ${node.type}`;
      } else {
        // Look at what's on this line to give helpful message
        const trimmed = lineContent.trim();
        
        if (trimmed.match(/function\s+\w+\s*\([^)]*$/)) {
          // function foo( ... without closing )
          message = 'Missing closing parenthesis ) in function declaration';
        } else if (trimmed.match(/\(\s*{/) && !trimmed.includes(')')) {
          // "( {" pattern - common mistake
          message = 'Missing ) before { - check function parameters';
        } else if (trimmed.endsWith('(')) {
          message = 'Incomplete expression after (';
        } else if (trimmed.includes('function')) {
          message = 'Invalid function syntax - check parentheses and braces';
        } else if (trimmed.includes('=>')) {
          message = 'Invalid arrow function syntax';
        } else {
          // Generic message with context
          const errorStart = node.text?.slice(0, 30)?.split('\n')[0] || '';
          if (errorStart.length > 0 && errorStart.length < 25) {
            message = `Syntax error: unexpected "${errorStart}"`;
          } else {
            message = 'Syntax error - check for missing brackets or typos';
          }
        }
      }
      
      errors.push({
        line,
        column: col,
        message,
        severity: 'error',
        source: 'syntax'
      });
      
      // Show up to 5 syntax errors to help model fix all issues
      if (errors.length >= 5) break;
    }
    
    logger.log(`[SYNTAX] Tree-sitter: ${errors.length} errors (from ${errorNodes.length} ERROR nodes)`);
    return errors;
    
  } catch (e) {
    logger.log(`[SYNTAX] Tree-sitter parse error: ${e}`);
    return [];
  }
}

// ============================================================================
// Python Syntax Check (py_compile is more accurate than tree-sitter)
// ============================================================================

async function checkPythonSyntax(filePath: string): Promise<DiagnosticError[]> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  
  try {
    // Use execFile instead of exec to prevent command injection via filePath
    await execFileAsync('python', ['-m', 'py_compile', filePath], { timeout: 5000 });
    logger.log('[SYNTAX] Python py_compile: no errors');
    return [];
  } catch (e: any) {
    // Parse error message from stderr
    const stderr = e.stderr || e.message || '';
    logger.log(`[SYNTAX] Python py_compile error: ${stderr}`);
    
    // Error format: File "path", line N\n  ...\nSyntaxError: message
    // or: SyntaxError: ('message', ('file', line, col, text))
    const errors: DiagnosticError[] = [];
    
    // Try to parse line number from error
    const lineMatch = stderr.match(/line (\d+)/i);
    const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
    
    // Extract error message
    let message = 'Syntax error';
    const syntaxMatch = stderr.match(/SyntaxError:\s*(.+?)(?:\n|$)/);
    if (syntaxMatch) {
      message = syntaxMatch[1].trim();
    } else {
      // Try other error types
      const errorMatch = stderr.match(/(IndentationError|TabError):\s*(.+?)(?:\n|$)/);
      if (errorMatch) {
        message = `${errorMatch[1]}: ${errorMatch[2].trim()}`;
      }
    }
    
    errors.push({
      line,
      message,
      severity: 'error',
      source: 'syntax'
    });
    
    logger.log(`[SYNTAX] Python error at line ${line}: ${message}`);
    return errors;
  }
}

// ============================================================================
// VS Code Diagnostics (Semantic errors) with Quick Fixes
// ============================================================================

async function getVSCodeDiagnostics(filePath: string): Promise<DiagnosticError[]> {
  const uri = vscode.Uri.file(filePath);
  
  try {
    await vscode.workspace.openTextDocument(uri);
    // Wait for Language Server to process the file and produce diagnostics
    await new Promise(r => setTimeout(r, 500));
  } catch {
    // File might not be openable
  }
  
  const diagnostics = vscode.languages.getDiagnostics(uri);
  const results: DiagnosticError[] = [];
  
  for (const d of diagnostics) {
    if (d.severity !== vscode.DiagnosticSeverity.Error && 
        d.severity !== vscode.DiagnosticSeverity.Warning) {
      continue;
    }
    
    const error: DiagnosticError = {
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      endLine: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
      source: 'vscode'
    };
    
    // Try to get quick fix for this diagnostic
    try {
      const codeActions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        uri,
        d.range,
        vscode.CodeActionKind.QuickFix.value
      );
      
      if (codeActions && codeActions.length > 0) {
        const firstFix = codeActions[0];
        if (firstFix.title) {
          error.quickFix = firstFix.title;
        }
      }
    } catch (e) {
      // Code action provider might not be available
    }
    
    results.push(error);
  }
  
  return results;
}

// ============================================================================
// Context Extraction
// ============================================================================

function extractContext(lines: string[], errorLines: number[], radius: number = 5): string {
  if (errorLines.length === 0) return '';
  
  const parts: string[] = [];
  const processedErrors = new Set<number>();  // Track which error lines we've shown
  const sorted = [...new Set(errorLines)].sort((a, b) => a - b);
  
  for (const errorLine of sorted) {
    // Skip if we've already processed this exact error line
    if (processedErrors.has(errorLine)) continue;
    processedErrors.add(errorLine);
    
    const start = Math.max(1, errorLine - radius);
    const end = Math.min(lines.length, errorLine + radius);
    
    const contextLines: string[] = [];
    for (let i = start; i <= end; i++) {
      // Mark the error line with >>>
      const marker = i === errorLine ? '>>>' : '   ';
      contextLines.push(`${marker} L${i} | ${lines[i - 1]}`);
    }
    
    parts.push(contextLines.join('\n'));
  }
  
  return parts.join('\n\n---\n\n');
}

// ============================================================================
// Main Diagnose Function
// ============================================================================

const MAX_ERRORS = 5;

export async function diagnose(options: DiagnoseOptions): Promise<DiagnosticResult> {
  const startTime = Date.now();
  const { file, includeFullFile = false } = options;
  
  logger.log(`[DIAG] diagnose() file=${file}`);
  
  // Read file
  let content: string;
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch (e) {
    return {
      errors: [{ line: 1, message: `Cannot read file: ${file}`, severity: 'error', source: 'syntax' }],
      context: '',
      totalLines: 0,
      duration: Date.now() - startTime,
      checker: 'none'
    };
  }
  
  const lines = content.split('\n');
  const totalLines = lines.length;
  let allErrors: DiagnosticError[] = [];
  let checker = 'none';
  
  const ext = path.extname(file).toLowerCase();
  
  // =========================================================================
  // STEP 1: Syntax Analysis
  // For Python: use py_compile (more accurate than tree-sitter)
  // For others: use tree-sitter
  // =========================================================================
  let syntaxErrors: DiagnosticError[] = [];
  
  if (ext === '.py' || ext === '.pyw') {
    // Python: use real Python interpreter for syntax check
    syntaxErrors = await checkPythonSyntax(file);
    if (syntaxErrors.length > 0) {
      checker = 'py_compile';
    }
  } else {
    // Other languages: use tree-sitter
    syntaxErrors = await analyzeWithTreeSitter(content, file);
    if (syntaxErrors.length > 0) {
      checker = 'tree-sitter';
    }
  }
  
  if (syntaxErrors.length > 0) {
    // Syntax errors found — show ONLY syntax (they cause cascade semantic errors)
    allErrors = syntaxErrors;
    checker = checker === 'none' ? 'tree-sitter' : checker;
    logger.log(`[DIAG] Syntax errors found: ${syntaxErrors.length}, skipping semantic`);
  } else if (!options.syntaxOnly) {
    // =========================================================================
    // STEP 2: No syntax errors → get semantic errors from VS Code LSP
    // Only when called explicitly via diagnose() tool, NOT for auto-diagnostics
    // =========================================================================
    const vscodeErrors = await getVSCodeDiagnostics(file);
    if (vscodeErrors.length > 0) {
      allErrors = vscodeErrors;
      checker = 'vscode';
      logger.log(`[DIAG] VS Code found ${allErrors.length} errors`);
    }
  } else {
    logger.log(`[DIAG] No syntax errors found (syntax_only mode)`);
  }
  
  // Sort and limit
  const totalErrorCount = allErrors.length;
  allErrors.sort((a, b) => a.line - b.line);
  const errors = allErrors.slice(0, MAX_ERRORS);
  
  // Build context
  const errorLines = errors.map(e => e.line);
  const context = extractContext(lines, errorLines, 5);
  
  // Full file if small
  const fullFile = (includeFullFile || totalLines <= 100) ? content : undefined;
  
  const duration = Date.now() - startTime;
  logger.log(`[DIAG] Done in ${duration}ms, ${errors.length}/${totalErrorCount} errors, checker=${checker}`);
  
  return {
    errors,
    context,
    fullFile,
    totalLines,
    duration,
    checker,
    totalErrors: totalErrorCount
  };
}

// ============================================================================
// Format Result for Model
// ============================================================================

export function formatDiagnosticResult(result: DiagnosticResult): string {
  const parts: string[] = [];
  
  if (result.errors.length === 0) {
    parts.push(`✓ No errors found (${result.duration}ms)`);
    
    if (result.fullFile && result.totalLines <= 50) {
      parts.push('\nFile content:');
      parts.push('```');
      result.fullFile.split('\n').forEach((line, i) => {
        parts.push(`${i + 1}: ${line}`);
      });
      parts.push('```');
    }
  } else {
    const totalErrors = result.totalErrors || result.errors.length;
    
    const isSyntax = result.checker === 'tree-sitter' || result.checker === 'py_compile';
    
    if (isSyntax) {
      parts.push(` SYNTAX ERROR (must fix first):`);
      parts.push(`Found ${totalErrors} syntax error(s). Fix syntax before checking types.\n`);
    } else {
      parts.push(`Found ${totalErrors} error(s):\n`);
    }
    
    for (const error of result.errors) {
      const col = error.column ? `:${error.column}` : '';
      const type = error.source === 'syntax' ? '[syntax]' : '';
      parts.push(`• Line ${error.line}${col}: ${type} ${error.message}`);
      
      if (error.quickFix) {
        parts.push(`  💡 Quick fix: ${error.quickFix}`);
      }
    }
    
    if (result.context) {
      parts.push('\n--- Code context ---');
      parts.push(result.context);
    }
    
    if (isSyntax) {
      parts.push('\n💡 Fix the syntax error first. Other errors may be caused by this.');
    }
  }
  
  return parts.join('\n');
}

// ============================================================================
// Quick syntax check export
// ============================================================================

export async function checkSyntax(filePath: string): Promise<DiagnosticError[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return analyzeWithTreeSitter(content, filePath);
}
