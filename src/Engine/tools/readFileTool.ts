import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../../logger';
import { getContextCache, getFileTime } from '../SystemContext/contextCache';

/**
 * Read file tool — read content, search within file, or get file symbols.
 */
export async function readFileTool(args: any, workspaceRoot?: string) {
  if (!args || typeof args.file_path !== 'string') {
    throw new Error('read_file requires file_path string argument');
  }

  const rawPath = args.file_path;
  // Resolve relative to workspaceRoot when provided
  let resolved: string;
  if (path.isAbsolute(rawPath)) {
    resolved = rawPath;
  } else if (workspaceRoot) {
    resolved = path.resolve(workspaceRoot, rawPath);
  } else {
    // fallback to workspace folders first entry
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      resolved = path.resolve(folders[0].uri.fsPath, rawPath);
    } else {
      // last resort: treat as absolute
      resolved = rawPath;
    }
  }

  // SYMBOLS MODE: Return file structure without content
  if (args.symbols === true) {
    logger.log(`[read_file] SYMBOLS mode for ${rawPath}`);
    return await getFileSymbols(resolved, rawPath);
  }

  const cache = getContextCache();
  
  // Check cache first - if file hasn't changed, return cached content
  const cachedFile = cache.get(resolved);
  if (cachedFile !== undefined) {
    logger.log(`[read_file] Cache hit for ${rawPath}`);
    // Still record the read in FileTime (allows edit_file after cached read)
    const fileTime = getFileTime();
    fileTime.read(resolved);
    return processFileContent(cachedFile.content, resolved, args);
  }

  // If resolved path is outside workspace root, ask user for permission before reading
  const folders = vscode.workspace.workspaceFolders;
  const rootCandidate = workspaceRoot || (folders && folders.length > 0 ? folders[0].uri.fsPath : undefined);
  if (rootCandidate) {
    const rel = path.relative(rootCandidate, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel) && rel.indexOf('..') === 0) {
      // Ask user for explicit permission
      const msg = `Запрошенный файл находится вне рабочего каталога: ${resolved}. Разрешить чтение этого файла?`;
      const choice = await vscode.window.showWarningMessage(msg, { modal: true }, 'Разрешить', 'Отклонить');
      if (choice !== 'Разрешить') {
        throw new Error('User denied reading file outside workspace');
      }
    }
  } else {
    // No workspace root available — require explicit permission for any non-absolute-safe access
    const msg2 = `Нет открытого рабочего каталога. Разрешить чтение файла: ${resolved}?`;
    const choice2 = await vscode.window.showWarningMessage(msg2, { modal: true }, 'Разрешить', 'Отклонить');
    if (choice2 !== 'Разрешить') {
      throw new Error('User denied reading file without workspace root');
    }
  }

  const uri = vscode.Uri.file(resolved);

  // Validate file exists and is not a directory
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (e: any) {
    throw new Error(`Failed to stat file: ${e?.message || e}`);
  }
  if (stat.type !== vscode.FileType.File) {
    throw new Error('Path is not a file');
  }

  // Enforce max size (2MB) to avoid reading huge files
  const MAX_BYTES = 2 * 1024 * 1024; // 2MB
  if (typeof stat.size === 'number' && stat.size > MAX_BYTES) {
    throw new Error(`File too large to read (>${MAX_BYTES} bytes)`);
  }

  // Read file content
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  cache.set(resolved, text);

  // Record this read in FileTime tracker (allows edit_file/create_file after this)
  const fileTime = getFileTime();
  fileTime.read(resolved);
  
  return processFileContent(text, resolved, args);
}

/**
 * Process file content and return appropriate response based on args
 */
function processFileContent(text: string, resolved: string, args: any): any {
  const allLines = text.split(/\r?\n/);
  const total = allLines.length;

  // SEARCH MODE: If search parameter provided, return only matching lines with context
  if (args.search && typeof args.search === 'string') {
    const searchTerm = args.search.toLowerCase();
    logger.log(`[read_file] SEARCH mode: term="${searchTerm}", total_lines=${total}`);
    const contextRadius = 3;
    const matches: any[] = [];
    const covered = new Set<number>();
    
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].toLowerCase().includes(searchTerm) && !covered.has(i)) {
        const start = Math.max(0, i - contextRadius);
        const end = Math.min(allLines.length, i + contextRadius + 1);
        const contextLines: string[] = [];
        
        for (let j = start; j < end; j++) {
          covered.add(j);
          const marker = j === i ? '>>>' : '   ';
          // Format: ">>> L10 | code" - pipe separator to prevent model copying "10:" into patch
          contextLines.push(`${marker} L${j + 1} | ${allLines[j]}`);
        }
        
        matches.push({
          line: i + 1,
          context: contextLines.join('\n')
        });
        
        if (matches.length >= 20) break;
      }
    }
    
    logger.log(`[read_file] SEARCH done: found ${matches.length} matches`);
    
    return {
      file: resolved,
      search: args.search,
      total_lines: total,
      matches_found: matches.length,
      matches
    };
  }

  // NORMAL MODE: Read file or range
  const maxAllowed = 800;
  
  // Parse start_line and end_line - handle both numbers and strings
  const parseLineNumber = (val: any): number | undefined => {
    if (typeof val === 'number' && val > 0) return Math.floor(val);
    if (typeof val === 'string') {
      const num = parseInt(val, 10);
      if (!isNaN(num) && num > 0) return num;
    }
    return undefined;
  };
  
  const start = parseLineNumber(args.start_line) ?? 1;
  const endArg = parseLineNumber(args.end_line);
  
  let end = endArg;
  let clamped = false;
  if (end !== undefined) {
    if (end > total) {
      clamped = true;
      end = total; // Clamp to file length instead of error
    }
    if (end < start) {
      if (start > total) {
        logger.log(`[read_file] OUT OF RANGE: start=${start} > total=${total} for ${resolved}`);
        return {
          error: `start_line (${start}) is beyond end of file. File only has ${total} lines. Use start_line=1 and end_line=${total} to read the full file.`,
          total_lines: total,
          returned_lines: 0
        };
      }
      return { content: '', total_lines: total, returned_lines: 0, truncated: false };
    }
    const requestedCount = end - start + 1;
    if (requestedCount > maxAllowed) {
      end = start + maxAllowed - 1;
      logger.log(`[read_file] Range too large for ${resolved}: requested=${requestedCount}, capped=${maxAllowed}`);
    }
  } else {
    end = Math.min(total, start + maxAllowed - 1);
  }

  const slice = allLines.slice(start - 1, end);
  // Prefix each line with its line number for precise referencing.
  // Format: "N: content" — matches OpenCode's read output format.
  // The model must NOT include "N: " prefix in old_string when editing.
  const numberedLines = slice.map((line, i) => `${start + i}: ${line}`);
  const content = numberedLines.join('\n');
  const returned = slice.length;
  const truncated = returned < total && (end < total || returned >= maxAllowed || start > 1);

  logger.log(
    `[read_file] RANGE file=${resolved}, start=${start}, end=${end}, total=${total}, returned=${returned}, truncated=${truncated}${clamped ? ', clamped_end=true' : ''}`
  );

  const result: any = {
    file: resolved,
    content,
    total_lines: total,
    returned_lines: returned,
    start_line: start,
    end_line: end,
    truncated
  };
  
  // Notify model that end_line was clamped to file length
  if (clamped) {
    result.note = `end_line was adjusted to ${total} (file has ${total} lines)`;
  }
  
  return result;
}

// Helper to annotate code with diagnostics
// DISABLED: Annotations confuse models when they try to patch - they include the annotation in the patch
async function annotateWithDiagnostics(filePath: string, content: string, startLine: number): Promise<string> {
  // Simply return content as-is. Diagnostics should be fetched separately via diagnose() tool.
  return content;
}

/**
 * Get file structure (symbols) without reading full content.
 * Returns functions, classes, methods, imports with line numbers.
 * Useful for understanding file architecture before targeted reading.
 */
async function getFileSymbols(resolved: string, rawPath: string): Promise<any> {
  const uri = vscode.Uri.file(resolved);
  const fileName = path.basename(resolved);
  const ext = path.extname(resolved).toLowerCase();

  // Check file exists
  try {
    await vscode.workspace.fs.stat(uri);
  } catch (e) {
    return { error: `File not found: ${resolved}` };
  }

  // Get symbols from VS Code Language Server
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    uri
  );

  // Read file to extract imports (VS Code symbols don't always include imports)
  let imports: { line: number; text: string }[] = [];
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString('utf8');
    const lines = content.split(/\r?\n/);
    
    // Extract import statements based on file type
    const importPatterns: RegExp[] = [];
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      importPatterns.push(/^import\s+/);
      importPatterns.push(/^const\s+.*=\s*require\(/);
      importPatterns.push(/^export\s+.*from\s+/);
    } else if (['.py', '.pyw'].includes(ext)) {
      importPatterns.push(/^import\s+/);
      importPatterns.push(/^from\s+.*import\s+/);
    } else if (['.go'].includes(ext)) {
      importPatterns.push(/^import\s+/);
    } else if (['.rs'].includes(ext)) {
      importPatterns.push(/^use\s+/);
    } else if (['.java'].includes(ext)) {
      importPatterns.push(/^import\s+/);
    }
    
    for (let i = 0; i < Math.min(lines.length, 100); i++) { // Check first 100 lines for imports
      const line = lines[i].trim();
      if (importPatterns.some(p => p.test(line))) {
        imports.push({ line: i + 1, text: line.substring(0, 100) }); // Truncate long imports
      }
    }
  } catch (e) {
    // Ignore read errors for imports, we still have symbols
  }

  // Format symbols into a readable structure
  const formatSymbol = (s: vscode.DocumentSymbol, depth: number = 0): any => {
    const kindName = vscode.SymbolKind[s.kind];
    const result: any = {
      name: s.name,
      kind: kindName,
      line: s.range.start.line + 1,
      end_line: s.range.end.line + 1
    };
    
    // Include children (e.g., methods inside classes)
    if (s.children && s.children.length > 0) {
      result.children = s.children.map(c => formatSymbol(c, depth + 1));
    }
    
    return result;
  };

  // Categorize symbols
  const functions: any[] = [];
  const classes: any[] = [];
  const variables: any[] = [];
  const other: any[] = [];

  if (symbols && symbols.length > 0) {
    for (const s of symbols) {
      const formatted = formatSymbol(s);
      switch (s.kind) {
        case vscode.SymbolKind.Function:
        case vscode.SymbolKind.Method:
          functions.push(formatted);
          break;
        case vscode.SymbolKind.Class:
        case vscode.SymbolKind.Interface:
        case vscode.SymbolKind.Struct:
          classes.push(formatted);
          break;
        case vscode.SymbolKind.Variable:
        case vscode.SymbolKind.Constant:
          variables.push(formatted);
          break;
        default:
          other.push(formatted);
      }
    }
  }

  // Build summary
  const summary: string[] = [];
  if (imports.length > 0) summary.push(`${imports.length} imports`);
  if (classes.length > 0) summary.push(`${classes.length} classes`);
  if (functions.length > 0) summary.push(`${functions.length} functions`);
  if (variables.length > 0) summary.push(`${variables.length} variables`);

  return {
    file: fileName,
    path: rawPath,
    summary: summary.join(', ') || 'No symbols found',
    imports: imports.length > 0 ? imports : undefined,
    classes: classes.length > 0 ? classes : undefined,
    functions: functions.length > 0 ? functions : undefined,
    variables: variables.length > 0 ? variables : undefined,
    other: other.length > 0 ? other : undefined,
    hint: 'Use read_file to read the file content. You can read up to 800 lines at once — prefer reading large ranges instead of many small chunks.'
  };
}
