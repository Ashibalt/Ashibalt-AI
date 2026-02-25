/**
 * xrayCodebaseTool.ts — Workspace-wide symbol map using LSP WorkspaceSymbolProvider.
 *
 * Returns a structured index of all functions, classes, interfaces, enums, methods,
 * constants, and variables across the entire project — grouped by file, sorted by line.
 * Optionally includes function/method signatures extracted from source lines.
 *
 * Usage in agent:
 *   xray_codebase()                            → full project symbol map with signatures
 *   xray_codebase({ query: "auth" })           → only symbols whose name contains "auth"
 *   xray_codebase({ kinds: ["function"] })     → filter by symbol kinds
 *   xray_codebase({ signatures: false })       → skip signatures for faster/smaller output
 */

import * as vscode from 'vscode';
import * as path from 'path';

// VS Code SymbolKind numeric values → human-readable names
const SYMBOL_KIND_NAMES: Record<number, string> = {
  0: 'file',
  1: 'module',
  2: 'namespace',
  3: 'package',
  4: 'class',
  5: 'method',
  6: 'property',
  7: 'field',
  8: 'constructor',
  9: 'enum',
  10: 'interface',
  11: 'function',
  12: 'variable',
  13: 'constant',
  14: 'string',
  15: 'number',
  16: 'boolean',
  17: 'array',
  18: 'object',
  19: 'key',
  20: 'null',
  21: 'enum_member',
  22: 'struct',
  23: 'event',
  24: 'operator',
  25: 'type_parameter',
};

// Interesting kinds — includes variables and constants now
const IMPORTANT_KINDS = new Set([
  4,   // class
  5,   // method
  8,   // constructor
  9,   // enum
  10,  // interface
  11,  // function
  12,  // variable
  13,  // constant
  1,   // module
  2,   // namespace
  22,  // struct
  25,  // type_parameter
  21,  // enum_member
  6,   // property
]);

// Kinds that benefit from signature extraction
const SIGNATURE_KINDS = new Set([4, 5, 8, 10, 11, 12, 13]);

export interface XraySymbol {
  name: string;
  kind: string;
  file: string;    // workspace-relative path
  line: number;    // 1-based
  signature?: string; // extracted from source line
}

/**
 * Extract a clean signature from a source line for a given symbol.
 * Returns the signature portion (params, return type, extends, etc.) or undefined.
 */
function extractSignature(lineText: string, symbolName: string, kindNum: number): string | undefined {
  if (!lineText) return undefined;
  const trimmed = lineText.trim();
  if (!trimmed) return undefined;

  // For functions/methods/constructors: extract "name(params): returnType" or "def name(params) -> type"
  if (kindNum === 11 || kindNum === 5 || kindNum === 8) {
    // TypeScript/JS: function name(params): Type / method(params): Type
    const tsMatch = trimmed.match(new RegExp(`(?:(?:export\\s+)?(?:async\\s+)?(?:function\\s+)?)?${escapeRegex(symbolName)}\\s*(\\([^)]*\\))\\s*(?::\\s*([^{;]+))?`));
    if (tsMatch) {
      const params = tsMatch[1] || '';
      const ret = tsMatch[2]?.trim().replace(/\s*\{?\s*$/, '') || '';
      return ret ? `${symbolName}${params}: ${ret}` : `${symbolName}${params}`;
    }
    // Python: def name(params) -> type:
    const pyMatch = trimmed.match(new RegExp(`def\\s+${escapeRegex(symbolName)}\\s*(\\([^)]*\\))\\s*(?:->\\s*([^:]+))?`));
    if (pyMatch) {
      const params = pyMatch[1] || '';
      const ret = pyMatch[2]?.trim() || '';
      return ret ? `${symbolName}${params} -> ${ret}` : `${symbolName}${params}`;
    }
    return undefined;
  }

  // For classes/interfaces: "class Name extends Base implements I" or "class Name(Base):"
  if (kindNum === 4 || kindNum === 10) {
    // TS/JS
    const tsMatch = trimmed.match(new RegExp(`(?:export\\s+)?(?:abstract\\s+)?(?:class|interface)\\s+${escapeRegex(symbolName)}(?:<[^>]+>)?\\s*(extends\\s+[^{]+?)?(?:\\s*implements\\s+([^{]+?))?\\s*\\{?\\s*$`));
    if (tsMatch) {
      const ext = tsMatch[1]?.trim() || '';
      const impl = tsMatch[2]?.trim() || '';
      const parts = [ext, impl ? `implements ${impl}` : ''].filter(Boolean).join(' ');
      return parts ? `${symbolName} ${parts}` : undefined;
    }
    // Python
    const pyMatch = trimmed.match(new RegExp(`class\\s+${escapeRegex(symbolName)}\\s*(\\([^)]+\\))?\\s*:`));
    if (pyMatch && pyMatch[1]) {
      return `${symbolName}${pyMatch[1]}`;
    }
    return undefined;
  }

  // For variables/constants: "const NAME: Type = ..." or "NAME = value"
  if (kindNum === 12 || kindNum === 13) {
    // TS/JS: const/let/var name: Type = ...
    const tsMatch = trimmed.match(new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(symbolName)}\\s*(?::\\s*([^=;]+?))?\\s*(?:=|;|$)`));
    if (tsMatch && tsMatch[1]) {
      return `${symbolName}: ${tsMatch[1].trim()}`;
    }
    // Python: no built-in type annotations detection needed — just name
    return undefined;
  }

  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function xrayCodebaseTool(args: any, workspaceRoot?: string): Promise<any> {
  const query: string = (args?.query ?? '').trim();
  const filterKinds: string[] | undefined = args?.kinds;
  const limitFiles: number = Math.min(args?.max_files ?? 500, 1000);
  const wantSignatures: boolean = args?.signatures !== false; // default true
  const MAX_SIGNATURE_FILES = 200; // don't open too many files

  try {
    const rawSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      query || ''
    );

    if (!rawSymbols || rawSymbols.length === 0) {
      return {
        success: true,
        total: 0,
        files: 0,
        symbols: [],
        text: '(No symbols found. Make sure the language server is running and the project is open.)'
      };
    }

    // Filter to important kinds only, unless explicit kinds filter provided
    const filteredSymbols = rawSymbols.filter(sym => {
      const kindNum: number = sym.kind as unknown as number;
      if (filterKinds && filterKinds.length > 0) {
        const kindName = (SYMBOL_KIND_NAMES[kindNum] ?? '').toLowerCase();
        return filterKinds.some(k => k.toLowerCase() === kindName);
      }
      return IMPORTANT_KINDS.has(kindNum);
    });

    // Group by file URI
    const ws = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const byUri = new Map<string, { relativePath: string; uri: vscode.Uri; symbols: { sym: vscode.SymbolInformation; kindNum: number }[] }>();

    for (const sym of filteredSymbols) {
      const uriKey = sym.location.uri.toString();
      if (!byUri.has(uriKey)) {
        const fsPath = sym.location.uri.fsPath;
        const relativePath = ws
          ? path.relative(ws, fsPath).replace(/\\/g, '/')
          : fsPath.replace(/\\/g, '/');
        byUri.set(uriKey, { relativePath, uri: sym.location.uri, symbols: [] });
      }
      byUri.get(uriKey)!.symbols.push({ sym, kindNum: sym.kind as unknown as number });
    }

    // Sort files alphabetically
    const sortedEntries = Array.from(byUri.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const cappedEntries = sortedEntries.slice(0, limitFiles);
    const wasCapped = sortedEntries.length > limitFiles;

    // If signatures requested, open documents in batches
    const docCache = new Map<string, vscode.TextDocument>();
    if (wantSignatures) {
      const toOpen = cappedEntries.slice(0, MAX_SIGNATURE_FILES);
      // Open in parallel batches of 20
      for (let i = 0; i < toOpen.length; i += 20) {
        const batch = toOpen.slice(i, i + 20);
        const docs = await Promise.all(
          batch.map(e => vscode.workspace.openTextDocument(e.uri).then(d => d, () => null))
        );
        for (let j = 0; j < batch.length; j++) {
          if (docs[j]) docCache.set(batch[j].uri.toString(), docs[j]!);
        }
      }
    }

    // Build output
    const lines: string[] = [];
    let totalSymbols = 0;

    for (const entry of cappedEntries) {
      const syms = entry.symbols.sort((a, b) =>
        ((a.sym.location.range?.start?.line ?? 0)) - ((b.sym.location.range?.start?.line ?? 0))
      );
      totalSymbols += syms.length;
      lines.push(`### ${entry.relativePath}`);

      const doc = docCache.get(entry.uri.toString());

      for (const { sym, kindNum } of syms) {
        const lineNum = (sym.location.range?.start?.line ?? 0) + 1;
        const kindStr = SYMBOL_KIND_NAMES[kindNum] ?? `kind_${kindNum}`;

        let display = sym.name;
        if (wantSignatures && doc && SIGNATURE_KINDS.has(kindNum)) {
          const sourceLine = lineNum > 0 && lineNum <= doc.lineCount
            ? doc.lineAt(lineNum - 1).text
            : '';
          const sig = extractSignature(sourceLine, sym.name, kindNum);
          if (sig) display = sig;
        }

        lines.push(`  L${lineNum}  [${kindStr}]  ${display}`);
      }
      lines.push('');
    }

    if (wasCapped) {
      lines.push(`... (truncated to ${limitFiles} files out of ${sortedEntries.length} total)`);
    }

    return {
      success: true,
      query: query || '(all)',
      total: totalSymbols,
      files: cappedEntries.length,
      total_files_available: sortedEntries.length,
      signatures: wantSignatures,
      text: lines.join('\n')
    };

  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
      hint: 'Make sure a language server extension is installed for your project language (e.g. TypeScript, Pylance, etc.).'
    };
  }
}
