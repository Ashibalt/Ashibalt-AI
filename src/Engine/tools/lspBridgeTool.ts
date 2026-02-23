import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../../logger';

// ============================================================================
// LSP Bridge Tool — IDE intelligence as agent capabilities
// Uses VS Code built-in LSP commands to give the agent access to:
//   - Go to definition
//   - Find all references
//   - Hover (type info / documentation)
//   - Document symbols
//   - Type definition
//   - Implementations
//   - Rename preview (dry-run)
// ============================================================================

const VALID_OPERATIONS = [
  'definitions', 'references', 'hover', 'symbols',
  'type_definition', 'implementations', 'rename_preview'
] as const;

type LspOperation = typeof VALID_OPERATIONS[number];

/**
 * Resolve file path relative to workspace
 */
function resolveFilePath(filePath: string, workspaceRoot?: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (workspaceRoot) return path.join(workspaceRoot, filePath);
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return path.resolve(folders[0].uri.fsPath, filePath);
  }
  return filePath;
}

/**
 * Open document and wait briefly for Language Server to activate.
 * Matches pattern from diagnosticsEngine.ts
 */
async function ensureDocumentLoaded(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  // Wait for LS to index/process the file (500ms avoids 0-result on first open)
  await new Promise(r => setTimeout(r, 500));
  return doc;
}

/**
 * Find the position of a symbol by name within a document.
 * Falls back to text search if DocumentSymbolProvider returns nothing.
 */
async function resolveSymbolPosition(
  uri: vscode.Uri,
  doc: vscode.TextDocument,
  symbolName: string
): Promise<vscode.Position | null> {
  // 1) Try DocumentSymbolProvider for precise location
  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider', uri
    );
    if (symbols && symbols.length > 0) {
      const found = findSymbolRecursive(symbols, symbolName);
      if (found) return found.selectionRange.start;
    }
  } catch { /* LS may not support symbols */ }

  // 2) Fallback: text search
  const text = doc.getText();
  const idx = text.indexOf(symbolName);
  if (idx >= 0) return doc.positionAt(idx);

  return null;
}

/**
 * Recursively search DocumentSymbol tree for a symbol by name
 */
function findSymbolRecursive(
  symbols: vscode.DocumentSymbol[],
  name: string
): vscode.DocumentSymbol | undefined {
  for (const sym of symbols) {
    if (sym.name === name) return sym;
    if (sym.children && sym.children.length > 0) {
      const found = findSymbolRecursive(sym.children, name);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Get the position to query LSP at.
 * Priority: line+character → symbol_name auto-resolve → error
 */
async function getPosition(
  uri: vscode.Uri,
  doc: vscode.TextDocument,
  args: any
): Promise<vscode.Position> {
  // line is 1-indexed from user, character is 0-indexed
  if (typeof args.line === 'number') {
    const line = Math.max(0, args.line - 1); // convert 1-indexed → 0-indexed
    const character = typeof args.character === 'number' ? args.character : 0;
    return new vscode.Position(line, character);
  }

  if (typeof args.symbol_name === 'string' && args.symbol_name.trim()) {
    const pos = await resolveSymbolPosition(uri, doc, args.symbol_name.trim());
    if (pos) return pos;
    throw new Error(`Symbol "${args.symbol_name}" not found in ${path.basename(doc.fileName)}. Use line+character for precise positioning, or check the symbol name.`);
  }

  throw new Error('Either "line" or "symbol_name" is required for this operation.');
}

/**
 * Format a vscode.Location to a readable string "path:line:col"
 */
function formatLocation(location: vscode.Location, workspaceRoot?: string): string {
  let filePath = location.uri.fsPath;
  if (workspaceRoot) {
    const rel = path.relative(workspaceRoot, filePath);
    if (!rel.startsWith('..')) filePath = rel.replace(/\\/g, '/');
  }
  const line = location.range.start.line + 1;
  const col = location.range.start.character + 1;
  return `${filePath}:${line}:${col}`;
}

/**
 * Format DocumentSymbol tree as indented text
 */
function formatSymbolTree(symbols: vscode.DocumentSymbol[], indent: number = 0): string {
  const lines: string[] = [];
  const pad = '  '.repeat(indent);
  for (const sym of symbols) {
    const kind = vscode.SymbolKind[sym.kind] || 'Unknown';
    const line = sym.selectionRange.start.line + 1;
    lines.push(`${pad}${kind} ${sym.name} (line ${line})`);
    if (sym.children && sym.children.length > 0) {
      lines.push(formatSymbolTree(sym.children, indent + 1));
    }
  }
  return lines.join('\n');
}

/**
 * Format hover contents to readable text
 */
function formatHoverContents(hover: vscode.Hover): string {
  const parts: string[] = [];
  for (const content of hover.contents) {
    if (typeof content === 'string') {
      parts.push(content);
    } else if (content instanceof vscode.MarkdownString) {
      parts.push(content.value);
    } else if ('language' in content && 'value' in content) {
      parts.push(`\`\`\`${content.language}\n${content.value}\n\`\`\``);
    }
  }
  return parts.join('\n\n');
}

// ============================================================================
// Individual LSP operations
// ============================================================================

async function lspDefinitions(
  uri: vscode.Uri, position: vscode.Position, workspaceRoot?: string
): Promise<{ results: string; count: number }> {
  const locations = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider', uri, position
  );

  if (!locations || locations.length === 0) {
    return { results: 'No definitions found.', count: 0 };
  }

  const lines = locations.map(loc => formatLocation(loc, workspaceRoot));
  return {
    results: lines.join('\n'),
    count: locations.length
  };
}

async function lspReferences(
  uri: vscode.Uri, position: vscode.Position, workspaceRoot?: string
): Promise<{ results: string; count: number }> {
  const locations = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeReferenceProvider', uri, position
  );

  if (!locations || locations.length === 0) {
    return { results: 'No references found.', count: 0 };
  }

  // Group by file for readability
  const byFile = new Map<string, { line: number; col: number }[]>();
  for (const loc of locations) {
    let filePath = loc.uri.fsPath;
    if (workspaceRoot) {
      const rel = path.relative(workspaceRoot, filePath);
      if (!rel.startsWith('..')) filePath = rel.replace(/\\/g, '/');
    }
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath)!.push({
      line: loc.range.start.line + 1,
      col: loc.range.start.character + 1
    });
  }

  const lines: string[] = [];
  for (const [file, locs] of byFile) {
    lines.push(`${file}:`);
    for (const l of locs) {
      lines.push(`  line ${l.line}, col ${l.col}`);
    }
  }

  return {
    results: lines.join('\n'),
    count: locations.length
  };
}

async function lspHover(
  uri: vscode.Uri, position: vscode.Position
): Promise<{ results: string; count: number }> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider', uri, position
  );

  if (!hovers || hovers.length === 0) {
    return { results: 'No hover information available.', count: 0 };
  }

  const parts = hovers.map(h => formatHoverContents(h)).filter(Boolean);
  return {
    results: parts.join('\n---\n'),
    count: hovers.length
  };
}

async function lspDocumentSymbols(
  uri: vscode.Uri
): Promise<{ results: string; count: number }> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider', uri
  );

  if (!symbols || symbols.length === 0) {
    return { results: 'No symbols found in document.', count: 0 };
  }

  // Count all symbols recursively
  function countSymbols(syms: vscode.DocumentSymbol[]): number {
    let total = syms.length;
    for (const s of syms) {
      if (s.children) total += countSymbols(s.children);
    }
    return total;
  }

  return {
    results: formatSymbolTree(symbols),
    count: countSymbols(symbols)
  };
}

async function lspTypeDefinition(
  uri: vscode.Uri, position: vscode.Position, workspaceRoot?: string
): Promise<{ results: string; count: number }> {
  const locations = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeTypeDefinitionProvider', uri, position
  );

  if (!locations || locations.length === 0) {
    return { results: 'No type definition found.', count: 0 };
  }

  const lines = locations.map(loc => formatLocation(loc, workspaceRoot));
  return {
    results: lines.join('\n'),
    count: locations.length
  };
}

async function lspImplementations(
  uri: vscode.Uri, position: vscode.Position, workspaceRoot?: string
): Promise<{ results: string; count: number }> {
  const locations = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeImplementationProvider', uri, position
  );

  if (!locations || locations.length === 0) {
    return { results: 'No implementations found.', count: 0 };
  }

  const lines = locations.map(loc => formatLocation(loc, workspaceRoot));
  return {
    results: lines.join('\n'),
    count: locations.length
  };
}

async function lspRenamePreview(
  uri: vscode.Uri, position: vscode.Position, newName: string, workspaceRoot?: string
): Promise<{ results: string; count: number }> {
  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    'vscode.executeDocumentRenameProvider', uri, position, newName
  );

  if (!edit) {
    return { results: 'Rename not available at this position.', count: 0 };
  }

  const entries = edit.entries();
  if (entries.length === 0) {
    return { results: 'No changes would be made.', count: 0 };
  }

  let totalEdits = 0;
  const lines: string[] = [];
  for (const [entryUri, edits] of entries) {
    let filePath = entryUri.fsPath;
    if (workspaceRoot) {
      const rel = path.relative(workspaceRoot, filePath);
      if (!rel.startsWith('..')) filePath = rel.replace(/\\/g, '/');
    }
    totalEdits += edits.length;
    lines.push(`${filePath}: ${edits.length} change(s)`);
    for (const e of edits) {
      lines.push(`  line ${e.range.start.line + 1}: "${e.newText}"`);
    }
  }

  lines.unshift(`Rename preview: ${totalEdits} edit(s) across ${entries.length} file(s)`);

  return {
    results: lines.join('\n'),
    count: totalEdits
  };
}

// ============================================================================
// Main entry point
// ============================================================================

export async function lspBridgeTool(args: any, workspaceRoot?: string): Promise<any> {
  const operation = args.operation as LspOperation;
  if (!operation || !VALID_OPERATIONS.includes(operation)) {
    return {
      error: `Invalid operation "${operation}". Valid: ${VALID_OPERATIONS.join(', ')}`,
      hint: 'Provide a valid operation parameter.'
    };
  }

  const filePath = resolveFilePath(args.file_path, workspaceRoot);
  logger.log(`[LSP] ${operation} on ${filePath}`);

  // Verify file exists
  const uri = vscode.Uri.file(filePath);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    return { error: `File not found: ${filePath}`, hint: 'Check the file path.' };
  }

  // Load document & wait for LS
  let doc: vscode.TextDocument;
  try {
    doc = await ensureDocumentLoaded(uri);
  } catch (e: any) {
    return { error: `Cannot open file: ${e.message}` };
  }

  const startTime = Date.now();

  try {
    let result: { results: string; count: number };

    if (operation === 'symbols') {
      // symbols doesn't need a position
      result = await lspDocumentSymbols(uri);
    } else {
      // All other operations need a position
      const position = await getPosition(uri, doc, args);

      switch (operation) {
        case 'definitions':
          result = await lspDefinitions(uri, position, workspaceRoot);
          break;
        case 'references':
          result = await lspReferences(uri, position, workspaceRoot);
          break;
        case 'hover':
          result = await lspHover(uri, position);
          break;
        case 'type_definition':
          result = await lspTypeDefinition(uri, position, workspaceRoot);
          break;
        case 'implementations':
          result = await lspImplementations(uri, position, workspaceRoot);
          break;
        case 'rename_preview':
          if (!args.new_name || typeof args.new_name !== 'string') {
            return { error: 'rename_preview requires "new_name" parameter.' };
          }
          result = await lspRenamePreview(uri, position, args.new_name, workspaceRoot);
          break;
        default:
          return { error: `Unknown operation: ${operation}` };
      }
    }

    const elapsed = Date.now() - startTime;

    // Retry once if LS returned 0 results — may be warming up still
    const canRetry = ['definitions', 'references', 'hover', 'type_definition', 'implementations', 'symbols'].includes(operation);
    if (result.count === 0 && canRetry) {
      logger.log(`[LSP] ${operation} returned 0 results, waiting 500ms and retrying once...`);
      await new Promise(r => setTimeout(r, 500));
      try {
        if (operation === 'symbols') {
          result = await lspDocumentSymbols(uri);
        } else {
          const position = await getPosition(uri, doc, args);
          switch (operation) {
            case 'definitions': result = await lspDefinitions(uri, position, workspaceRoot); break;
            case 'references': result = await lspReferences(uri, position, workspaceRoot); break;
            case 'hover': result = await lspHover(uri, position); break;
            case 'type_definition': result = await lspTypeDefinition(uri, position, workspaceRoot); break;
            case 'implementations': result = await lspImplementations(uri, position, workspaceRoot); break;
          }
        }
        logger.log(`[LSP] ${operation} retry result: ${result.count} results`);
      } catch { /* keep original 0-result response */ }
    }

    logger.log(`[LSP] ${operation} completed: ${result.count} results in ${elapsed}ms`);

    return {
      success: true,
      operation,
      file: args.file_path,
      results_count: result.count,
      results: result.results,
      duration_ms: elapsed
    };
  } catch (e: any) {
    const elapsed = Date.now() - startTime;
    logger.log(`[LSP] ${operation} error: ${e.message} (${elapsed}ms)`);
    return {
      error: e.message,
      operation,
      file: args.file_path,
      hint: operation === 'definitions' || operation === 'references' || operation === 'hover'
        ? 'Make sure a Language Server is active for this file type. Try opening the file in VS Code first.'
        : undefined
    };
  }
}
